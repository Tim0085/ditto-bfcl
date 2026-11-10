import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createServer, request } from 'node:http';
import { startEgress } from '../src/ts/egress/server.ts';
import { loadEgressConfig, validateConfig } from '../src/ts/egress/config.ts';
import { MODEL_ENDPOINT_PROTOCOL } from '../src/ts/model-endpoint.ts';
import { Ledger } from '../src/ts/egress/ledger.ts';
import { mockResponse } from '../src/ts/egress/mock.ts';
import { liveBackend } from '../src/ts/egress/backends/live.ts';
import { retryDelayMs } from '../src/ts/egress/retry.ts';
import { ModelTransportError } from '../src/ts/egress/model.ts';
export async function config(){return loadEgressConfig('config/egress.offline.json','live');}
export async function output(){const root=process.env.T5_TEST_OUTPUT;if(!root)return mkdtemp(join(tmpdir(),'ditto-t5-tests-case-'));await mkdir(root,{recursive:true});return mkdtemp(join(root,'case-'));}
export function call(taskId='task',text='hello'){
  const identity={configId:'test-c1',taskId,caseId:'web_search_no_snippet_0',turn:1,step:1};
  return {protocol:MODEL_ENDPOINT_PROTOCOL,...identity,input:{metadata:identity,model:{model:'deepseek-flash'},messages:[{role:'user',content:text}],actions:[]}};
}
export function post(url:string,body:any):Promise<any>{return new Promise((yes,no)=>{
  const req=request(url,{method:'POST',headers:{'content-type':'application/json'}},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>{try{yes(JSON.parse(text));}catch(e){no(e);}});res.on('error',no);});
  req.on('error',no);req.end(JSON.stringify(body));
});}
function raw(){return mockResponse({message:{role:'assistant',content:'done'},finishReason:'stop'},'deepseek-flash','chat-completions',0);}
async function fake(handler:(req:any,res:any,n:number)=>void){let count=0;const server=createServer((req,res)=>{req.resume();handler(req,res,++count);});
  await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));return {url:`http://127.0.0.1:${(server.address() as any).port}`,count:()=>count,close:()=>new Promise<void>(r=>server.close(()=>r()))};}
const send=(res:any,value=raw())=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(value));};
function virtualClock(){let now=1800000000000;const sleeps:number[]=[];return {now:()=>now,monotonicNow:()=>now,sleep:async(ms:number)=>{sleeps.push(ms);now+=ms;},sleeps};}
async function events(path:string){return (await readFile(path,'utf8')).trim().split('\n').map(x=>JSON.parse(x));}

test.skip('source parity: buildRequest and parseResponse exactly match legacy text',async()=>{
  const a=await readFile('../../bfcl_direct/src/ts/model.ts','utf8'),b=await readFile('src/ts/egress/model.ts','utf8');
  const functions=(s:string)=>s.slice(s.indexOf('export function buildRequest')).replaceAll('\r\n','\n');
  assert.equal(functions(a),functions(b));
  console.log('buildRequest/parseUsage/checkReturnedModel/parseResponse: zero line differences');
});
test('default 600 seconds, explicit live guard and invalid settings',async()=>{
  const c=await config();assert.equal(c.settings.model.timeoutMs,600000);
  assert.throws(()=>liveBackend(c.settings),/--live/);
  assert.throws(()=>liveBackend(c.settings,{testUrl:'http://example.invalid'}),/127.0.0.1/);
  c.retryPolicy.maxRetries=3;assert.throws(()=>validateConfig(c),/2次/);
});
test('HTTP contract: new usage/receipt/timing, limits and config identity',async()=>{
  const c=await config();c.perTaskRequests=1;c.retryPolicy.maxRetries=0;
  const remote=await fake((_q,r)=>send(r)),dir=await output(),s=await startEgress(c,dir,{testUrl:remote.url});
  try{
    const first=await post(s.url,call());assert.equal(first.ok,true);assert.equal(first.output.usage.totalTokens,1320);
    const meta=first.output.message.metadata;assert(s.gateway.ledger.settlements.has(meta.budgetReceipt.id));assert(meta.modelTiming.apiMs>=0);
    const captured=JSON.parse(await readFile(join(dir,'model-records',meta.budgetReceipt.id+'.json'),'utf8'));assert.equal(captured.configId,'test-c1');
    const limit=await post(s.url,call());assert.deepEqual(limit.error.details,{failedModelAttempts:[],physicalModelRequests:1});assert.equal(limit.error.kind,'request_limit');
    const big=await post(s.url,call('big','x'.repeat(1887436)));assert.equal(big.error.kind,'input_limit');assert(big.error.details.inputBytes>1887436);assert.equal(big.error.details.maxRequestBytes,1887436);
    assert.equal(remote.count(),1);
    const wrong=call('wrong');wrong.input.metadata.configId='different';assert.equal((await post(s.url,wrong)).error.kind,'run_stop');
    assert.equal((await post(s.url,call('later'))).error.kind,'run_stop');assert.equal(remote.count(),1);
    for(const file of ['ledger.jsonl','rate.jsonl','calls.jsonl'])assert((await events(join(dir,file))).every(e=>typeof e.configId==='string'));
  }finally{await s.close();await remote.close();}
});
for(const fault of [429,408,500,502,503,504,'reset','timeout'] as const)test(`bounded retry ${fault}, cooldown and retained unknown cost`,async()=>{
  const c=await config();if(fault==='timeout')c.settings.model.timeoutMs=30;
  const clock=virtualClock(),remote=await fake((_q,res,n)=>{
    if(n===3)return send(res);
    if(fault==='reset')res.destroy();else if(fault==='timeout')setTimeout(()=>res.destroy(),100);else{res.writeHead(fault,{'retry-after':'31'});res.end('{}');}
  });
  const dir=await output(),s=await startEgress(c,dir,{testUrl:remote.url,clock});
  try{const result=await post(s.url,call());assert.equal(result.ok,true,JSON.stringify(result));assert.equal(remote.count(),3);
    const snap=s.gateway.ledger.snapshot();assert.equal(snap.retainedRequests,2);assert(snap.retainedMicroUsd>0);assert.equal(snap.settled,1);
    assert.equal(result.output.message.metadata.failedModelAttempts.length,2);
    const cooldowns=await events(join(dir,'rate.cooldowns.jsonl'));assert.deepEqual(cooldowns.map(e=>e.delayMs),[typeof fault==='number'?31000:30000,60000]);
    assert(clock.sleeps.reduce((a,b)=>a+b,0)>=90000);
    const rows=await events(join(dir,'ledger.jsonl'));assert.equal(rows.filter(e=>e.kind==='retain_failed').length,2);
    assert(rows.every(e=>typeof e.configId==='string'));
  }finally{await s.close();await remote.close();}
});
test('retry exhaustion stops all subsequent requests; per-task retries count',async()=>{
  for(const cap of [100,2]){
    const c=await config();c.perTaskRequests=cap;
    const remote=await fake((_q,r)=>{r.writeHead(503);r.end('{}');}),s=await startEgress(c,await output(),{testUrl:remote.url,clock:virtualClock()});
    try{const result=await post(s.url,call());assert.equal(result.error.kind,cap===2?'request_limit':'run_stop');assert.equal(remote.count(),cap===2?2:3);
      assert.equal(s.gateway.ledger.snapshot().retainedRequests,remote.count());
      if(cap===100){await post(s.url,call('next'));assert.equal(remote.count(),3);}else assert.equal(result.error.details.physicalModelRequests,2);
    }finally{await s.close();await remote.close();}
  }
});
test('insufficient budget sends zero requests; unknown usage retains pending reservation',async()=>{
  for(const scenario of ['budget','usage','identity','nonretryable']){
    const c=await config();if(scenario==='budget')c.settings.budget.referenceUsd=0.000001;
    const remote=await fake((_q,r)=>{const value:any=raw();if(scenario==='usage')delete value.usage;if(scenario==='identity')value.model='wrong';
      if(scenario==='nonretryable'){r.writeHead(400);r.end('{}');}else send(r,value);});
    const s=await startEgress(c,await output(),{testUrl:remote.url,clock:virtualClock()});
    try{assert.equal((await post(s.url,call())).error.kind,'run_stop');await post(s.url,call('next'));
      assert.equal(remote.count(),scenario==='budget'?0:1);
      if(scenario==='usage'||scenario==='nonretryable'){assert(s.gateway.ledger.snapshot().reservedMicroUsd>0);assert.equal(s.gateway.ledger.snapshot().blocked,true);}
    }finally{await s.close();await remote.close();}
  }
});
test('model output failure is a settled single-task error, not a run stop',async()=>{
  const remote=await fake((_q,r)=>{const value:any=raw();value.choices[0].finish_reason='content_filter';send(r,value);}),c=await config(),s=await startEgress(c,await output(),{testUrl:remote.url});
  try{const result=await post(s.url,call());assert.equal(result.ok,true);assert.equal(result.output.finishReason,'error');assert.deepEqual(result.output.message.metadata.bfclTaskFailure,{reason:'model_output',code:'content_filter'});assert.equal(s.gateway.stopped,false);assert.equal(s.gateway.ledger.snapshot().settled,1);}
  finally{await s.close();await remote.close();}
});
test('legacy ledger reader accepts additive configId fields and retains unknown fees on restart',async()=>{
  const c=await config(),dir=await output(),path=join(dir,'ledger.jsonl');const l=await new Ledger(path,c.settings,'offline-reference','hash',81).open();
  const id=await l.reserve('t',32768,{configId:'c',caseId:'case'});await l.retainFailedRequest(id,{reason:'transport_unknown'});
  const sibling='../../bfcl_direct/src/ts/ledger.ts';
  const fixture=existsSync(sibling)?sibling:'../../../../../bfcl_direct/src/ts/ledger.ts';
  const legacy=await import(pathToFileURL(resolve(process.env.WB_LEGACY_LEDGER??fixture)).href);
  const reopened=await new legacy.Ledger(path,c.settings,'offline-reference','hash').open();assert.equal(reopened.snapshot().retainedMicroUsd,l.snapshot().retainedMicroUsd);
  assert.equal(retryDelayMs(new ModelTransportError('x','http',undefined,429,{retryAfterMs:120000}),0),120000);
});
test('budget temporarily occupied waits for settlement before the next HTTP starts',async()=>{
  const c=await config();c.settings.budget.referenceUsd=0.1;
  let release!:()=>void,started!:()=>void;const ready=new Promise<void>(r=>started=r);
  const remote=await fake((_q,r,n)=>{if(n===1){release=()=>send(r);started();}else send(r);});
  const s=await startEgress(c,await output(),{testUrl:remote.url});
  try{const first=post(s.url,call('first'));await ready;const second=post(s.url,call('second'));
    await new Promise(r=>setTimeout(r,60));assert.equal(remote.count(),1);assert.equal(s.gateway.ledger.snapshot().requests,1);release();
    const [a,b]=await Promise.all([first,second]);assert(a.ok&&b.ok);assert(b.output.message.metadata.modelTiming.budgetWaitMs>0);assert.equal(remote.count(),2);
  }finally{await s.close();await remote.close();}
});
test('real wall clock obeys the legacy 30-second initial cooldown',async()=>{
  const starts:number[]=[];const remote=await fake((_q,r,n)=>{starts.push(performance.now());if(n===1){r.writeHead(429,{'retry-after':'0.01'});r.end('{}');}else send(r);});
  const s=await startEgress(await config(),await output(),{testUrl:remote.url});
  try{assert.equal((await post(s.url,call())).ok,true);assert(starts[1]-starts[0]>=30000);console.log(JSON.stringify({realCooldownMs:starts[1]-starts[0],minimumMs:30000}));}
  finally{await s.close();await remote.close();}
});
test('empty 204 response stops safely with unknown fee held',async()=>{
  const remote=await fake((_q,r)=>{r.writeHead(204);r.end();}),s=await startEgress(await config(),await output(),{testUrl:remote.url});
  try{assert.equal((await post(s.url,call())).error.kind,'run_stop');assert.equal(remote.count(),1);assert(s.gateway.ledger.snapshot().reservedMicroUsd>0);}
  finally{await s.close();await remote.close();}
});
test('client cancellation interrupts a queued admission immediately; invalid aggregate timeout fails at startup',async()=>{
  const c=await config();c.dispatchPolicy.maxInFlight=1;
  let release!:()=>void,started!:()=>void;const ready=new Promise<void>(r=>started=r);
  const remote=await fake((_q,r)=>{release=()=>send(r);started();});const s=await startEgress(c,await output(),{testUrl:remote.url});
  try{const first=post(s.url,call('first'));await ready;const abort=new AbortController();
    const queued=s.gateway.invoke(call('queued').input as any,abort.signal);const checked=assert.rejects(queued,/停止/);
    abort.abort();await Promise.race([checked,new Promise((_,reject)=>setTimeout(()=>reject(new Error('cancel did not wake queue')),200))]);
    assert.equal(s.gateway.stopped,true);assert.equal(remote.count(),1);release();await first;
  }finally{await s.close();await remote.close();}
  const invalid=await config();invalid.settings.model.timeoutMs=2147483647;assert.throws(()=>validateConfig(invalid),/超时/);
});
// 此处只验并发正确性，打印吞吐供参考；>=3000 RPM下限由scripts/egress-throughput.ts独立验收。
test('81 simultaneous HTTP calls overlap; throughput is informational only (separate acceptance has threshold)',async()=>{
  const pending:any[]=[];let active=0,peak=0;
  const remote=await fake((_q,res)=>{active++;peak=Math.max(peak,active);pending.push(res);if(pending.length===81)for(const r of pending){send(r);active--;}});
  const c=await config(),s=await startEgress(c,await output(),{testUrl:remote.url});
  try{const start=performance.now();const result=await Promise.all(Array.from({length:81},(_,i)=>post(s.url,call(`parallel-${i}`))));
    const elapsed=performance.now()-start;assert(result.every(x=>x.ok));assert.equal(peak,81);assert.equal(s.gateway.peak,81);
    console.log(JSON.stringify({requests:81,peak,elapsedMs:elapsed,requestsPerMinute:81*60000/elapsed,configuredRpm:c.dispatchPolicy.requestsPerMinute}));
  }finally{await s.close();await remote.close();}
});
