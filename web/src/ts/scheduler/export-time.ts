import {join} from 'node:path';
import {maybe} from './io.ts';

export function activityWindow(attempt:string,summary:any){
 const begin=summary?.tasksStarted,end=summary?.tasksEnded;
 if(begin?.ns&&end?.ns)return {start:Date.parse(begin.wall),end:Date.parse(end.wall),seconds:Number(BigInt(end.ns)-BigInt(begin.ns))/1e9,activeTimeSource:'block-summary monotonic task window',activeTimeMissing:[]};
 const exit=maybe(join(attempt,'collected.json'))??maybe(join(attempt,'logs','exit.json'));
 const start=Date.parse(begin?.wall??exit?.startedAt),finish=Date.parse(end?.wall??exit?.endedAt),unitStart=Date.parse(exit?.startedAt);
 // A collected exit is the upper bound of an interrupted activity window.
 // If no task-start survived, count the whole unit lifetime conservatively.
 if(exit&&exit.killed===true&&Number.isFinite(start)&&Number.isFinite(finish)&&Number.isFinite(unitStart)&&start>=unitStart&&finish>=start)
  return {start,end:finish,seconds:(finish-start)/1000,activeTimeSource:begin?.wall?'task-start wall clock to killed unit exit':'killed unit lifetime (task-start unavailable)',activeTimeMissing:[]};
 return {start:Number.isFinite(start)?start:null,end:null,seconds:null,activeTimeSource:null,activeTimeMissing:['activeSeconds: task window missing; no valid killed-unit exit bounds']};
}
