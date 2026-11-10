import test from 'node:test';
import assert from 'node:assert/strict';
import {join,dirname} from 'node:path';
import {mkdirSync,unlinkSync} from 'node:fs';
import {scratch,stage} from './t8a-helpers.ts';
import {json,read,now,digest} from '../src/ts/scheduler/io.ts';
import {freeze} from '../src/ts/scheduler/plan.ts';
import {runSchedule} from '../src/ts/scheduler/scheduler.ts';
import {failurePause,pendingPauses,authorizePauses} from '../src/ts/scheduler/authorization.ts';
for(const branch of ['adopt-stopped','catch'])test(`M6 ${branch}: deletion cannot hide a fresh failure behind an old receipt`,async()=>{
 const root=scratch(),s=stage('pause-branches',['multi_turn_base_0']);s.egress.backend='fixtures';const plan=freeze(s,root),job=plan.jobs[0],dir=join(root,'scheduler'),cid=job.units[0].configId;
 const old=failurePause(dir,'old',{}),note='pause:'+old+' old authorized';authorizePauses(dir,pendingPauses(dir,note),note);
 const unitId='fresh-failing-unit',a=join(root,'blocks',job.blockId,cid,'r1/attempt-1');
 const unit={unitId,isAlive:async()=>false,stop:async()=>{},kill:async()=>{throw Error('unexpected kill');},wait:async()=>({exitCode:1,signal:null,killed:false,stoppedByPlan:false,oomKilled:null,startedAt:now(),endedAt:now(),summary:{consecutiveFailure:{failureType:'context-error',count:2}}})};
 if(branch==='adopt-stopped'){
  json(join(a,'attempt.json'),{number:1,unitId,caseIds:job.caseIds});json(join(root,'egress/stopped.json'),{reason:'offline adopted stop'});
  const report=await runSchedule(root,{kind:'local-process',toUnitView:s=>s.block,list:async()=>[unitId],adopt:async()=>unit,start:async()=>{throw Error('no start');}});assert.equal(report.reason,'egress-stop');
 }else{
  // Failure pause is saved, then collection publication fails deterministically.
  await assert.rejects(runSchedule(root,{kind:'local-process',toUnitView:s=>s.block,list:async()=>[],adopt:async()=>undefined,start:async spec=>{mkdirSync(join(dirname(spec.outputRoot),'collected.json'));return {...unit,unitId:spec.unitId};}}));
  assert.equal(read(join(dir,'stop-report.json')).reason,'scheduler-error');
 }
 const fresh=branch==='adopt-stopped'?digest(unitId):read(join(a,'attempt.json')).unitId;
 const id=branch==='adopt-stopped'?fresh:digest(fresh),report=read(join(dir,'stop-report.json'));assert(report.pauseIds.includes(old));assert(report.pauseIds.includes(id));
 unlinkSync(join(dir,'failure-pauses',id+'.json'));assert.throws(()=>pendingPauses(dir),/missing.*restore/);
 console.log(JSON.stringify({M6:branch,oldAuthorized:old,newPause:id,pauseIds:report.pauseIds,deletedPauseRefused:true}));
});
