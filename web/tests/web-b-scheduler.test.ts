import test from 'node:test';
import { runWebBPython } from './web-b-python.ts';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {request} from 'node:http';
import {syncBuiltinESMExports} from 'node:module';
import {mkdtemp, mkdir, readFile, writeFile, appendFile, stat} from 'node:fs/promises';
import {join} from 'node:path';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {Gateway} from '../src/ts/egress/gateway.ts';
import {ModelTransportError} from '../src/ts/egress/model.ts';
import {mockResponse} from '../src/ts/egress/mock.ts';
import {SearchLedger, SEARCH_LEDGER, SEARCH_RATE} from '../src/ts/egress/search-ledger.ts';
import {loadEgressConfig, type EgressConfig} from '../src/ts/egress/config.ts';
import {startEgress} from '../src/ts/egress/server.ts';
import {exportRun} from '../src/ts/scheduler/export.ts';
import {closeEgress, ensureEgress, inFlight, recoverEgress, searchStopSummary} from '../src/ts/scheduler/egress.ts';
import {reconcileRate} from '../src/ts/scheduler/recovery-rate.ts';
import {recordInterrupted} from '../src/ts/scheduler/records.ts';
import {scoreJob} from '../src/ts/scheduler/scoring.ts';
import {generate, type Plan} from '../src/ts/scheduler/plan.ts';
import {schedulerLock} from '../src/ts/scheduler/lock.ts';
import {runSchedule} from '../src/ts/scheduler/scheduler.ts';
import {digest, json, ROOT} from '../src/ts/scheduler/io.ts';
import {liveStage} from './t9-live-helpers.ts';
import type {RunUnitLauncher} from '../src/ts/run-unit.ts';

const scratch = () => mkdtemp(join(tmpdir(), 'wb-schedule-'));
const expectedLockPrefix = process.env.WEB_B_TEST_LOCK_PREFIX ??
  (ROOT.replaceAll('\\','/').includes('/_tmp/iso/') ? '/_tmp/scratch/' : '/_machine/scheduler-lock/');
const success = () => mockResponse({message:{role:'assistant',content:'ok'},finishReason:'stop'}, 'deepseek-flash', 'chat-completions', 0);
const modelInput = {metadata:{taskId:'model',configId:'direct-c1',caseId:'web_search_no_snippet_0',turn:1,step:1},
  model:{model:'deepseek-flash'},messages:[{role:'user' as const,content:'test'}],actions:[]};
function clock() {
  let now=1_800_000_000_000;
  return {now:()=>now,monotonicNow:()=>now,sleep:async(ms:number)=>{now+=ms;}};
}
const makeConfig = () => loadEgressConfig('config/egress.offline.json','fixtures');
const reservation = {configId:'direct-c1',taskId:'wb/direct-c1/r1/web_search_no_snippet_1',caseId:'web_search_1',call:1};
const noUnits = {list:async()=>[]} as unknown as RunUnitLauncher;

test('freeze validates the two-times boundary, field names, safe micro-units and fixed search path', () => {
  const stage = liveStage('wb', 'dev', ['direct-c1'], ['web_search_no_snippet_50'], s=>{delete s.targetedSplit;(s.launcher as any).imageId='sha256:'+'0'.repeat(64);});
  const plan = generate(stage);
  assert.equal(plan.stage.egress.searchPath,'/v1/tools/search');
  assert.equal(plan.stage.egress.settings.budget.referenceUsd,2000);
  const withChanges = (edit: (config:EgressConfig)=>void) => {const c=structuredClone(stage);edit(c.egress);return generate(c);};
  assert.throws(()=>withChanges(c=>{c.settings.budget.referenceUsd=1999.999999;}), /referenceUsd.*2.*referenceCny/);
  assert.throws(()=>withChanges(c=>{c.settings.budget.referenceCny=5e9;c.settings.budget.referenceUsd=9e9;}), /referenceCny x 2.*safe integer.*referenceUsd/);
  assert.throws(()=>withChanges(c=>{(c as any).searchPath='https://other.invalid/v1/tools/search';}), /searchPath/);
  for(const [field,edit] of [
    ['searchMaxRequests',(c:EgressConfig)=>{c.searchMaxRequests=Infinity;}],
    ['searchCny',(c:EgressConfig)=>{c.searchCny=0;}],
    ['searchDispatch.maxInFlight',(c:EgressConfig)=>{c.searchDispatch!.maxInFlight=0;}],
    ['searchDispatch.requestsPerMinute',(c:EgressConfig)=>{c.searchDispatch!.requestsPerMinute=NaN;}],
  ] as const) assert.throws(()=>withChanges(edit), new RegExp(field.replace('.','\\.')));
  assert.notEqual(withChanges(c=>{c.searchCny! += .005;}).hash,plan.hash);
});

test('startup refuses a search rate mismatch and leaves a shared stop marker', async () => {
  const dir=await scratch(),c=await makeConfig(),s=await startEgress(c,dir);
  await s.close();
  await appendFile(join(dir,SEARCH_RATE),'{"id":"orphan","configId":"x","at":1}\n');
  await assert.rejects(startEgress(c,dir), /搜索限流记录与账本不一致/);
  const stopped=JSON.parse(await readFile(join(dir,'stopped.json'),'utf8'));
  assert.match(stopped.detail,/搜索/);
  await assert.rejects(startEgress(c,dir), /拒绝自动续跑/);
});

test('recover reconciles both ledgers under a scratch lock and keeps both unknown estimates', async () => {
  assert(schedulerLock.includes(expectedLockPrefix));
  const root=await scratch(),dir=join(root,'egress'),c=await makeConfig();
  await mkdir(dir);
  const model=await Gateway.open(dir,c,async()=>success(),clock());
  const modelID=await model.ledger.reserve('model',32768,{configId:'direct-c1',caseId:'web_search_no_snippet_0'});
  await model.halt(); model.close();
  const search=await new SearchLedger(dir,c).open();
  const searchID=await search.reserve(reservation);
  await writeFile(join(dir,SEARCH_RATE),'',{flag:'wx'});
  json(join(root,'plan.json'),{runId:'wb',stage:{egress:c}});
  json(join(root,'egress','status.json'),{at:Date.now(),active:{'direct-c1':1},searchActive:{'direct-c1':1},searchLedger:search.snapshot()});
  assert.deepEqual((await searchStopSummary(root))?.inFlight,{'direct-c1':1});
  await assert.rejects(recoverEgress(root,'offline recovery',noUnits),/In-flight/);
  json(join(root,'egress','status.json'),{at:Date.now(),active:{},searchActive:{},searchLedger:search.snapshot()});
  const recovered=await recoverEgress(root,'offline recovery',noUnits);
  assert.equal(recovered.after.reservedMicroUsd,0);
  assert.equal(recovered.unknown[0].id,modelID);
  assert(recovered.after.retainedMicroUsd>0);
  assert.equal(recovered.search?.unknown[0].id,searchID);
  assert.equal(recovered.search?.after?.retainedMicroCny,5000);
  for(const [name,id] of [['rate.jsonl',modelID],[SEARCH_RATE,searchID]]) {
    const row=JSON.parse(await readFile(join(dir,name),'utf8'));
    assert.equal(row.id,id); assert.equal(row.recovered,true);
  }
  const reopened=await startEgress(c,dir,{clock:{now:()=>Date.now()+120000,sleep:async()=>{}}});
  try {assert.equal(reopened.search!.ledger.snapshot().retainedMicroCny,5000);}
  finally {await reopened.close();}
  await assert.rejects(stat(join(dir,'stopped.json')),{code:'ENOENT'});
});

test('recover treats both absent search files as zero and still reconciles the model reservation', async () => {
  assert(schedulerLock.includes(expectedLockPrefix));
  const {root,dir,c,modelID}=await stoppedBeforeSearch();
  const result=await recoverEgress(root,'offline recovery',noUnits);
  assert.equal(result.unknown[0].id,modelID);
  assert(result.after.retainedMicroUsd>0);
  assert.equal(result.search?.rate?.action,'both-files-absent');
  assert.equal(result.search?.before.requests,0);
  assert.equal(result.search?.after?.requests,0);
  assert.equal(JSON.parse(await readFile(join(dir,'rate.jsonl'),'utf8')).id,modelID);
  for(const name of [SEARCH_LEDGER, SEARCH_RATE, 'stopped.json']) await assert.rejects(stat(join(dir,name)),{code:'ENOENT'});
  const service=await startEgress(c,dir);
  try {
    assert.equal(service.search!.ledger.snapshot().requests,0);
    assert.equal(await readFile(join(dir,SEARCH_RATE),'utf8'),'');
  } finally {await service.close();}
});

for(const [present,missing] of [[SEARCH_LEDGER,SEARCH_RATE],[SEARCH_RATE,SEARCH_LEDGER]]) {
  test('recover refuses a single search file and names missing '+missing, async () => {
    assert(schedulerLock.includes(expectedLockPrefix));
    const {root,dir,c}=await stoppedBeforeSearch();
    if(present===SEARCH_LEDGER) await new SearchLedger(dir,c).open();
    else await writeFile(join(dir,SEARCH_RATE),'');
    const modelBefore=await readFile(join(dir,'ledger.jsonl'));
    const searchBefore=await readFile(join(dir,present));
    await assert.rejects(recoverEgress(root,'offline recovery',noUnits), error =>
      error instanceof Error && error.message==='搜索恢复缺少 '+missing);
    assert.deepEqual(await readFile(join(dir,'ledger.jsonl')),modelBefore);
    assert.deepEqual(await readFile(join(dir,present)),searchBefore);
    await assert.rejects(stat(join(dir,'rate.jsonl')),{code:'ENOENT'});
    await assert.rejects(stat(join(dir,missing)),{code:'ENOENT'});
    assert((await stat(join(dir,'stopped.json'))).isFile());
  });
}

async function stoppedBeforeSearch() {
  const root=await scratch(),dir=join(root,'egress'),c=await makeConfig();
  await mkdir(dir);
  const model=await Gateway.open(dir,c,async()=>success());
  let modelID: string;
  try {
    modelID=await model.ledger.reserve('model',32768,{configId:'direct-c1',caseId:'web_search_no_snippet_0'});
    await model.halt();
  } finally {model.close();}
  json(join(root,'plan.json'),{runId:'wb',stage:{egress:c}});
  return {root,dir,c,modelID};
}

async function stopReportPlan(c: EgressConfig) {
  const root=await scratch();
  const stage=JSON.parse(await readFile('config/stages/profile.json','utf8'));
  const {hash,...generated}=generate({...stage,runId:'wb-stop-report',egress:c,launcher:{kind:'local-process'},targetedSplit:undefined,
    configs:[{id:'direct-c1',group:'Direct',c:1,comparison:['direct']}],
    batches:[{id:'b',configs:['direct-c1'],caseIds:['web_search_no_snippet_0']}]});
  const plan={...generated,jobs:[]};
  json(join(root,'plan.json'),{...plan,hash:digest(plan)});
  return root;
}

for(const scenario of ['normal','search limit','truncated ledger'] as const) {
  test('scheduler final stop report: '+scenario, async () => {
    assert(schedulerLock.includes(expectedLockPrefix));
    const c=await makeConfig();
    c.searchMaxRequests=1;
    const root=await stopReportPlan(c);
    if(scenario!=='normal'){
      const url=await ensureEgress(root);
      try {
        const body=JSON.stringify({...reservation,protocol:'bfcl-web-search-v1',query:{keywords:'fixture',max_results:10,region:'wt-wt'}});
        const send=()=>fetch(new URL('/v1/search',url),{method:'POST',headers:{'content-type':'application/json'},body}).then(r=>r.json()) as Promise<any>;
        assert.equal((await send()).ok,true);
        assert.equal((await send()).error.kind,'run_stop');
      } finally {await closeEgress(root);}
      if(scenario==='truncated ledger')await appendFile(join(root,'egress',SEARCH_LEDGER),'{"kind":');
    }
    const launcher={kind:'local-process',list:async()=>[]} as unknown as RunUnitLauncher;
    const returned=await runSchedule(root,launcher);
    const report=JSON.parse(await readFile(join(root,'scheduler','stop-report.json'),'utf8'));
    assert.deepEqual(returned,report);
    if(scenario==='normal'){
      assert.equal(report.status,'complete');
      assert.equal(report.egressStopDetail,null);
      assert.deepEqual(report.search.inFlight,{});
      assert.equal(report.search.unknownMicroCny,0);
    }else{
      assert.equal(report.reason,'egress-stop');
      assert.equal(report.egressStopDetail,'达到 searchMaxRequests 上限');
      if(scenario==='search limit'){
        assert.equal(report.search.ledger.requests,1);
        assert.equal(report.search.ledger.spentMicroCny,5000);
        assert.equal(report.search.unknownMicroCny,0);
      }else{
        assert.equal(report.search,null);
        assert.match(report.searchEvidenceError,/搜索账本记录不完整/);
      }
    }
    console.log('stop-report evidence',scenario,JSON.stringify({path:join(root,'scheduler','stop-report.json'),search:report.search,
      searchEvidenceError:report.searchEvidenceError??null,egressStopDetail:report.egressStopDetail,status:report.status,reason:report.reason}));
  });
}

test('the actual egress shell tracks search intake and emits a drained stop summary', async () => {
  const root=await scratch(),c=await makeConfig();
  json(join(root,'plan.json'),{runId:'wb',stage:{egress:c,endpoint:{host:'127.0.0.1',port:0}}});
  const endpoint=await ensureEgress(root);
  const body=JSON.stringify({...reservation,protocol:'bfcl-web-search-v1',query:{keywords:'fixture',max_results:10,region:'wt-wt'}});
  let outgoing:ReturnType<typeof request>|undefined;
  try {
    const response=new Promise<any>((resolve,reject)=>{
      outgoing=request(new URL('/v1/search',endpoint),{method:'POST',headers:{'content-type':'application/json','content-length':Buffer.byteLength(body)}},incoming=>{
        let raw='';incoming.on('data',chunk=>{raw+=chunk;});incoming.once('error',reject);
        incoming.once('end',()=>{try{resolve({status:incoming.statusCode,...JSON.parse(raw)});}catch(error){reject(error);}});
      });
      outgoing.once('error',reject);outgoing.write(body.slice(0,1));
    });
    void response.catch(()=>{});
    let counters:Awaited<ReturnType<typeof searchStopSummary>>=null;
    for(let i=0;i<120;i++){
      counters=await searchStopSummary(root);
      if(counters?.inFlight?.__unidentified__===1)break;
      await new Promise(resolve=>setTimeout(resolve,20));
    }
    assert.equal(counters?.inFlight?.__unidentified__,1);
    assert.equal(inFlight(root),1);
    outgoing!.end(body.slice(1));
    const reply=await response;
    assert.equal(reply.status,200);assert.equal(reply.ok,true);
  } finally {
    outgoing?.destroy();
    await closeEgress(root);
  }
  const stopped=await searchStopSummary(root);
  assert.deepEqual(stopped?.inFlight,{});
  assert.equal(stopped?.unknownMicroCny,0);
  assert(stopped && 'ledger' in stopped);
  assert.equal(stopped.ledger.spentMicroCny,5000);
});

test('search reconciliation refuses conflicting history without changing it', async () => {
  const dir=await scratch(),c=await makeConfig(),ledger=await new SearchLedger(dir,c).open();
  const id=await ledger.reserve(reservation),bad=JSON.stringify({configId:'wrong',id,at:1})+'\n';
  await writeFile(join(dir,SEARCH_RATE),bad);
  assert.throws(()=>reconcileRate(dir,ledger,dir,SEARCH_RATE),/configuration mismatch/);
  assert.equal(await readFile(join(dir,SEARCH_RATE),'utf8'),bad);
});

test('export groups physical search attempts by Web task, block and summary, with missing values and unknown money', async () => {
  const root=await scratch(),dir=join(root,'egress'),c=await makeConfig();
  await mkdir(dir);
  const first='web_search_no_snippet_1', second='web_search_no_snippet_2', third='web_search_no_snippet_3';
  const body={version:1,runId:'wb',targeted:null,fingerprints:{},stage:{runId:'wb',egress:c,sampling:{intervalMs:200},score:{concurrency:1,timeoutMs:1000},
    configs:[{id:'direct-c1',group:'Direct',c:1,comparison:['direct']}],batches:[{id:'b'}]},
    jobs:[{key:'r1-b',batch:'b',category:'web_search_no_snippet',blockId:'b',round:1,caseIds:[first,second,third],units:[{configId:'direct-c1',caseIds:[first,second,third]}]}]};
  const plan={...body,hash:digest(body)} as unknown as Plan;
  json(join(root,'plan.json'),plan);
  const ledger=await new SearchLedger(dir,c).open();
  await ledger.settle(await ledger.reserve(reservation),true);
  await ledger.settle(await ledger.reserve(reservation),false);
  await ledger.retain(await ledger.reserve(reservation),'unknown');
  await ledger.reserve(reservation);
  const a=join(root,'blocks','b','direct-c1','r1','attempt-1');
  json(join(a,'attempt.json'),{number:1,unitId:'unit',caseIds:[first,second,third]});
  const at=Date.now(),id=ledger.reservations.keys().next().value;
  json(join(a,'logs','exit.json'),{startedAt:new Date(at-10).toISOString(),endedAt:new Date(at+10).toISOString()});
  await writeFile(join(dir,SEARCH_RATE),JSON.stringify({configId:'direct-c1',id,at})+'\n');
  recordInterrupted({path:a,caseIds:[first,second,third]},'direct-c1',plan.jobs[0],root);
  const interrupted=JSON.parse(await readFile(join(a,'interruptions.json'),'utf8'));
  assert.deepEqual(interrupted.map((r:any)=>r.caseId),[first]);
  const terminal={reason:'input_limit',source:'provider_context',inputBytes:100,maxRequestBytes:1887436,maxContextTokens:1048576,turn:1,step:1};
  json(join(a,'output','configs','direct-c1','tasks',third+'.r1.json'),{caseId:third,taskId:'wb/direct-c1/r1/'+third,
    configId:'direct-c1',round:1,status:'terminated',executionOutcome:'input_limit',termination:terminal,modelSteps:[],completed:[],workerEvents:[]});
  await scoreJob(root,plan,plan.jobs[0],{async score(_input, output) {
    json(output,{valid:false,officialScoring:false,executionOutcome:'input_limit',termination:terminal,scoringStatus:'not_evaluated_incomplete'});
    return {exitCode:0,timedOut:false,stdout:'',stderr:''};
  }});
  const result=exportRun(root,join(root,'export'));
  for(const row of [result.summary[0],result.blockRows[0],result.taskRows.find(r=>r.caseId===first)]) {
    assert.equal(row.searchAttempts,4);
    assert.equal(row.searchChargedRequests,1);
    assert.equal(row.searchUnknownRequests,2);
    assert.equal(row.searchCny,.005);
    assert.equal(row.searchUnknownHeldCny,.01);
  }
  assert.equal(result.taskRows.find(r=>r.caseId===second).searchAttempts,null);
  assert.equal(result.taskRows.find(r=>r.caseId===third).correct,false);
  assert.equal(result.summary[0].effectiveSampleSize,1);
  assert.equal(result.summary[0].correct,0);
  assert.deepEqual(result.summary[0].terminatedByOutcome,{input_limit:1});
  const metadata=JSON.parse(await readFile(join(root,'export','metadata.json'),'utf8'));
  assert.equal(metadata.referenceExchangeRate,6.7);
  console.log('synthetic export=' + root);
  runWebBPython('web-b-release.py', root);
});

test('model ledger and rate are byte-identical to M for the same identities, retry and usage', async () => {
  const sibling=join(ROOT,'..','01_bfcl_multiturn','src','ts','egress');
  const base=existsSync(sibling)?sibling:join(ROOT,'..','..','..','..','01_bfcl_multiturn','src','ts','egress');
  const prior=await import(pathToFileURL(join(base,'gateway.ts')).href);
  const priorModel=await import(pathToFileURL(join(base,'model.ts')).href);
  const c=await makeConfig();
  const original=crypto.randomUUID;
  try {
    const results=[];
    for(const [Type,ErrorType] of [[prior.Gateway,priorModel.ModelTransportError],[Gateway,ModelTransportError]]) {
      let serial=0, attempts=0;
      crypto.randomUUID=()=>`00000000-0000-4000-8000-${(++serial).toString().padStart(12,'0')}`;
      syncBuiltinESMExports();
      const dir=await scratch(), gateway=await Type.open(dir,c,async()=>{
        attempts++;
        if(attempts===1)throw new ErrorType('test retry','http',undefined,503);
        if(attempts===3)throw new ErrorType('test rejection','http',undefined,400);
        return success();
      },clock());
      try {
        await gateway.invoke(modelInput);
        assert.equal(attempts,2);
        await assert.rejects(gateway.invoke({...modelInput,metadata:{...modelInput.metadata,taskId:'bad'}}),/test rejection/);
        assert.equal(attempts,3);
        results.push(await Promise.all(['ledger.jsonl','rate.jsonl'].map(name=>readFile(join(dir,name)))));
      } finally {gateway.close();}
    }
    assert.deepEqual(results[0],results[1]);
    console.log('model parity: identical ledger.jsonl and rate.jsonl bytes (deterministic ID and clock; 503 reserve/retain, settle, 400 uncertain)',
      results[0].map(bytes=>crypto.createHash('sha256').update(bytes).digest('hex')));
  } finally {crypto.randomUUID=original;syncBuiltinESMExports();}
});
