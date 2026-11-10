import {join,resolve} from 'node:path';
import {existsSync,openSync,closeSync,unlinkSync,renameSync,writeFileSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import type {RunUnitLauncher,RunUnit,RunUnitExit} from '../run-unit.ts';
import {read,json,maybe,log,now,sleep,alive,ROOT} from './io.ts';
import {checkPlan,laneOrder,lanePlace,type Plan,type PlannedJob} from './plan.ts';
import {attempts,remaining,activity,recordInterrupted,configurationNotStarted,consecutiveFailure,pauseIdentity} from './records.ts';
import {ensureEgress,closeEgress,inFlightWithRetry,egressDead,egressLeftAlive} from './egress.ts';
import {isLivePlan,checkLiveRun,recordLiveRun,type LiveRun} from './live.ts';
import {hostSampler} from './host.ts';
import {control} from './control.ts';
import {HostScorer,scoreJob,type Scorer} from './scoring.ts';
import {acquireSchedulerLock} from './lock.ts';
import {pendingPauses,authorizePauses,failurePause,failurePauseIds} from './authorization.ts';
import {RecordValidationError} from './records.ts';
import {observeLauncher,LauncherOperationError} from './launcher-operations.ts';
import {terminationReport} from './termination.ts';
import {keepAwake} from './awake.ts';
import {drainUnits} from './drain.ts';
export async function runSchedule(root:string,launcher:RunUnitLauncher,options:{scorer?:Scorer;egressImports?:string[];resumeAuthorization?:string;live?:Partial<LiveRun>}={}){
  root=resolve(root);const plan=read<Plan>(join(root,'plan.json'));checkPlan(plan);
  const liveRun=isLivePlan(plan);
  if(!liveRun&&(plan.stage.egress.mode!=='offline-reference'||!['fixtures','replay'].includes(plan.stage.egress.backend)))throw new Error('Real model execution is not authorized');
  if(!liveRun&&options.live)throw new Error('An offline plan must run without --live');
  if(liveRun)checkLiveRun(plan,options.live);
  if(launcher.kind!==(plan.stage.launcher?.kind??'local-process'))throw Error('Launcher differs from frozen stage');
  const directory=join(root,'scheduler');json(join(directory,'owner-request.json'),{pid:process.pid,at:now()});
  // One local scheduler across runs, not merely one per output directory.
  const lock=acquireSchedulerLock(root,plan.runId);let pending:any[]=[],scanFailed=false,scanError:unknown;
  try{
    // Failures are durable before pool.close()/block-summary. A scheduler crash or
    // killed unit must not reset the authorization requirement on the next run.
    // A damaged record found by this scan is thrown again at the start of the run below,
    // so it gets the same stop report as any other run error; nothing is started first.
    try{
      for(const job of plan.jobs)for(const spec of job.units)for(const attempt of attempts(root,job,spec.configId)){
        const evidence=consecutiveFailure(attempt,spec.configId,undefined,{root,job});
        if(evidence)failurePause(directory,pauseIdentity(attempt.unitId,evidence),{job:job.key,configId:spec.configId,unitId:attempt.unitId,...evidence});
      }
    }catch(error){scanFailed=true;scanError=error;}
    // Pending pauses are checked even when the scan failed, as before T9: an unauthorized or
    // lost pause refuses here and the previous stop report stays as it is.
    pending=pendingPauses(directory,options.resumeAuthorization);
    if(liveRun)recordLiveRun(root,plan,options.live as LiveRun);
  }catch(error){lock.release();throw error;}
  if(lock.archived)log(join(directory,'events.jsonl'),{at:now(),kind:'stale-lock-archived',path:lock.archived});
  let stopping=false,reason:string|null=null;const stop=()=>{stopping=true;reason??='planned-stop';};
  const channel=await control(directory,plan.runId+'/scheduler',stop);process.on('SIGTERM',stop);
  const host=await hostSampler(join(directory,'host.jsonl'),plan.stage.hostSampleMs,join(directory,'guards','host'));
  const events=join(directory,'events.jsonl'),scorer=options.scorer??new HostScorer(plan.stage.python,join(directory,'guards','score'));
  let gateway=false;const running=new Map<string,RunUnit>(),stuck=new Set<string>();
  const launcherErrors:any[]=[];const observed=observeLauncher(launcher,events,launcherErrors,stuck);launcher=observed.launcher;
  let awake:Awaited<ReturnType<typeof keepAwake>>|undefined,finalReport:any;
  // T8a fix 6: an in-flight request extends a config's idle window by at most one
  // single request's lifetime (every retry with its model timeout, cooldown and the
  // limiter's 60s wait: the egress slotWork; FIFO admission and budget waits behind
  // other requests are not included) plus one idle window, counted from the config's
  // last recorded progress. Beyond it the request is treated as hung: planned stop
  // and pause. A legitimately longer wait therefore costs one pause, never a kill.
  const egressPolicy=plan.stage.egress,hungMs=((egressPolicy.retryPolicy?.maxRetries??0)+1)*((egressPolicy.settings.model.timeoutMs??600000)+(egressPolicy.dispatchPolicy?.maxCooldownMs??0)+60000)+plan.stage.stall.idleMs;
  try{
    if(scanFailed)throw scanError;
    if(launcher.kind==='docker')awake=await keepAwake(directory);
    // Adopt all registered units before deciding to allocate any new attempt.
    const adopted=new Map<string,RunUnit>();for(const unitId of await launcher.list(plan.runId)){const unit=await launcher.adopt(plan.runId,unitId);if(unit){adopted.set(unitId,unit);running.set(unitId,unit);}}
    if(existsSync(join(root,'egress','stopped.json'))){
      for(const unit of adopted.values()){await unit.stop('adopted after egress stop');log(events,{at:now(),kind:'adopt-stop',unitId:unit.unitId});}
      await drainUnits(root,plan,running,stuck,events,hungMs,launcherErrors,'adopted after egress stop');
      for(const job of plan.jobs)for(const spec of job.units)for(const attempt of attempts(root,job,spec.configId)){const unit=adopted.get(attempt.unitId);if(unit&&!stuck.has(unit.unitId)&&!existsSync(join(attempt.path,'collected.json'))){const exit=await unit.wait(),evidence=consecutiveFailure(attempt,spec.configId,exit.summary,{root,job});if(evidence)failurePause(directory,pauseIdentity(unit.unitId,evidence),{job:job.key,configId:spec.configId,unitId:unit.unitId,...evidence});recordInterrupted(attempt,spec.configId,job,root,exit);json(join(attempt.path,'collected.json'),exit,true);running.delete(unit.unitId);}}
      const ctl=maybe(join(root,'scheduler','egress','control.json'));if(!stuck.size&&ctl&&alive(ctl.pid)&&!existsSync(join(root,'scheduler','egress','exit.json')))await closeEgress(root);
      const report={at:now(),runId:plan.runId,status:'paused',reason:'egress-stop',complete:false,pauseIds:failurePauseIds(directory),...(stuck.size?{stuckUnits:[...stuck],egressLeftRunning:true}:{})};finalReport=report;json(join(directory,'stop-report.json'),report);log(events,{...report,kind:'schedule-end'});return report;
    }
    // Validate all persisted results before granting authorization or starting an egress.
    for(const job of plan.jobs)for(const unit of job.units)remaining(root,job,unit.configId);
    const url=await ensureEgress(root,options.egressImports,liveRun?(options.live as LiveRun).keyFile:undefined);gateway=true;
    authorizePauses(directory,pending,options.resumeAuthorization??'');
    for(const job of plan.jobs){
      const stored=read<Plan>(join(root,'plan.json'));if(stored.hash!==plan.hash)throw new Error('Frozen plan identity changed during execution');checkPlan(stored);
      if(stopping)break;if(existsSync(join(root,'egress','stopped.json'))||egressDead(root)){reason='egress-stop';break;}
      let pause=false;const work:{unit:RunUnit;cid:string;attempt:any;started:number;lastActivity:number;stopAt?:number;safeSince?:number;done?:RunUnitExit;hung?:boolean;deferLogged?:boolean;abandoned?:boolean}[]=[];
      // T9: lanes run side by side, each lane's groups in turn; a stage without lanes is one lane
      // with one group holding every unit. Attempts are numbered here but written only when
      // their group starts, so a group that never starts leaves no attempt behind.
      const lanes=laneOrder(plan,job).map(groups=>groups.map(group=>({...group,entries:[] as {cid:string;unit?:RunUnit;attempt:any}[]})));
      for(const group of lanes.flat())for(const cid of group.configs){const history=attempts(root,job,cid),last=history.at(-1);let unit=last?adopted.get(last.unitId):undefined;
        // A collector may have finished and removed its container just before the scheduler died.
        if(!unit&&last&&launcher.kind==='docker'&&!existsSync(join(last.path,'collected.json'))){const saved=maybe<RunUnitExit>(join(last.path,'logs','exit.json'));if(saved){if(!Object.hasOwn(saved,'summary')||!Object.hasOwn(saved,'exitCode'))throw new RecordValidationError(join(last.path,'logs','exit.json'),['complete exit record required']);unit={unitId:last.unitId,isAlive:async()=>false,stop:async()=>{},kill:async()=>{},wait:async()=>saved};}}
        if(unit&&!existsSync(join(last.path,'collected.json'))){group.entries.push({unit,cid,attempt:last});log(events,{at:now(),kind:'adopt',job:job.key,unitId:unit.unitId});continue;}
        const caseIds=remaining(root,job,cid);if(!caseIds.length)continue;
        const number=history.length+1,path=join(root,'blocks',job.blockId,cid,`r${job.round}`,`attempt-${number}`),unitId=`${plan.runId}-${job.key}-${cid}-a${number}`;
        group.entries.push({cid,attempt:{number,path,unitId,caseIds,nonConcurrent:number>1||history.length>0,...lanePlace(plan,job,cid)}});
      }
      const entries=lanes.flat().flatMap(g=>g.entries);
      log(events,{at:now(),kind:'block-start',job:job.key,configs:entries.map(e=>e.cid),orders:entries.map(e=>({configId:e.cid,caseIds:e.attempt.caseIds})),supplement:entries.some(e=>e.attempt.number>1)});
      // Adopted units already run and must be watched now, so their groups come first together;
      // the rest keep frozen order. Empty groups are skipped.
      const queues=lanes.map(groups=>{const live=groups.filter(g=>g.entries.length),held=live.filter(g=>g.entries.some(e=>e.unit));return [...(held.length?[held]:[]),...live.filter(g=>!held.includes(g)).map(g=>[g])];});
      const waiting=(list=work)=>list.filter(w=>!w.done&&!w.abandoned),laneWork=lanes.map(()=>[] as typeof work);
      // Starts the next group of every lane whose current group is fully collected.
      const advance=async()=>{const launching:typeof work=[];
        for(const [index,queue] of queues.entries()){if(!queue.length||waiting(laneWork[index]).length)continue;laneWork[index]=[];
          for(const group of queue.shift()!){
            // A supplement is judged per group: every comparison stays inside one tier and a tier
            // shares one group. Without lanes the one group is the whole block, as before.
            const supplement=group.entries.length<group.configs.length||group.entries.some(e=>e.attempt.number>1);
            for(const {unit,cid,attempt} of group.entries){let w:(typeof work)[number];
              if(unit)w={unit,cid,attempt,started:Date.now(),lastActivity:Date.now()};
              else{const manifest={...attempt,nonConcurrent:attempt.nonConcurrent||supplement};json(join(attempt.path,'attempt.json'),manifest,true);
                const spec=job.units.find(u=>u.configId===cid)!,config=plan.stage.configs.find(c=>c.id===cid)!,{path,caseIds}=manifest;
                const block={runId:plan.runId,configId:config.id,group:config.group,c:config.c,round:job.round,copies:spec.copies,caseIds,modelEndpoint:url,model:plan.stage.egress.settings.model.model,maxOutputTokens:plan.stage.egress.settings.model.maxOutputTokens,perTaskRequests:plan.stage.egress.perTaskRequests,mode:plan.stage.egress.mode,debug:true,python:plan.stage.python,outputRoot:join(path,'output'),sampling:plan.stage.sampling,egress:plan.stage.egress,startupConcurrency:plan.stage.startupConcurrency};
                // start calls are launched together below; each unit owns its own process tree.
                w={unit:undefined as any,cid,attempt:{...manifest,block},started:Date.now(),lastActivity:Date.now()};
              }
              work.push(w);laneWork[index].push(w);launching.push(w);
            }
            if(group.lane)log(events,{at:now(),kind:'group-start',job:job.key,lane:group.lane,laneGroup:group.laneGroup,configs:group.entries.map(e=>e.cid),orders:group.entries.map(e=>({configId:e.cid,caseIds:e.attempt.caseIds})),supplement});
          }
        }
        const launches=await Promise.allSettled(launching.map(async w=>{if(!w.unit)w.unit=await launcher.start({unitId:w.attempt.unitId,runId:plan.runId,block:w.attempt.block,outputRoot:join(w.attempt.path,'output'),logDir:join(w.attempt.path,'logs'),guardReportDir:join(w.attempt.path,'guards'),egressUrl:url});running.set(w.unit.unitId,w.unit);}));
        const rejected=launches.find(r=>r.status==='rejected');if(rejected?.status==='rejected')throw rejected.reason;
      };
      await advance();
      while(waiting().length){
        if(launcherErrors.length){reason??='unit-launcher-error';pause=true;stopping=true;}
        const egressExit=egressDead(root);const egressStopped=existsSync(join(root,'egress','stopped.json'))||egressExit;if(egressStopped){reason='egress-stop';stopping=true;}
        for(const w of waiting()){
          if(stuck.has(w.unit.unitId)){w.abandoned=true;pause=true;reason??='unit-launcher-error';continue;}
          if(!await w.unit.isAlive()){
            w.done=await w.unit.wait();running.delete(w.unit.unitId);recordInterrupted(w.attempt,w.cid,job,root,w.done);
            const failure=consecutiveFailure(w.attempt,w.cid,w.done.summary,{root,job});
            if(failure)failurePause(directory,pauseIdentity(w.unit.unitId,failure),{job:job.key,configId:w.cid,unitId:w.unit.unitId,...failure});
            json(join(w.attempt.path,'collected.json'),w.done,true);log(events,{at:now(),kind:'unit-exit',job:job.key,configId:w.cid,unitId:w.unit.unitId,...w.done});
            const summary=w.done.summary as any;if(summary?.stopCategory==='出口停止'){reason='egress-stop';stopping=true;}
            if(failure){reason??='consecutive-failure';pause=true;}
            else if(configurationNotStarted(w.attempt,w.cid,w.done)){log(events,{at:now(),kind:'configuration-not-started',job:job.key,configId:w.cid,unitId:w.unit.unitId});reason??='configuration-not-started';pause=true;}
            else if(w.done.exitCode!==0&&!stopping){reason??='unit-failure';pause=true;}continue;
          }
          const latest=activity(join(w.attempt.path,'output','configs',w.cid));w.lastActivity=Math.max(w.lastActivity,latest);
          const flight=egressExit?0:await inFlightWithRetry(root,w.cid);
          // HTTP remains active across FIFO admission, budget wait, retry and
          // cooldown. Give a full idle window after the last observed request.
          if(flight>0){if(Date.now()-Math.max(latest,w.started)<=hungMs){w.lastActivity=Date.now();w.hung=false;}
            else if(!w.hung){w.hung=true;log(events,{at:now(),kind:'in-flight-without-progress',job:job.key,configId:w.cid,unitId:w.unit.unitId,inFlight:flight,lastProgressAt:new Date(Math.max(latest,w.started)).toISOString(),boundMs:hungMs});}}
          const stalled=Date.now()-w.lastActivity>plan.stage.stall.idleMs;
          if((stopping||stalled)&&!w.stopAt){w.stopAt=Date.now();await w.unit.stop(stopping?reason!:'stall');log(events,{at:now(),kind:'planned-stop',unitId:w.unit.unitId,reason:stopping?reason:'stall',inFlight:flight});if(stalled){pause=true;reason??='stall';}}
          if(w.stopAt){if(flight>0){w.safeSince=undefined;if(Date.now()-w.stopAt>plan.stage.stall.stopGraceMs){
              // T8a fix 6: a hung request may never drain, so the stopped unit may never exit.
              // Never kill it (in-flight > 0); stop waiting, pause the run and leave unit and egress running.
              if(w.hung){w.abandoned=true;stuck.add(w.unit.unitId);pause=true;reason??='stall';log(events,{at:now(),kind:'stall-abandon-wait',job:job.key,configId:w.cid,unitId:w.unit.unitId,inFlight:flight});}
              else if(!w.deferLogged){w.deferLogged=true;log(events,{at:now(),kind:'defer-kill',unitId:w.unit.unitId,inFlight:flight});}}}
            else{w.safeSince??=Date.now();if(Date.now()-w.safeSince>plan.stage.stall.stopGraceMs){await w.unit.kill('stop grace elapsed after in-flight drain');log(events,{at:now(),kind:'force-kill',unitId:w.unit.unitId,inFlight:flight});}}
          }
        }
        // Stopping holds every group not started yet; a pause alone lets this block finish
        // (decision 15). Check again here: the stop may have appeared since the top of the loop.
        if(queues.some(q=>q.length)&&!stopping){
          if(launcherErrors.length){reason??='unit-launcher-error';pause=true;stopping=true;}
          else if(existsSync(join(root,'egress','stopped.json'))||egressDead(root)){reason='egress-stop';stopping=true;}
          else await advance();
        }
        if(waiting().length)await sleep(plan.stage.stall.pollMs);
      }
      // An abandoned unit has not finished; its block is scored on the resume that completes it.
      if(!stuck.size)await scoreJob(root,plan,job,scorer);log(events,{at:now(),kind:'block-end',job:job.key,reason});if(pause||stopping)break;
    }
    const complete=plan.jobs.every(j=>j.units.every(u=>remaining(root,j,u.configId).length===0));
    const report={at:now(),runId:plan.runId,status:reason?'paused':complete?'complete':'paused',reason,complete,authorization:options.resumeAuthorization??null,pauseIds:failurePauseIds(directory),...(stuck.size?{stuckUnits:[...stuck],egressLeftRunning:true}:{})};
    finalReport=report;json(join(directory,'stop-report.json'),report);log(events,{...report,kind:'schedule-end'});return report;
  }catch(error){const report={at:now(),runId:plan.runId,status:'paused',reason:error instanceof RecordValidationError?'invalid-task-record':error instanceof LauncherOperationError?'unit-launcher-error':'scheduler-error',error:String(error),pauseIds:failurePauseIds(directory),...(error instanceof RecordValidationError?{file:error.file,missing:error.missing}: {})};finalReport=report;json(join(directory,'stop-report.json'),report);log(events,{...report,kind:'schedule-error'});throw error;}finally{
    // Never close an egress beneath surviving units if orchestration itself fails.
    try{
      // Include partially successful starts and pre-existing adopted units even if start/egress threw.
      for(const unitId of await launcher.list(plan.runId)){const unit=await launcher.adopt(plan.runId,unitId);if(unit)running.set(unitId,unit);}
      for(const unitId of stuck)running.delete(unitId);
      if(running.size)await drainUnits(root,plan,running,stuck,events,hungMs,launcherErrors,'scheduler cleanup');
      // Closing the egress would cut the hung request of an abandoned unit; leave both for the operator.
      if(gateway&&!stuck.size)await closeEgress(root);
    }catch(error){
      for(const unitId of running.keys())stuck.add(unitId);
      // start may create a unit and then lose its reply; a failed list/adopt cannot prove it absent.
      try{for(const job of plan.jobs)for(const spec of job.units)for(const attempt of attempts(root,job,spec.configId))if(!existsSync(join(attempt.path,'collected.json')))stuck.add(attempt.unitId);}
      catch(indexError){launcherErrors.push({at:now(),kind:'cleanup-attempt-index-error',error:String(indexError)});}
      if(finalReport&&gateway)finalReport.egressLeftRunning=true;
      launcherErrors.push({at:now(),kind:'cleanup-error',error:String(error)});log(events,launcherErrors.at(-1));
    }finally{try{
      if(finalReport){finalReport.launcherErrors=launcherErrors;if(stuck.size){finalReport.stuckUnits=[...stuck];finalReport.egressLeftRunning=true;}
        // T9 B: this run never reached the egress, yet it is alive; the report it replaces may have said so.
        if(!gateway&&egressLeftAlive(root))finalReport.egressLeftRunning=true;try{finalReport.terminations=terminationReport(root,plan);}catch(error){finalReport.terminationEvidenceError=String(error);}if(launcherErrors.length&&!finalReport.reason){finalReport.status='paused';finalReport.reason='unit-launcher-error';}json(join(directory,'stop-report.json'),finalReport);}
    }finally{try{await awake?.stop();}finally{await host.stop();channel.close();process.off('SIGTERM',stop);lock.release();}}}
  }
}
