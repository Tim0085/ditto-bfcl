import {join} from 'node:path';
import type {RunUnit} from '../run-unit.ts';
import type {Plan} from './plan.ts';
import {attempts,activity} from './records.ts';
import {egressDead,inFlightWithRetry} from './egress.ts';
import {log,now,sleep} from './io.ts';
/** Handles are observed wrappers: stop dispatch never waits for unit exit. */
export async function drainUnits(root:string,plan:Plan,running:Map<string,RunUnit>,stuck:Set<string>,events:string,hungMs:number,errors:any[],reason:string){
  const began=Date.now(),safe=new Map<string,number>();
  const owners=new Map(plan.jobs.flatMap(j=>j.units.flatMap(u=>attempts(root,j,u.configId).map(a=>[a.unitId,{cid:u.configId,path:a.path}] as const))));
  for(const unit of running.values())await unit.stop(reason);
  const leave=(unitId:string,details:any)=>{stuck.add(unitId);running.delete(unitId);log(events,{at:now(),kind:'cleanup-abandon-wait',unitId,...details});};
  while(running.size){
    for(const [unitId,unit] of running){
      if(stuck.has(unitId)){running.delete(unitId);continue;}
      try{
        if(!await unit.isAlive()){await unit.wait();running.delete(unitId);continue;}
        const owner=owners.get(unitId),flight=egressDead(root)?0:await inFlightWithRetry(root,owner?.cid);
        if(flight>0){
          safe.delete(unitId);
          const latest=owner?activity(join(owner.path,'output','configs',owner.cid)):0;
          if(Date.now()-Math.max(began,latest)>hungMs)leave(unitId,{inFlight:flight,boundMs:hungMs,reason:'in-flight without progress'});
        }else{
          if(!safe.has(unitId))safe.set(unitId,Date.now());
          if(Date.now()-safe.get(unitId)!>plan.stage.stall.stopGraceMs){await unit.kill('scheduler cleanup after no-in-flight grace');log(events,{at:now(),kind:'cleanup-kill',unitId,inFlight:0});}
        }
      }catch(error){
        const record={at:now(),kind:'cleanup-observation-error',unitId,error:String(error)};errors.push(record);log(events,record);
        // A failed liveness/status/collection check cannot justify killing or closing the egress.
        leave(unitId,{reason:'observation or collection failed',error:String(error)});
      }
    }
    if(running.size)await sleep(plan.stage.stall.pollMs);
  }
}
