import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { request } from 'node:http';
import { startEgress } from '../src/ts/egress/server.ts';
import { loadEgressConfig } from '../src/ts/egress/config.ts';
import { buildRequest, modelSystem } from '../src/ts/egress/model.ts';
import { loadTask, loadActions, questionForTurn } from '../src/ts/egress/model_config.ts';
import { mockResponse } from '../src/ts/egress/mock.ts';
import { MODEL_ENDPOINT_PROTOCOL } from '../src/ts/model-endpoint.ts';
async function dir(){const root=process.env.T5_TEST_OUTPUT;if(!root)return mkdtemp(join(tmpdir(),'ditto-t5-tests-replay-'));await mkdir(root,{recursive:true});return mkdtemp(join(root,'replay-'));}
const replayIndex=()=>process.env.T5_REPLAY_INDEX??'runs/offline/replay-index';
async function replayConfig(){const c=await loadEgressConfig('config/egress.offline.json','replay');c.replay!.index=join(replayIndex(),'index.json');return c;}
async function envelope(){const task=await loadTask('multi_turn_base_0'),identity={configId:'replay-test',taskId:'task',caseId:task.id,turn:1,step:1};
  return {protocol:MODEL_ENDPOINT_PROTOCOL,...identity,input:{metadata:identity,model:{model:'deepseek-flash'},messages:[modelSystem,...questionForTurn(task,1)],actions:await loadActions(task.id)}};}
function post(url:string,body:any):Promise<any>{return new Promise((yes,no)=>{const q=request(url,{method:'POST'},r=>{let text='';r.on('data',x=>text+=x);r.on('end',()=>{try{yes(JSON.parse(text));}catch(e){no(e);}});});q.on('error',no);q.end(JSON.stringify(body));});}
test('index repeat is byte-identical; 800 cases, 92020 scans, retry success chosen',async()=>{
  for(const file of ['index.json','summary.json'])assert.deepEqual(await readFile(join(replayIndex(),file)),await readFile(join(process.env.T5_REPEAT_INDEX??'runs/offline/t5-acceptance/replay-index-repeat',file)));
  const summary=JSON.parse(await readFile(join(replayIndex(),'summary.json'),'utf8'));assert.equal(summary.scanned,92020);assert.equal(summary.tasks,800);
  const index=JSON.parse(await readFile(join(replayIndex(),'index.json'),'utf8'));assert.equal(index.tasks.length,800);
  for(const entry of Object.values(index.records) as any[])assert.deepEqual(Object.keys(entry),['file','sha256']);
  const c=await replayConfig();
  for(const {position}of summary.retries){const row=JSON.parse(await readFile(join(c.replay!.source,'model-records',index.records[position].file),'utf8'));assert.equal(row.status,'completed');assert(row.retryAttempt>0);}
  console.log(JSON.stringify(summary));
});
test('replay mismatch logs exact field, optional failure, missing position names case/turn/step',async()=>{
  for(const strict of [true,false]){
    const c=await replayConfig();c.replay!.failOnDifference=strict;
    const out=await dir(),s=await startEgress(c,out);
    try{const call=await envelope();call.input.messages[1]={role:'user',content:'deliberate difference'};
      const response=await post(s.url,call);assert.equal(response.ok,!strict);
      const row=JSON.parse((await readFile(join(out,'requests.jsonl'),'utf8')).trim());assert(row.differences.some((x:any)=>x.path==='$.messages.1.content'));assert.equal(row.configId,'replay-test');
    }finally{await s.close();}
  }
  const c=await replayConfig(),s=await startEgress(c,await dir());
  try{const call=await envelope();call.step=999;call.input.metadata.step=999;const result=await post(s.url,call);assert.equal(result.error.kind,'run_stop');assert.match(result.error.message,/multi_turn_base_0\/1\/999/);}
  finally{await s.close();}
});
test('replay model-output failure uses old Gateway conversion plus fresh ledger metadata',async()=>{
  const c=await replayConfig(),source=await dir(),out=await dir(),call=await envelope();
  const raw=mockResponse({message:{role:'assistant',content:''},finishReason:'stop'},'deepseek-flash','chat-completions',0);raw.choices[0].finish_reason='content_filter';
  const row={caseId:call.caseId,logicalTurn:1,logicalStep:1,requestBody:buildRequest(call.input,c.settings),rawResponse:raw};
  const bytes=JSON.stringify(row),file='00000000-0000-0000-0000-000000000000.json';
  await mkdir(join(source,'model-records'));await writeFile(join(source,'model-records',file),bytes);
  const index=join(source,'index.json');await writeFile(index,JSON.stringify({version:1,records:{[`${call.caseId}/1/1`]:{file,sha256:createHash('sha256').update(bytes).digest('hex')}}}));
  c.replay={source,index,failOnDifference:true};const s=await startEgress(c,out);
  try{const response=await post(s.url,call);assert.equal(response.ok,true);assert.equal(response.output.finishReason,'error');assert.equal(response.output.message.metadata.bfclTaskFailure.code,'content_filter');assert.equal(response.output.usage.totalTokens,1320);assert(s.gateway.ledger.settlements.has(response.output.message.metadata.budgetReceipt.id));}
  finally{await s.close();}
});
test('standalone CLI child process serves the fixed endpoint, then exits cleanly',async()=>{
  const out=await dir();
  const child=spawn(process.execPath,['--import',pathToFileURL(resolve('scripts/egress-offline-guard.mjs')).href,'--disable-warning=ExperimentalWarning','--experimental-transform-types','src/ts/egress/server.ts','--backend','fixtures','--host','127.0.0.1','--port','0','--config','config/egress.offline.json','--output',out],{windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});
  let stderr='';child.stderr!.on('data',x=>stderr+=x);
  const exit=new Promise<number|null>(r=>child.once('exit',r));
  try{const ready=await new Promise<any>((yes,no)=>{let text='';child.once('error',no);child.once('exit',code=>no(new Error(`child exited ${code}: ${stderr}`)));child.stdout!.on('data',chunk=>{text+=chunk;for(const line of text.split('\n').slice(0,-1)){const value=JSON.parse(line);if(value.ready)yes(value);}});});
    assert.notEqual(ready.pid,process.pid);const result=await post(ready.url,await envelope());assert.equal(result.ok,true);assert(result.output.usage);console.log(JSON.stringify({standaloneProcess:true,backend:ready.backend,replyOk:result.ok}));
  }finally{child.send('shutdown');assert.equal(await exit,0,stderr);}
});
