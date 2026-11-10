// Profiling (src/ts/scheduler/profile.ts): egress retry deductions for SAMPLE (Infer) and search ACT.TOOL (Interaction),
// several run roots summed into one allocation, and the real first profiling run web-profile-001 (read-only).
// Real run root: WEB_PROF_RUN_001 (default runs/live/web-profile-001 of this package); missing => the test fails.
// Its output goes to WEB_PROF_OUTPUT_DIR (default a new temporary directory), never into the run root.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,mkdtempSync,readFileSync,writeFileSync,cpSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,relative,isAbsolute} from 'node:path';
import {optimize,profile,ranking} from '../src/ts/scheduler/profile.ts';
import {freeze,capabilities,type Plan} from '../src/ts/scheduler/plan.ts';
import {json,read,lines,env,ROOT} from '../src/ts/scheduler/io.ts';
import {scratch} from './t8a-helpers.ts';

type Base={Context:number;Infer:number;Interaction:number;Memory:number};
type ModelRetry={failures:{apiMs:number;rateWaitMs:number;retryDelayMs?:number}[];rateWaitMs:number;budgetWaitMs?:number;workMs?:number};
type SearchRetry={failed:{apiMs:number;delayMs:number}[];workMs?:number};
const category='web_search_no_snippet',defaultBase:Base={Context:100,Infer:9000,Interaction:4000,Memory:50};
const persist=(path:string,rows:any[])=>writeFileSync(path,rows.map(r=>JSON.stringify(r)).join('\n')+(rows.length?'\n':''));
const edit=(path:string,change:(rows:any[])=>any[])=>persist(path,change(lines(path)));
// Expected deduction of a model retry, the profile.ts rule written out: failed attempts (API + limiter wait),
// the cooldown before the last attempt (at most its rateWaitMs) and the budget wait.
const modelDeduct=(m:ModelRetry)=>m.failures.reduce((n,f)=>n+f.apiMs+f.rateWaitMs,0)+(m.failures.length?Math.min(m.failures.at(-1)!.retryDelayMs??0,m.rateWaitMs):0)+(m.budgetWaitMs??0);
const searchDeduct=(s:SearchRetry)=>s.failed.reduce((n,f)=>n+f.apiMs+f.delayMs,0);

// A finished Uniform8/c1 profiling root in the shapes the package writes: plan.json, attempt, block summary, task records,
// steps.jsonl, and the egress ledgers, cooldown logs and search records. Each task: SAMPLE 1 asks one search and one fetch,
// SAMPLE 2 answers. Integer times keep the expected sums exact.
function synthetic(runId:string,options:{base?:Base;model?:Record<string,ModelRetry>;search?:Record<string,SearchRetry>;stage?:(s:any)=>void}={}){
  const root=scratch(),s=read(join(ROOT,'config/stages/profile.json'));s.runId=runId;options.stage?.(s);const plan=freeze(s,root);
  const job=plan.jobs[0],cid=job.units[0].configId,attempt=join(root,'blocks',job.blockId,cid,'r1/attempt-1'),dir=join(attempt,'output','configs',cid),egress=join(root,'egress');
  json(join(attempt,'attempt.json'),{number:1,caseIds:job.caseIds,unitId:'synthetic'});json(join(dir,'block-summary.json'),{exitCode:0,failed:0,notStarted:0});
  const base=options.base??defaultBase,rows:any[]=[],ledger:any[]=[{kind:'header',version:1}],cooldowns:any[]=[],searchLedger:any[]=[{kind:'header',version:1}],searchCooldowns:any[]=[];
  const expected={rawA:{Context:0,Infer:0,Interaction:0,Memory:0} as Base,A:{Context:0,Infer:0,Interaction:0,Memory:0} as Base};
  let ns=1000;const at=()=>({ns:String(ns+=10),wall:'2026-11-09T10:00:00.000Z'});
  for(const caseId of job.caseIds){const taskId=`${runId}/${cid}/r1/${caseId}`,number=caseId.split('_').at(-1),model=options.model?.[caseId],search=options.search?.[caseId],steps:any[]=[];
    rows.push({taskId,node:'CONTEXT.SELECT',graphId:'bfcl-turn',invocationId:caseId+'-ctx',workMs:base.Context,started:at()});
    for(const k of [1,2]){const id=`${caseId}-m${k}`,retry=k===1?model:undefined;
      const failures=(retry?.failures??[]).map((f,j)=>({id:`${id}-f${j+1}`,heldReferenceMicroUsd:1,heldReferenceMicroCny:1,reason:'transport_unknown',apiMs:f.apiMs,requestStartedAt:1794218600000+j,rateWaitMs:f.rateWaitMs,errorCategory:'transport',...(f.retryDelayMs!==undefined?{retryDelayMs:f.retryDelayMs}:{}),turn:1,step:k}));
      for(const f of failures){ledger.push({kind:'reserve',id:f.id,taskId,configId:cid,caseId},{kind:'retain_failed',id:f.id,reason:'transport_unknown',source:'bounded_retry',configId:cid});
        if(f.retryDelayMs!==undefined)cooldowns.push({configId:cid,reservationId:f.id,at:1794218600000,until:1794218600000+f.retryDelayMs,delayMs:f.retryDelayMs,reason:'transport',scope:'request'});}
      ledger.push({kind:'reserve',id,taskId,configId:cid,caseId},{kind:'settle',id});
      const timing={apiMs:1000,requestStartedAt:1794218700000+k,rateWaitMs:retry?.rateWaitMs??5,...(retry?.budgetWaitMs?{budgetWaitMs:retry.budgetWaitMs}:{}),
        ...(failures.length?{retryApiMs:failures.reduce((n,f)=>n+f.apiMs,0),retryRateWaitMs:failures.reduce((n,f)=>n+f.rateWaitMs,0),physicalAttempts:failures.length+1}:{})};
      const actionRequests=k===1?[{id:caseId+'-s1',name:'search_engine_query',arguments:{keywords:'query '+caseId}},{id:caseId+'-w1',name:'fetch_url_content',arguments:{url:'https://example.org/'+number}}]:[];
      steps.push({turn:1,step:k,output:{message:{role:'assistant',content:'',metadata:{returnedModel:'deepseek-flash',budgetReceipt:{id,referenceMicroUsd:1,referenceMicroCny:1},...(failures.length?{failedModelAttempts:failures}:{}),modelTiming:timing}},finishReason:k===1?'action_request':'stop',actionRequests}});
      const deduct=retry?modelDeduct(retry):0,work=k===1?base.Infer:500;
      rows.push({taskId,node:'INFER.REASONING.SAMPLE',graphId:'bfcl-action',invocationId:id+'-row',workMs:retry?.workMs??work+deduct,connectRetries:0,connectRetryWaitMs:0,budgetReceipt:{id,referenceMicroUsd:1,referenceMicroCny:1},modelTiming:timing,started:at()});
      expected.rawA.Infer+=work+deduct;expected.A.Infer+=work;
      if(k===1){const deductSearch=search?searchDeduct(search):0;
        rows.push({taskId,node:'INTERACTION.ACT.TOOL',graphId:'bfcl-action',invocationId:caseId+'-tool-s1',action:'call',toolCallId:caseId+'-s1',pid:51,pythonPid:91,workMs:search?.workMs??base.Interaction+deductSearch,started:at()});
        rows.push({taskId,node:'INTERACTION.ACT.TOOL',graphId:'bfcl-action',invocationId:caseId+'-tool-w1',action:'call',toolCallId:caseId+'-w1',pid:51,pythonPid:91,workMs:7,started:at()});
        expected.rawA.Interaction+=base.Interaction+deductSearch+7;expected.A.Interaction+=base.Interaction+7;
        const attempts=[...(search?.failed??[]).map(f=>({...f,ok:false})),{apiMs:300,delayMs:0,ok:true}];
        for(const [j,a] of attempts.entries()){const reservationId=`${caseId}-search-1-${j+1}`,identity={configId:cid,taskId,caseId:'web_search_'+number,call:1};
          searchLedger.push({kind:'reserve',id:reservationId,...identity,microCny:5000},a.ok?{kind:'settle',id:reservationId,microCny:5000}:{kind:'retain_failed',id:reservationId,heldMicroCny:5000,reason:'unknown'});
          if(!a.ok)searchCooldowns.push({configId:cid,reservationId,at:1794218800000,until:1794218800000+a.delayMs,delayMs:a.delayMs,reason:'transport',scope:'request'});
          json(join(egress,'search-records',reservationId+'.json'),{...identity,reservationId,attempt:j+1,query:{keywords:'query '+caseId,max_results:10,region:'wt-wt'},status:a.ok?200:null,raw:null,incomplete:!a.ok,output:a.ok?{organic_results:[]}:null,
            reply:a.ok?{ok:true,output:{organic_results:[]}}:{ok:false,error:{kind:'search_failed',message:'temporary'}},apiMs:a.apiMs});}
      }
    }
    rows.push({taskId,node:'MEMORY.WRITE',graphId:'bfcl-turn',invocationId:caseId+'-mem',workMs:base.Memory,started:at()});
    expected.rawA.Context+=base.Context;expected.A.Context+=base.Context;expected.rawA.Memory+=base.Memory;expected.A.Memory+=base.Memory;
    json(join(dir,'tasks',caseId+'.r1.json'),{caseId,taskId,configId:cid,round:1,status:'completed',modelSteps:steps,completed:[]});
  }
  persist(join(dir,'steps.jsonl'),rows);mkdirSync(egress,{recursive:true});persist(join(egress,'ledger.jsonl'),ledger);persist(join(egress,'search-ledger.jsonl'),searchLedger);
  if(cooldowns.length)persist(join(egress,'rate.cooldowns.jsonl'),cooldowns);if(searchCooldowns.length)persist(join(egress,'search-rate.cooldowns.jsonl'),searchCooldowns);
  return {root,plan,dir,egress,cases:job.caseIds,steps:join(dir,'steps.jsonl'),expected};
}
const programSha=()=>Object.fromEntries(['src/ts/scheduler/profile.ts','scripts/t8a.ts'].map(p=>[p,createHash('sha256').update(readFileSync(join(ROOT,p))).digest('hex')]));
let outputs=0;const out=(root:string)=>join(root,`split-${process.pid}-${++outputs}.json`);
const part=(r:any)=>r.byCategory[category];

test('no egress retries: A and allocation equal the old rule (connect waits only), nothing deducted',()=>{
  const x=synthetic('prof-none'),r=profile(x.root,out(x.root)),c=part(r);
  assert.deepEqual(c.A,x.expected.rawA);assert.deepEqual(c.rawA,x.expected.rawA);assert.deepEqual(c.A,x.expected.A);
  assert.deepEqual({copies:c.copies,objectiveMs:c.objectiveMs},optimize(x.expected.rawA));
  assert.deepEqual(c.deducted,{Infer:{steps:0,failedAttempts:0,ms:0},Interaction:{steps:0,failedAttempts:0,ms:0}});
  assert.equal(r.status,'complete');assert.equal(r.sourceRunId,'prof-none');assert.equal(r.planHash,x.plan.hash);assert.equal(c.connectRetries,0);assert.equal(c.connectRetryWaitMs,0);
  assert.deepEqual(c.candidates[0],{copies:c.copies,objectiveMs:c.objectiveMs});assert.equal(c.candidates.length,5);
  assert.deepEqual(r.roots[0].files.map((f:any)=>f.path).slice(0,5),['plan.json','egress/ledger.jsonl','egress/rate.cooldowns.jsonl','egress/search-ledger.jsonl','egress/search-rate.cooldowns.jsonl']);
  // Program version: the two files as run now, equal to the fingerprints of a plan frozen with this code.
  assert.deepEqual(r.program.files,programSha());assert.deepEqual(r.program.roots,[{runId:'prof-none',matchesPlanFingerprints:true,files:{'src/ts/scheduler/profile.ts':true,'scripts/t8a.ts':true}}]);
  assert.equal(r.roots[0].files[2].sha256,null);assert.match(String(r.roots[0].files[1].sha256),/^[0-9a-f]{64}$/);
  // Optional: keep this root for a side-by-side run of the previous profile.ts (evidence only).
  if(process.env.WEB_PROF_KEEP_DIR){const keep=join(process.env.WEB_PROF_KEEP_DIR,'no-retry-root');cpSync(x.root,keep,{recursive:true});console.log(JSON.stringify({keptNoRetryRoot:keep,A:c.A,copies:c.copies,objectiveMs:c.objectiveMs}));}
});

test('model retries: failed attempts, last cooldown (capped by the last rateWaitMs) and budget wait come out of Infer once',()=>{
  const model:Record<string,ModelRetry>={
    [category+'_62']:{failures:[{apiMs:21327,rateWaitMs:18,retryDelayMs:30000}],rateWaitMs:30025},
    [category+'_68']:{failures:[{apiMs:21000,rateWaitMs:20,retryDelayMs:30000},{apiMs:60000,rateWaitMs:30010,retryDelayMs:60000}],rateWaitMs:60030,budgetWaitMs:400},
    [category+'_87']:{failures:[{apiMs:22000,rateWaitMs:18,retryDelayMs:30000}],rateWaitMs:29990},
    [category+'_13']:{failures:[],rateWaitMs:5,budgetWaitMs:1234}};
  const x=synthetic('prof-model',{model}),r=profile(x.root,out(x.root)),c=part(r),rows=part(r.roots[0]).deductions;
  assert.deepEqual(c.A,x.expected.A);assert.deepEqual(c.rawA,x.expected.rawA);
  assert.deepEqual(rows.map((d:any)=>[d.caseId,d.deductMs]).sort(),Object.entries(model).map(([k,m])=>[k,modelDeduct(m)]).sort());
  assert.equal(modelDeduct(model[category+'_62']),51345);assert.equal(modelDeduct(model[category+'_87']),22000+18+29990);assert.equal(modelDeduct(model[category+'_68']),21000+20+60000+30010+60000+400);
  const d68=rows.find((d:any)=>d.caseId===category+'_68');assert.deepEqual([d68.failedAttempts,d68.failedApiMs,d68.failedRateWaitMs,d68.cooldownMs,d68.budgetWaitMs,d68.turn,d68.step],[2,81000,30030,60000,400,1,1]);
  assert.deepEqual(d68.failedAttemptIds,[category+'_68-m1-f1',category+'_68-m1-f2']);
  assert.deepEqual(c.deducted.Infer,{steps:4,failedAttempts:4,ms:Object.values(model).reduce((n,m)=>n+modelDeduct(m),0)});assert.deepEqual(c.deducted.Interaction,{steps:0,failedAttempts:0,ms:0});
  assert.deepEqual({copies:c.copies,objectiveMs:c.objectiveMs},optimize(x.expected.A));
});

test('search retries: failed attempts and their cooldowns come out of the search ACT.TOOL step; fetches stay',()=>{
  const search:Record<string,SearchRetry>={[category+'_60']:{failed:[{apiMs:60000,delayMs:30000},{apiMs:1000,delayMs:60000}]},[category+'_21']:{failed:[{apiMs:12,delayMs:30000}]}};
  const x=synthetic('prof-search',{search}),r=profile(x.root,out(x.root)),c=part(r),rows=part(r.roots[0]).deductions;
  assert.deepEqual(c.A,x.expected.A);assert.deepEqual(c.rawA,x.expected.rawA);
  assert.deepEqual(rows.map((d:any)=>[d.caseId,d.capability,d.node,d.call,d.failedAttempts,d.failedApiMs,d.cooldownMs,d.deductMs]).sort(),
    [[category+'_21','Interaction','INTERACTION.ACT.TOOL',1,1,12,30000,30012],[category+'_60','Interaction','INTERACTION.ACT.TOOL',1,2,61000,90000,151000]]);
  assert.ok(rows.every((d:any)=>d.toolCallId.endsWith('-s1')));
  assert.deepEqual(c.deducted.Interaction,{steps:2,failedAttempts:3,ms:181012});assert.deepEqual(c.deducted.Infer,{steps:0,failedAttempts:0,ms:0});
  assert.deepEqual({copies:c.copies,objectiveMs:c.objectiveMs},optimize(x.expected.A));
});

test('refuses: deduction above workMs, ledger or cooldown mismatch, unmatched steps or search calls, bad timing',()=>{
  const id=category+'_62',retry:ModelRetry={failures:[{apiMs:21327,rateWaitMs:18,retryDelayMs:30000}],rateWaitMs:30025};
  const over=synthetic('prof-over',{model:{[id]:{...retry,workMs:51000}}});assert.throws(()=>profile(over.root,out(over.root)),/exceeds the step workMs/);
  const overSearch=synthetic('prof-over-s',{search:{[id]:{failed:[{apiMs:500,delayMs:30000}],workMs:30400}}});assert.throws(()=>profile(overSearch.root,out(overSearch.root)),/exceeds the step workMs/);
  const cases:[string,(x:ReturnType<typeof synthetic>)=>void,RegExp][]=[
    ['model retain_failed missing',x=>edit(join(x.egress,'ledger.jsonl'),rows=>rows.filter(r=>r.kind!=='retain_failed')),/retain_failed/],
    ['extra model retain_failed',x=>edit(join(x.egress,'ledger.jsonl'),rows=>[...rows,{kind:'retain_failed',id:x.cases[0]+'-m2',source:'bounded_retry'}]),/retain_failed/],
    ['model cooldown row missing',x=>edit(join(x.egress,'rate.cooldowns.jsonl'),()=>[]),/rate\.cooldowns\.jsonl row/],
    ['model cooldown delay differs',x=>edit(join(x.egress,'rate.cooldowns.jsonl'),rows=>rows.map(r=>({...r,delayMs:1}))),/rate\.cooldowns\.jsonl row/],
    ['SAMPLE receipt not a model step',x=>edit(x.steps,rows=>rows.map(r=>r.invocationId===id+'-m1-row'?{...r,budgetReceipt:{id:'other'}}:r)),/one to one/],
    ['extra SAMPLE row',x=>edit(x.steps,rows=>[...rows,{...rows.find(r=>r.invocationId===id+'-m1-row'),invocationId:'copy'}]),/one to one/],
    ['step timing differs from task record',x=>edit(x.steps,rows=>rows.map(r=>r.invocationId===id+'-m1-row'?{...r,modelTiming:{...r.modelTiming,retryApiMs:1}}:r)),/differs from the task record/],
    ['retry totals inconsistent',x=>{const p=join(x.dir,'tasks',id+'.r1.json'),t=read(p),m=t.modelSteps[0].output.message.metadata;m.modelTiming.physicalAttempts=3;writeFileSync(p,JSON.stringify(t));
      edit(x.steps,rows=>rows.map(r=>r.invocationId===id+'-m1-row'?{...r,modelTiming:m.modelTiming}:r));},/retry totals/],
    ['negative failed API time',x=>{const p=join(x.dir,'tasks',id+'.r1.json'),t=read(p);t.modelSteps[0].output.message.metadata.failedModelAttempts[0].apiMs=-1;writeFileSync(p,JSON.stringify(t));},/Invalid profiling model retry record/],
  ];
  for(const [name,change,error] of cases){const x=synthetic('prof-bad',{model:{[id]:retry}});change(x);assert.throws(()=>profile(x.root,out(x.root)),error,name);}
  const searchCases:[string,(x:ReturnType<typeof synthetic>)=>void,RegExp][]=[
    ['search reservation missing',x=>edit(join(x.egress,'search-ledger.jsonl'),rows=>rows.filter(r=>!(r.kind==='reserve'&&r.id===id+'-search-1-1'))),/reservations differ/],
    ['search retain_failed missing',x=>edit(join(x.egress,'search-ledger.jsonl'),rows=>rows.filter(r=>r.kind!=='retain_failed')),/failed attempt/],
    ['search cooldown missing',x=>edit(join(x.egress,'search-rate.cooldowns.jsonl'),()=>[]),/failed attempt/],
    ['search query differs',x=>{const p=join(x.egress,'search-records',id+'-search-1-2.json'),r=read(p);r.query.keywords='other';writeFileSync(p,JSON.stringify(r));},/call 1/],
    ['search attempt numbers broken',x=>{const p=join(x.egress,'search-records',id+'-search-1-2.json'),r=read(p);r.attempt=3;writeFileSync(p,JSON.stringify(r));},/call 1/],
    ['search calls in two Python backends',x=>{const p=join(x.dir,'tasks',id+'.r1.json'),t=read(p);t.modelSteps[0].output.actionRequests[1]={id:id+'-w1',name:'search_engine_query',arguments:{keywords:'second'}};writeFileSync(p,JSON.stringify(t));
      edit(x.steps,rows=>rows.map(r=>r.invocationId===id+'-tool-w1'?{...r,pythonPid:93}:r));},/one Worker and one Python backend/],
  ];
  for(const [name,change,error] of searchCases){const x=synthetic('prof-bad-s',{search:{[id]:{failed:[{apiMs:500,delayMs:30000}]}}});change(x);assert.throws(()=>profile(x.root,out(x.root)),error,name);}
  // A search call numbered beyond the task's search steps cannot be placed.
  const extra=synthetic('prof-bad-n',{search:{[id]:{failed:[{apiMs:500,delayMs:30000}]}}});
  for(const name of [id+'-search-1-1',id+'-search-1-2']){const p=join(extra.egress,'search-records',name+'.json'),r=read(p);r.call=2;writeFileSync(p,JSON.stringify(r));}
  edit(join(extra.egress,'search-ledger.jsonl'),rows=>rows.map(r=>r.kind==='reserve'&&r.id.startsWith(id+'-search-')?{...r,call:2}:r));assert.throws(()=>profile(extra.root,out(extra.root)),/call 2/);
  // Retry records of a task that is not measured are refused rather than ignored.
  const strayModel=synthetic('prof-stray-m');edit(join(strayModel.egress,'ledger.jsonl'),rows=>[...rows,{kind:'reserve',id:'stray',taskId:'prof-stray-m/uniform-8-c1/r1/other'},{kind:'retain_failed',id:'stray'}]);
  assert.throws(()=>profile(strayModel.root,out(strayModel.root)),/outside the profiling cases/);
  const straySearch=synthetic('prof-stray-s');json(join(straySearch.egress,'search-records','stray.json'),{taskId:'prof-stray-s/uniform-8-c1/r1/other',call:1,attempt:1});
  assert.throws(()=>profile(straySearch.root,out(straySearch.root)),/outside the profiling cases/);
});

test('several roots: same plan required, roots and runIds unique; A summed and one allocation chosen; 2/2/2/2 still stops',()=>{
  const a=synthetic('prof-r1',{model:{[category+'_62']:{failures:[{apiMs:21327,rateWaitMs:18,retryDelayMs:30000}],rateWaitMs:30025}}}),
    b=synthetic('prof-r2',{base:{Context:150,Infer:6000,Interaction:7000,Memory:40},search:{[category+'_60']:{failed:[{apiMs:900,delayMs:30000}]}}}),
    c=synthetic('prof-r3',{base:{Context:90,Infer:12000,Interaction:3000,Memory:70}});
  const target=out(a.root),r=profile([a.root,b.root,c.root],target),sum=Object.fromEntries(capabilities.map(k=>[k,a.expected.A[k]+b.expected.A[k]+c.expected.A[k]]));
  assert.deepEqual(part(r).A,sum);assert.deepEqual(part(r).rawA,Object.fromEntries(capabilities.map(k=>[k,a.expected.rawA[k]+b.expected.rawA[k]+c.expected.rawA[k]])));
  assert.deepEqual({copies:part(r).copies,objectiveMs:part(r).objectiveMs},optimize(sum));assert.deepEqual(part(r).candidates,ranking(sum).slice(0,5));
  assert.deepEqual(r.sourceRunIds,['prof-r1','prof-r2','prof-r3']);assert.equal(r.sourceRunId,undefined);assert.equal(r.planHash,undefined);
  assert.deepEqual(r.roots.map((x:any)=>x.planHash),[a.plan.hash,b.plan.hash,c.plan.hash]);
  assert.deepEqual(r.program.roots.map((x:any)=>[x.runId,x.matchesPlanFingerprints]),[['prof-r1',true],['prof-r2',true],['prof-r3',true]]);
  for(const [i,x] of [a,b,c].entries()){const own=part(r.roots[i]);assert.deepEqual(own.A,x.expected.A);assert.deepEqual(own.rawA,x.expected.rawA);assert.deepEqual({copies:own.copies,objectiveMs:own.objectiveMs},ranking(x.expected.A)[0]);}
  assert.deepEqual(part(r).deducted,{Infer:{steps:1,failedAttempts:1,ms:51345},Interaction:{steps:1,failedAttempts:1,ms:30900}});
  assert.deepEqual(read(target),JSON.parse(JSON.stringify(r)));
  const reordered=profile([c.root,a.root,b.root],out(c.root));assert.deepEqual(reordered.byCategory,r.byCategory);assert.deepEqual(reordered.sourceRunIds,r.sourceRunIds);
  assert.equal(new Set(part(r).sources.map((s:any)=>s.runId)).size,3);
  assert.throws(()=>profile([a.root,a.root],out(b.root)),/given twice/);
  const dup=synthetic('prof-r1');assert.throws(()=>profile([a.root,dup.root],out(b.root)),/repeat a runId/);
  const other=synthetic('prof-r4',{stage:s=>{s.hostSampleMs=s.hostSampleMs+1;}});assert.throws(()=>profile([a.root,other.root],out(b.root)),/different frozen plans \(stage\)/);
  const tampered=synthetic('prof-r5');const plan=read<Plan>(join(tampered.root,'plan.json'));plan.jobs[0].caseIds.reverse();writeFileSync(join(tampered.root,'plan.json'),JSON.stringify(plan));
  assert.throws(()=>profile([a.root,tampered.root],out(b.root)),/Frozen plan was changed/);
  const flat=synthetic('prof-flat',{base:{Context:1000,Infer:500,Interaction:993,Memory:1000}}),flatOut=out(flat.root);
  assert.throws(()=>profile(flat.root,flatOut),/equals Uniform/);assert.equal(existsSync(flatOut),false);
  const flat2=synthetic('prof-flat2',{base:{Context:1000,Infer:500,Interaction:993,Memory:1000}});assert.throws(()=>profile([flat.root,flat2.root],out(flat.root)),/equals Uniform/);
});

async function cli(args:string[],report:string){const child=spawn(process.execPath,['--experimental-transform-types',join(ROOT,'scripts/t8a.ts'),...args],{cwd:ROOT,env:env(report),windowsHide:true,stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);const code=await new Promise<number|null>((yes,no)=>{child.once('error',no);child.once('close',yes);});return {code,stdout,stderr};}
test('command line: profile --root A --root B --output X equals profile([A,B]); several roots need --output; one root keeps the default file',async()=>{
  const a=synthetic('prof-cli1'),b=synthetic('prof-cli2',{base:{Context:150,Infer:6000,Interaction:7000,Memory:40}}),target=out(a.root),report=join(a.root,'guards');
  const ok=await cli(['profile','--root',a.root,'--root',b.root,'--output',target],report);assert.equal(ok.code,0,ok.stderr);
  const direct=profile([a.root,b.root],out(b.root)),written=read(target);assert.deepEqual(written.byCategory,JSON.parse(JSON.stringify(direct.byCategory)));assert.deepEqual(written.sourceRunIds,['prof-cli1','prof-cli2']);
  const missing=await cli(['profile','--root',a.root,'--root',b.root],report);assert.notEqual(missing.code,0);assert.match(missing.stderr,/--output is required with more than one --root/);
  const single=await cli(['profile','--root',b.root],report);assert.equal(single.code,0,single.stderr);assert.deepEqual(read(join(b.root,'targeted-split.json')).byCategory,JSON.parse(JSON.stringify(profile(b.root,out(b.root)).byCategory)));
});

test('real run web-profile-001: raw A equals the published split, exactly the 3 egress retries come out, allocation 1/3/3/1',()=>{
  const run=resolve(process.env.WEB_PROF_RUN_001??join(ROOT,'runs/live/web-profile-001'));
  assert.ok(existsSync(join(run,'plan.json'))&&existsSync(join(run,'targeted-split.json')),'web-profile-001 not found at '+run+' (set WEB_PROF_RUN_001)');
  const directory=process.env.WEB_PROF_OUTPUT_DIR?resolve(process.env.WEB_PROF_OUTPUT_DIR):mkdtempSync(join(tmpdir(),'web-prof-'));mkdirSync(directory,{recursive:true});
  const inside=relative(run,directory);assert.ok(inside.startsWith('..')||isAbsolute(inside),'output must stay outside the run root');
  const before=readFileSync(join(run,'targeted-split.json')),target=join(directory,`web-profile-001-split-${process.pid}-${Date.now()}.json`),r=profile(run,target),c=part(r),old=read(join(run,'targeted-split.json')).byCategory[category];
  assert.deepEqual(c.rawA,old.A);assert.equal(c.connectRetries,old.connectRetries);assert.equal(c.connectRetryWaitMs,old.connectRetryWaitMs);
  const rows=part(r.roots[0]).deductions;
  assert.deepEqual(rows.map((d:any)=>[d.caseId,d.capability,d.turn,d.step,d.failedAttempts,d.budgetReceiptId]).sort(),[
    [category+'_62','Infer',1,17,1,'53421c09-6a4f-48f4-b1a2-f34576bf7b09'],[category+'_68','Infer',1,28,1,'ae6b3d1a-cc0e-4fe2-b580-25b15236723f'],[category+'_87','Infer',1,18,1,'14b8b15c-2765-4dc1-abad-c2a696a80a94']]);
  assert.ok(rows.every((d:any)=>d.cooldownMs===30000&&d.budgetWaitMs===0&&d.workMs>55000));
  assert.deepEqual(rows.map((d:any)=>d.failedAttemptIds[0]).sort(),['08cfed0d-2a84-4c49-a3e0-8e3fe11b2f23','88a5cdc6-abd1-4cd4-bdd6-e3ad60907d5f','d51b6892-87c8-4425-b306-f2e9ab1740f0']);
  assert.equal(c.deducted.Infer.steps,3);assert.equal(c.deducted.Infer.failedAttempts,3);assert.equal(c.deducted.Interaction.steps,0);
  assert.ok(Math.abs(c.deducted.Infer.ms-155044.4715)<1e-6,String(c.deducted.Infer.ms));
  assert.deepEqual(c.A,{Context:1297.3503189999985,Infer:421455.12268400006,Interaction:309691.1357119999,Memory:1021.265214});
  for(const k of ['Context','Interaction','Memory'])assert.equal(c.A[k],old.A[k]);
  assert.deepEqual(c.copies,{Context:1,Infer:3,Interaction:3,Memory:1});assert.deepEqual(old.copies,{Context:1,Infer:4,Interaction:2,Memory:1});
  assert.equal(r.sourceRunId,'web-profile-001');assert.equal(r.planHash,read(join(run,'plan.json')).hash);
  // 001 was frozen with the earlier profile.ts/t8a.ts: recorded as not matching, not refused.
  const fp=read(join(run,'plan.json')).fingerprints;assert.deepEqual(r.program.files,programSha());
  assert.deepEqual(r.program.roots,[{runId:'web-profile-001',matchesPlanFingerprints:false,files:Object.fromEntries(Object.entries(programSha()).map(([p,h])=>[p,fp[p]===h]))}]);
  assert.equal(r.program.files['src/ts/scheduler/profile.ts']===fp['src/ts/scheduler/profile.ts'],false);
  assert.ok(r.roots[0].files.some((f:any)=>f.path==='egress/ledger.jsonl'&&/^[0-9a-f]{64}$/.test(f.sha256)));assert.equal(r.roots[0].files.filter((f:any)=>f.path.startsWith('egress/search-records/')).length,113);
  assert.ok(readFileSync(join(run,'targeted-split.json')).equals(before));assert.equal(existsSync(join(run,target.split(/[\\/]/).at(-1)!)),false);
  console.log(JSON.stringify({output:target,rawA:c.rawA,A:c.A,deducted:c.deducted,deductions:rows,copies:c.copies,objectiveMs:c.objectiveMs,candidates:c.candidates}));
});
