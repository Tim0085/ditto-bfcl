import type {RunUnitLauncher,RunUnit,RunUnitSpec} from '../run-unit.ts';
import {log,now} from './io.ts';
export class LauncherOperationError extends Error {
  constructor(readonly operation:string,readonly unitId:string|null,cause:unknown){super('Launcher '+operation+(unitId?' '+unitId:'')+': '+String(cause),{cause});}
}
/** stop is dispatched without waiting for exit; monitoring and the no-in-flight kill gate remain with the scheduler. */
export function observeLauncher(source:RunUnitLauncher,events:string,failures:any[],stuck:Set<string>){
  const handles=new Map<string,RunUnit>(),pending=new Set<Promise<void>>(),stops=new Set<string>(),kills=new Map<string,number>();
  const failed=(operation:string,unitId:string|null,error:unknown)=>{
    const record={at:now(),kind:'launcher-error',operation,unitId,error:String(error)};failures.push(record);log(events,record);
    return new LauncherOperationError(operation,unitId,error);
  };
  const call=async<T>(operation:string,unitId:string|null,work:()=>Promise<T>)=>{try{return await work();}catch(error){throw failed(operation,unitId,error);}};
  function wrap(unit:RunUnit):RunUnit{
    const previous=handles.get(unit.unitId);if(previous)return previous;
    let waiting:ReturnType<RunUnit['wait']>|undefined;
    const wait=()=>{
      if(!waiting){
        const began=Date.now();log(events,{at:now(),kind:'collection-start',unitId:unit.unitId});
        waiting=call('wait',unit.unitId,()=>unit.wait()).then(result=>{log(events,{at:now(),kind:'collection-end',unitId:unit.unitId,durationMs:Date.now()-began});return result;});
        waiting.catch(()=>{waiting=undefined;});
      }
      return waiting;
    };
    const wrapped:RunUnit={unitId:unit.unitId,isAlive:()=>call('isAlive',unit.unitId,()=>unit.isAlive()),wait,
      stop:async(reason)=>{
        if(stops.has(unit.unitId))return;stops.add(unit.unitId);
        log(events,{at:now(),kind:'stop-dispatch',unitId:unit.unitId,reason});
        const operation=call('stop',unit.unitId,()=>unit.stop(reason)).then(()=>{log(events,{at:now(),kind:'stop-return',unitId:unit.unitId});},()=>{});
        pending.add(operation);void operation.finally(()=>pending.delete(operation));
      },
      kill:async(reason)=>{
        const count=kills.get(unit.unitId)??0;
        if(count>=3){stuck.add(unit.unitId);return;}
        kills.set(unit.unitId,count+1);
        try{await call('kill',unit.unitId,()=>unit.kill(reason));}catch{if(count+1>=3)stuck.add(unit.unitId);}
      }};
    handles.set(unit.unitId,wrapped);
    // Start wait only after exit is observed. A pending collector owns a Docker wait
    // child, which would otherwise keep a hung-request pause's scheduler alive.
    return wrapped;
  }
  const launcher:RunUnitLauncher={kind:source.kind,toUnitView:spec=>source.toUnitView(spec),
    list:runId=>call('list',null,()=>source.list(runId)),
    adopt:async(runId,unitId)=>{const unit=await call('adopt',unitId,()=>source.adopt(runId,unitId));return unit?wrap(unit):undefined;},
    start:async(spec:RunUnitSpec)=>wrap(await call('start',spec.unitId,()=>source.start(spec)))};
  return {launcher,pending};
}
