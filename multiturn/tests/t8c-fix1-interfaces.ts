import assert from 'node:assert/strict';
import fs from 'node:fs';
import {spawn} from 'node:child_process';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {stage} from './t8a-helpers.ts';
import {freeze} from '../src/ts/scheduler/plan.ts';
import {json,read,env,sleep,alive,now} from '../src/ts/scheduler/io.ts';
import {interruptHungEgress,recoverEgress} from '../src/ts/scheduler/egress.ts';
import {acquireSchedulerLock} from '../src/ts/scheduler/lock.ts';
import {DockerLauncher} from '../src/ts/docker/launcher.ts';
import {docker,labels,assertOwned,inspect} from '../src/ts/docker/common.ts';
if(!process.argv.includes('--scheduler-authorized'))throw Error('Explicit scheduler/Docker handoff required');
const output=resolve(process.argv[2]),tag=process.argv.find(a=>a.startsWith('--tag='))?.slice(6)??'dev';fs.mkdirSync(output,{recursive:true});const results:any={};
async function until(predicate:()=>any,why:string){const end=Date.now()+30000;for(;;){if(await predicate())return;if(Date.now()>end)throw Error('Timed out: '+why);await sleep(20);}}
function fake(root:string,mode:string){
  const path=join(root,'fake-egress.log'),fd=fs.openSync(path,'wx'),args=['--experimental-transform-types','tests/t8c-fix1-fake-egress.ts',root,mode];fs.writeSync(fd,'COMMAND: node '+args.join(' ')+'\n');
  const proc=spawn(process.execPath,args,{windowsHide:true,env:env(join(root,'guards/fake-egress')),stdio:['ignore',fd,fd]});const done=new Promise<number|null>((yes,no)=>{proc.once('error',no);proc.once('close',code=>{fs.writeSync(fd,'\nEXIT_CODE='+code+'\n');fs.closeSync(fd);yes(code);});});return {proc,done};
}
for(const before of [true,false]){
  const root=join(output,before?'stale-before':'stale-after');fs.mkdirSync(root);const s=stage('stale-generation');s.egress.backend='fixtures';freeze(s,root);const child=fake(root,'healthy');
  try{
    await until(()=>fs.existsSync(join(root,'scheduler/egress/control.json'))&&fs.existsSync(join(root,'egress/status.json')),'fake egress ready');
    json(join(root,'scheduler/stop-report.json'),{at:new Date(Date.now()-3600000).toISOString(),runId:s.runId,egressLeftRunning:true,stuckUnits:['old-unit'],status:'paused'});
    if(before){const module=await import(pathToFileURL(resolve('before/src/ts/scheduler/egress.ts')).href);await module.interruptHungEgress(root,'Authorized isolated reproduction of the stale report defect');await child.done;assert(!alive(child.proc.pid!));results.staleBefore={healthyEgressKilled:true};}
    else{await assert.rejects(interruptHungEgress(root,'Authorized isolated regression: stale report must refuse'),/Stale stop report/);assert(alive(child.proc.pid!));results.staleAfter={refused:true,healthyEgressPreserved:true};}
  }finally{if(child.proc.pid&&alive(child.proc.pid)){child.proc.kill('SIGKILL');await child.done;}}
}
{
  const root=join(output,'fresh-heartbeat');fs.mkdirSync(root);const s=stage('fresh-heartbeat');s.egress.backend='fixtures';freeze(s,root);const child=fake(root,'stall-control');
  try{
    await until(()=>fs.existsSync(join(root,'egress/status.json')),'fresh heartbeat');json(join(root,'scheduler/stop-report.json'),{at:now(),runId:s.runId,egressLeftRunning:true,stuckUnits:['old-unit'],status:'paused'});
    await assert.rejects(interruptHungEgress(root,'Authorized isolated regression: timeout alone must refuse'),/Control timeout/);assert(alive(child.proc.pid!));assert(Date.now()-read(join(root,'egress/status.json')).at<5000);results.freshHeartbeat={controlTimedOut:true,heartbeatFresh:true,processPreserved:true};
    const lock=acquireSchedulerLock(root,s.runId);try{await assert.rejects(interruptHungEgress(root,'Authorized isolated lock regression'),/Another scheduler is active/);await assert.rejects(recoverEgress(root,'Authorized isolated lock regression'),/Another scheduler is active/);}finally{lock.release();}results.activeScheduler={interruptRefused:true,recoverRefused:true};
  }finally{if(child.proc.pid&&alive(child.proc.pid)){child.proc.kill('SIGKILL');await child.done;}}
}
{
  const imageId=JSON.parse((await docker(['image','inspect','ditto-sec1-bfcl:'+tag])).stdout)[0].Id,runId='same-run-'+process.pid,unitId='same-unit',containers=new Set<string>();
  const roots=[join(output,'root-a'),join(output,'root-b')],launchers=roots.map(root=>new DockerLauncher(imageId,{clockTicks:100,pageBytes:4096},tag,root));
  try{
    for(let i=0;i<2;i++){
      const root=roots[i],spec={runId,unitId,block:{runId,configId:'direct-c1'},logDir:join(root,'logs'),outputRoot:join(root,'output'),guardReportDir:join(root,'guards'),egressUrl:'http://127.0.0.1:1'};fs.mkdirSync(spec.outputRoot,{recursive:true});json(join(spec.logDir,'unit.json'),{spec,imageId,tag,runtime:{clockTicks:100,pageBytes:4096}});
      const id=(await docker(['create','--pull=never','--network','none','--name',`sec1-t8cf1-root-${process.pid}-${i}`,...labels(runId,unitId),'--label','sec1.log-dir='+spec.logDir,'--init','--memory=32m','--memory-swap=32m','--cpus=.1','--pids-limit=32','--cap-drop=ALL','--security-opt','no-new-privileges',imageId,'python3','-B','-c','import time;time.sleep(300)'])).stdout.trim();containers.add(id);await docker(['start',id]);
    }
    const ids=[...containers],a=(await launchers[0].adopt(runId,unitId))!,b=(await launchers[1].adopt(runId,unitId))!;assert(a&&b);assert(await a.isAlive());assert(await b.isAlive());
    await a.stop('Authorized offline own-root stop');await a.wait();containers.delete(ids[0]);assert(await b.isAlive(),'stopping root A must preserve root B');
    await b.stop('Authorized offline own-root cleanup');await b.wait();containers.delete(ids[1]);results.roots={sameRunId:runId,sameUnitId:unitId,bothAdoptedOnlyOwn:true,foreignPreservedDuringOwnStop:true,removedIds:ids};
  }finally{for(const id of containers){const info=await inspect(id);assertOwned(info,runId,unitId);if(info.State.Running)await docker(['kill',info.Id]);await docker(['rm',info.Id]);}}
}
json(join(output,'verification.json'),{status:'PASS',tag,results},true);console.log(JSON.stringify({status:'PASS',results}));
