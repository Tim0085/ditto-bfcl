import {exportRows} from '../src/ts/scheduler/export-stream.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {readFileSync,writeFileSync,existsSync,unlinkSync,mkdirSync} from 'node:fs';
import {scratch,stage} from './t8a-helpers.ts';
import {json,read,lines,digest,files,ROOT} from '../src/ts/scheduler/io.ts';
import {freeze} from '../src/ts/scheduler/plan.ts';
import {Ledger} from '../src/ts/egress/ledger.ts';
import {Gateway} from '../src/ts/egress/gateway.ts';
import {recoverEgress} from '../src/ts/scheduler/egress.ts';
import {exportRun} from '../src/ts/scheduler/export.ts';
import {taskMetrics} from '../src/ts/scheduler/export-metrics.ts';
import {reconnectSummary} from '../src/ts/scheduler/reconnect.ts';
import {scoreJob} from '../src/ts/scheduler/scoring.ts';
import {failurePause,pendingPauses,authorizePauses} from '../src/ts/scheduler/authorization.ts';
import {recordInterrupted} from '../src/ts/scheduler/records.ts';

async function gap(kind:string){
 const root=scratch(),s=stage('gap-data');s.egress.backend='fixtures';freeze(s,root);const dir=join(root,'egress');json(join(dir,'stopped.json'),{reason:'offline test'});
 const cfg=s.egress,ledger=await new Ledger(join(dir,'ledger.jsonl'),cfg.settings,cfg.mode,digest(cfg),cfg.dispatchPolicy.maxInFlight).open();
 const ids:string[]=[];for(let i=0;i<3;i++)ids.push(await ledger.reserve(`gap-data/direct-c1/r1/case${i}`,32768,{configId:'direct-c1',caseId:'case'+i}));
 const rows=ids.map((id,i)=>({configId:'direct-c1',id,at:Date.now()-10000+i*10}));
 let text=rows.map(r=>JSON.stringify(r)+'\n').join('');
 if(kind==='missing')text=rows.slice(0,2).map(r=>JSON.stringify(r)+'\n').join('');
 if(kind==='partial')text=text.slice(0,-12);
 if(kind==='middle')text=[rows[0],rows[2]].map(r=>JSON.stringify(r)+'\n').join('');
 if(kind==='order')text=[rows[1],rows[0],rows[2]].map(r=>JSON.stringify(r)+'\n').join('');
 if(kind==='extra')text+=JSON.stringify({...rows[0],id:'extra'})+'\n';
 if(kind==='wrong-tail')text=rows.slice(0,2).map(r=>JSON.stringify(r)+'\n').join('')+'{"configId":"other';
 writeFileSync(join(dir,'rate.jsonl'),text);return {root,dir,cfg,ids,text};
}
test('M1 strict prefix recovery, original bytes archived, unknown fees retained; other differences refuse',async()=>{
 for(const kind of ['missing','partial','complete','middle','order','extra','wrong-tail']){
  const x=await gap(kind),before=readFileSync(join(x.dir,'ledger.jsonl'));
  if(['middle','order','extra','wrong-tail'].includes(kind)){
   await assert.rejects(recoverEgress(x.root,'offline authorized recovery'),/rate.jsonl line \d+.*(ID|reservation)/);
   assert.equal(readFileSync(join(x.dir,'rate.jsonl'),'utf8'),x.text);assert(before.equals(readFileSync(join(x.dir,'ledger.jsonl'))));assert(existsSync(join(x.dir,'stopped.json')));
  }else{
   const result=await recoverEgress(x.root,'offline authorized recovery');assert.equal(result.after.reservedMicroUsd,0);assert.equal(result.before.reservedMicroUsd,result.after.retainedMicroUsd);assert(readFileSync(join(x.dir,'ledger.jsonl')).subarray(0,before.length).equals(before));
   if(kind!=='complete'){assert.equal(readFileSync(join(result.archive,'rate.jsonl.original'),'utf8'),x.text);const tail=lines(join(x.dir,'rate.jsonl')).at(-1);assert(tail.recovered);assert(tail.at>=Date.now()-5000);}
   let mono=0,cooldown=0;const opened=await Gateway.open(x.dir,x.cfg,async()=>{throw Error('never invoke');},{now:Date.now,monotonicNow:()=>mono,sleep:async ms=>{mono+=ms;cooldown+=ms;}});opened.close();if(kind==='partial')assert.equal(cooldown,60000);
  }
  console.log(JSON.stringify({M1:kind,status:'PASS',root:x.root}));
 }
});
test('M2 Python PID attribution from tool steps; missing or inconsistent records stay unknown',()=>{
 const data={taskId:'t',assignment:null},base=[{taskId:'t',node:'CONTEXT.SELECT',pid:10},{taskId:'t',node:'INTERACTION.ACT.TOOL',pid:11,pythonPid:20},{taskId:'t',node:'INTERACTION.ACT.TOOL',pid:11,pythonPid:20},{taskId:'t',node:'INTERACTION.ACT.TOOL',pid:11,pythonPid:0}];
 assert.equal(taskMetrics(data,base,true,'Uniform').processCount,3);
 for(const rows of [base.slice(0,1),base.map(r=>r.pythonPid===20?{...r,pythonPid:undefined}:r),[...base,{...base[1],pythonPid:21}],base.map(r=>r.pythonPid===20?{...r,pythonPid:10}:r)]){const out=taskMetrics(data,rows,true,'Uniform');assert.equal(out.processCount,null);assert(out.missing.some(m=>m.startsWith('processCount:')));}
 assert.equal(taskMetrics(data,base,false,'Uniform').processCount,null);console.log('M2 known=3; missing / inconsistent / node overlap / incomplete = null PASS');
});
test('M1 conservative recovery timestamps never invent a later-attempt start; real starts and own steps still count',()=>{
 for(const [recovered,after,ownStep,expected] of [[true,true,false,0],[false,false,false,0],[false,true,false,1],[true,true,true,1]]){
  const root=scratch(),s=stage('start-evidence',['web_search_no_snippet_0']),p=freeze(s,root),job=p.jobs[0],cid=job.units[0].configId,caseId=job.caseIds[0],taskId=`${s.runId}/${cid}/r1/${caseId}`,a={path:join(root,'attempt'),caseIds:job.caseIds},start=Date.parse('2026-11-06T00:00:00Z');
  json(join(a.path,'logs/control.json'),{startedAt:new Date(start).toISOString()});mkdirSync(join(root,'egress'),{recursive:true});
  const ledger=JSON.stringify({kind:'reserve',id:'r',taskId,configId:cid,caseId,microUsd:100})+'\n';writeFileSync(join(root,'egress/ledger.jsonl'),ledger);
  writeFileSync(join(root,'egress/rate.jsonl'),JSON.stringify({id:'r',at:recovered?Number.MAX_SAFE_INTEGER:start+(after?1000:-1000),...(recovered?{recovered:true}:{})})+'\n');
  if(ownStep){const directory=join(a.path,'output/configs',cid);mkdirSync(directory,{recursive:true});writeFileSync(join(directory,'steps.jsonl'),JSON.stringify({taskId})+'\n');}
  recordInterrupted(a,cid,job,root);assert.equal(read(join(a.path,'interruptions.json')).length,expected);assert.equal(readFileSync(join(root,'egress/ledger.jsonl'),'utf8'),ledger);
 }
 console.log('M1 synthetic future start ignored; old real=0, new real=1, own step=1; ledger unchanged PASS');
});
function dataset(){
 const root=scratch(),s=stage('bad-connect',['web_search_no_snippet_0','web_search_no_snippet_4']),p=freeze(s,root),job=p.jobs[0],cid=job.units[0].configId,a=join(root,'blocks',job.blockId,cid,'r1/attempt-1'),dir=join(a,'output/configs',cid);
 json(join(a,'attempt.json'),{number:1,unitId:'u',caseIds:job.caseIds});
 for(const caseId of job.caseIds)json(join(dir,'tasks',caseId+'.r1.json'),{caseId,taskId:`${s.runId}/${cid}/r1/${caseId}`,configId:cid,round:1,status:'completed',modelSteps:[],completed:[],assignment:null,elapsedSeconds:2});
 json(join(dir,'block-summary.json'),{tasksStarted:{wall:'2026-11-05T00:00:00Z',ns:'1000000000'},tasksEnded:{wall:'2026-11-05T00:00:10Z',ns:'11000000000'},recordingFailures:{},workerRecordingFailures:{}});
 const rows=job.caseIds.map((caseId,i)=>({node:'INFER.REASONING.SAMPLE',taskId:`${s.runId}/${cid}/r1/${caseId}`,invocationId:'sample-'+i,workMs:4000,connectRetries:2,connectRetryWaitMs:3000}));return {root,s,p,job,cid,a,dir,rows};
}
test('M3 bad reconnect values null at step/task/block/config with precise diagnostics; valid numeric bytes unchanged',()=>{
 const variants=[{connectRetryWaitMs:-1},{connectRetries:-1},{connectRetries:1.5},{connectRetryWaitMs:4001},{connectRetryWaitMs:'3000'},{connectRetries:'2'},{}];
 for(const [i,bad] of variants.entries()){
  const x=dataset();const rows=x.rows.map((r,j)=>j===1?i===6?{...r,connectRetries:undefined,connectRetryWaitMs:undefined}:{...r,...bad}:r);writeFileSync(join(x.dir,'steps.jsonl'),rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
  const e=exportRun(x.root,join(x.root,'x')),step=Array.from(exportRows(join(x.root,'x'),'steps'))[1],task=e.taskRows.find(r=>r.caseId===x.job.caseIds[1]);
  for(const row of [step,task,e.blockRows[0],e.summary[0]]){assert.equal(row.connectRetries,null);assert.equal(row.connectRetryWaitMs,null);assert(row.missing.some((m:string)=>/step 2 sample-1/.test(m)||/step 1 sample-1/.test(m)),JSON.stringify(row.missing));}
  assert(read(join(x.root,'x/metadata.json')).missing.some((m:string)=>m.startsWith('connectRetries')));if(i===0)assert(!step.missing.some((m:string)=>/connectRetries:.*nonnegative integer/.test(m)),'valid raw count must not be called invalid');console.log(JSON.stringify({M3:i,summary:e.summary[0].missing.filter((m:string)=>/connect|step/.test(m)),status:'PASS'}));
 }
 const valid=dataset();assert.equal(JSON.stringify(reconnectSummary(valid.rows,true).connectRetries),'4');assert.equal(JSON.stringify(reconnectSummary(valid.rows,true).connectRetryWaitMs),'6000');console.log('M3 normal sums byte-identical: 4 / 6000');
});
test('M6 deleted latest pause cannot be hidden behind an older authorized pause; legacy migration with old receipt',()=>{
 const dir=join(scratch(),'scheduler'),old=failurePause(dir,'old',{}),note='pause:'+old+' approved';authorizePauses(dir,pendingPauses(dir,note),note);
 const fresh=failurePause(dir,'fresh',{});json(join(dir,'stop-report.json'),{reason:'consecutive-failure',pauseIds:[old,fresh]});unlinkSync(join(dir,'failure-pauses',fresh+'.json'));
 assert.throws(()=>pendingPauses(dir),/missing.*restore/);assert.equal(lines(join(dir,'resume-refusals.jsonl')).length,1);
 json(join(dir,'stop-report.json'),{reason:'consecutive-failure'});assert.throws(()=>pendingPauses(dir),/authorization/);console.log('M6 deleted new pause and legacy stop with older authorized pause both refuse PASS');
});
test('M7 killed attempt stays separate; after scored supplementation goodput uses measured exit bound',async()=>{
 const x=dataset();unlinkSync(join(x.dir,'tasks',x.job.caseIds[1]+'.r1.json'));
 json(join(x.dir,'block-summary.json'),{tasksStarted:{wall:'2026-11-05T00:00:01Z',ns:'2000000000'}});
 json(join(x.a,'collected.json'),{killed:true,startedAt:'2026-11-05T00:00:00Z',endedAt:'2026-11-05T00:00:05Z'});
 const scorer={score:async(_:string,out:string)=>{json(out,{valid:true,officialScoring:true});return {exitCode:0,timedOut:false,stdout:'',stderr:''};}};
 await scoreJob(x.root,x.p,x.job,scorer);const pre=exportRun(x.root,join(x.root,'pre'));assert.equal(pre.summary[0].goodput,null);assert.equal(pre.summary[0].completionRate,null);
 const a2=join(x.a,'../attempt-2'),d2=join(a2,'output/configs',x.cid);json(join(a2,'attempt.json'),{number:2,unitId:'v',caseIds:[x.job.caseIds[1]]});json(join(d2,'tasks',x.job.caseIds[1]+'.r1.json'),{caseId:x.job.caseIds[1],taskId:`${x.s.runId}/${x.cid}/r1/${x.job.caseIds[1]}`,configId:x.cid,round:1,status:'completed',modelSteps:[],completed:[],elapsedSeconds:2});
 json(join(d2,'block-summary.json'),{tasksStarted:{wall:'2026-11-05T00:01:00Z',ns:'1000000000'},tasksEnded:{wall:'2026-11-05T00:01:06Z',ns:'7000000000'}});
 await scoreJob(x.root,x.p,x.job,scorer);const post=exportRun(x.root,join(x.root,'post'));assert.equal(post.summary[0].activeSeconds,10);assert.equal(post.summary[0].goodput,.2);assert.equal(post.summary[0].completionRate,.2);assert.equal(post.blockRows[0].attempts.length,2);assert.match(post.blockRows[0].attempts[0].activeTimeSource,/killed/);
 console.log(JSON.stringify({M7:'PASS',before:pre.summary[0].goodput,activeSeconds:'4 + 6 = 10',goodput:post.summary[0].goodput,completionRate:post.summary[0].completionRate}));
});
