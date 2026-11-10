import {exportRows} from '../src/ts/scheduler/export-stream.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {writeFileSync,readFileSync,existsSync} from 'node:fs';
import {stage,scratch} from './t8a-helpers.ts';
import {json,read,files} from '../src/ts/scheduler/io.ts';
import {freeze} from '../src/ts/scheduler/plan.ts';
import {runSchedule} from '../src/ts/scheduler/scheduler.ts';
import {LocalProcessLauncher} from '../src/ts/scheduler/local-process.ts';
import {remaining} from '../src/ts/scheduler/records.ts';
import {exportRun} from '../src/ts/scheduler/export.ts';
import {scoreJob} from '../src/ts/scheduler/scoring.ts';
import {containerMetrics} from '../src/ts/scheduler/export-metrics.ts';
import {pendingPauses,authorizePauses,failurePause} from '../src/ts/scheduler/authorization.ts';
import type {RunUnitLauncher} from '../src/ts/run-unit.ts';
test('Stopped egress collection preserves an independent consecutive-failure pause',async()=>{
 const root=scratch(),p=freeze(stage('stopped-collection',['multi_turn_base_0']),root),job=p.jobs[0],cid=job.units[0].configId,unitId='failed-unit',a=join(root,'blocks',job.blockId,cid,'r1/attempt-1');
 json(join(a,'attempt.json'),{number:1,unitId,caseIds:job.caseIds});json(join(root,'egress/stopped.json'),{reason:'injected'});
 const unit={unitId,isAlive:async()=>false,wait:async()=>({exitCode:1,signal:null,killed:false,stoppedByPlan:false,oomKilled:null,startedAt:'2026-11-05T00:00:00Z',endedAt:'2026-11-05T00:00:01Z',summary:{consecutiveFailure:{failureType:'context-error',count:2}}}),stop:async()=>{},kill:async()=>{throw Error('no kill expected');}};
 const launcher:RunUnitLauncher={kind:'local-process',list:async()=>[unitId],adopt:async()=>unit,start:async()=>{throw Error('no start expected');},toUnitView:s=>s.block};
 const result=await runSchedule(root,launcher);assert.equal(result.reason,'egress-stop');assert.throws(()=>pendingPauses(join(root,'scheduler')),/authorization/);assert(existsSync(join(a,'collected.json')));
});
test('Legacy pause migration, repeated refusal and new independent authorization',()=>{
 const root=scratch(),dir=join(root,'scheduler');json(join(dir,'stop-report.json'),{reason:'consecutive-failure'});const original=readFileSync(join(dir,'stop-report.json'));
 for(let i=0;i<2;i++)assert.throws(()=>pendingPauses(dir),/authorization/);
 assert(original.equals(readFileSync(join(dir,'stop-report.json'))));const note='pause:'+read(files(join(dir,'failure-pauses'))[0]).pauseId+' first';const p=pendingPauses(dir,note);authorizePauses(dir,p,note);assert.equal(pendingPauses(dir).length,0);
 failurePause(dir,'second',{configId:'direct-c1'});assert.throws(()=>pendingPauses(dir),/authorization/);assert.equal(readFileSync(join(dir,'resume-refusals.jsonl'),'utf8').trim().split('\n').length,3);
});
test('Incomplete valid JSON pauses with file and missing fields before allocation',async()=>{
 const root=scratch(),s=stage('bad-record',['multi_turn_base_0']),plan=freeze(s,root),job=plan.jobs[0],cid=job.units[0].configId,attempt=join(root,'blocks',job.blockId,cid,'r1/attempt-1'),file=join(attempt,'output/configs',cid,'tasks',job.caseIds[0]+'.r1.json');
 json(join(attempt,'attempt.json'),{number:1,unitId:'u',caseIds:job.caseIds});json(file,{caseId:job.caseIds[0],configId:cid,round:1,status:'completed'});
 const launcher=new LocalProcessLauncher(join(root,'scheduler/units'));await assert.rejects(runSchedule(root,launcher),/modelSteps.*completed/);
 const report=read(join(root,'scheduler/stop-report.json'));assert.equal(report.reason,'invalid-task-record');assert.equal(report.file,file);assert.equal(report.missing.length,2);assert.equal((await launcher.list(s.runId)).length,0);assert(!existsSync(join(root,'egress')));assert.throws(()=>remaining(root,job,cid),/Incomplete final result/);console.log(JSON.stringify(report));
});
test('Incomplete scoring, missing busy intervals and resource scopes are explicit and deterministic',async()=>{
 const root=scratch(),s=stage('partial-scores',['multi_turn_base_0','multi_turn_base_4']),plan=freeze(s,root),job=plan.jobs[0],cid=job.units[0].configId,a=join(root,'blocks',job.blockId,cid,'r1/attempt-1'),dir=join(a,'output/configs',cid);
 json(join(a,'attempt.json'),{number:1,unitId:'u',caseIds:job.caseIds});
 for(const caseId of job.caseIds)json(join(dir,'tasks',caseId+'.r1.json'),{caseId,taskId:`${s.runId}/${cid}/r1/${caseId}`,configId:cid,round:1,status:'completed',modelSteps:[],completed:[],workerEvents:[],assignment:null,elapsedSeconds:2});
 json(join(dir,'block-summary.json'),{tasksStarted:{wall:'2026-11-05T00:00:00Z',ns:'1000000000'},tasksEnded:{wall:'2026-11-05T00:00:10Z',ns:'11000000000'},recordingFailures:{},workerRecordingFailures:{}});
 json(join(dir,'lifecycle.json'),{startupMs:100,shutdownMs:50});
 writeFileSync(join(dir,'resources.jsonl'),[{kind:'cgroup',available:true,at:{wall:'2026-11-05T00:00:00Z'},cpuUs:0,rssBytes:1e9},{kind:'cgroup',available:true,at:{wall:'2026-11-05T00:00:10Z'},cpuUs:1e7,rssBytes:1e9}].map(r=>JSON.stringify(r)).join('\n')+'\n');
 writeFileSync(join(dir,'steps.jsonl'),JSON.stringify({taskId:`${s.runId}/${cid}/r1/${job.caseIds[0]}`,pid:123,workMs:5})+'\n');
 await scoreJob(root,plan,job,{score:async(input,output)=>{if(read(input).caseId===job.caseIds[0]){json(output,{valid:true,officialScoring:true});return {exitCode:0,timedOut:false,stdout:'',stderr:''};}return {exitCode:2,timedOut:false,stdout:'',stderr:'injected'};}});
 const e=exportRun(root,join(root,'export1'));exportRun(root,join(root,'export2'));const r=e.summary[0];assert.equal(r.cpuSeconds,10);assert.equal(r.gbSeconds,10);assert.equal(r.cpuPerComplete,5);assert.equal(r.correct,1);assert.equal(r.goodput,null);assert.equal(r.cpuPerCorrect,null);assert.equal(r.gbPerCorrect,null);assert(r.missing.includes('cpuPerCorrect'));assert(r.missing.some((m:string)=>m.includes('scoring incomplete')));assert.equal(r.startupMs,100);assert.equal(r.shutdownMs,50);assert.equal(r.containerCpuSeconds,null);assert(r.missing.includes('containerCpuSeconds'));
 const w=Array.from(exportRows(join(root,'export1'),'workers'))[0];assert.equal(w.busyFraction,null);assert(w.missing.some((m:string)=>m.includes('started/ended')));
 for(const f of files(join(root,'export1')))assert(readFileSync(f).equals(readFileSync(f.replace('export1','export2'))));console.log(JSON.stringify({root,summary:r,worker:w,byteIdentical:true}));
});
test('Docker sample integral remains separate from uncovered container lifetime',()=>{
 const root=scratch();json(join(root,'logs/exit.json'),{startedAt:'2026-11-05T00:00:00Z',endedAt:'2026-11-05T00:00:10Z'});
 const rows=[0,10].map(t=>({at:`2026-11-05T00:00:${String(t).padStart(2,'0')}Z`,available:true,stdout:JSON.stringify({CPUPerc:'100.0%',MemUsage:'1GB / 4GB'})}));writeFileSync(join(root,'logs/docker-stats.jsonl'),rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
 assert.equal(containerMetrics(root).containerCpuSeconds,10);assert.equal(containerMetrics(root).containerGbSeconds,10);json(join(root,'logs/exit.json'),{startedAt:'2026-11-04T23:59:59Z',endedAt:'2026-11-05T00:00:11Z'});const m=containerMetrics(root);assert.equal(m.containerCpuSeconds,null);assert.equal(m.containerSampledCpuSeconds,10);assert(m.containerMissing.length);console.log(JSON.stringify(m));
 writeFileSync(join(root,'logs/docker-stats-errors.jsonl'),JSON.stringify({error:'injected sampling failure'})+'\n');assert.equal(containerMetrics(root).containerSampledCpuSeconds,null);assert(containerMetrics(root).containerMissing.some(s=>s.includes('sampling failures')));
});
