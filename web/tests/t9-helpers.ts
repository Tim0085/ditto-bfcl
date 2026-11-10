import {spawn} from 'node:child_process';
import {join} from 'node:path';
import {existsSync} from 'node:fs';
import {read,json,lines,files,sleep,env,ROOT,maybe} from '../src/ts/scheduler/io.ts';
import {attempts} from '../src/ts/scheduler/records.ts';
import type {Plan} from '../src/ts/scheduler/plan.ts';
// The main-experiment layout, written exactly as in the T9 task book.
export const mainLanes=[
 [['direct-c1','mono-1-c1','mono-8-c1','uniform-8-c1','targeted-8-c1']],
 [['direct-c4','mono-4-c4','mono-8-c4','uniform-8-c4','targeted-8-c4','uniform-16-c4','targeted-7-c4'],
  ['direct-c8','mono-8-c8','uniform-8-c8','targeted-8-c8','uniform-32-c8','targeted-11-c8']],
];
export async function until(predicate:()=>boolean|Promise<boolean>,message:string,limit=240000){for(const end=Date.now()+limit;;){if(await predicate())return;if(Date.now()>end)throw Error('Timed out: '+message);await sleep(100);}}
/** One scheduler process through the existing fixture runner; output is kept next to the run. */
export function launch(root:string,runRoot:string,options:any,label:string){
 const path=join(root,label+'-options.json');json(path,options,true);const args=['--experimental-transform-types','tests/t8c-runner.ts',runRoot,path];
 const child=spawn(process.execPath,args,{cwd:ROOT,windowsHide:true,env:env(join(root,'guards',label)),stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
 const done=new Promise<number|null>((yes,no)=>{child.once('error',no);child.once('close',code=>{json(join(root,label+'-process.json'),{command:['node',...args],pid:child.pid,code,stdout,stderr},true);yes(code);});});
 return {child,done};
}
export const events=(runRoot:string)=>lines(join(runRoot,'scheduler','events.jsonl'));
export const groupStarted=(runRoot:string,job:string,lane:number,laneGroup:number)=>events(runRoot).some(e=>e.kind==='group-start'&&e.job===job&&e.lane===lane&&e.laneGroup===laneGroup);
export const unitExited=(runRoot:string,job:string,cid:string)=>events(runRoot).some(e=>e.kind==='unit-exit'&&e.job===job&&e.configId===cid);
/** Real start and end of every collected unit: the container's or process's own exit record. */
export function windows(runRoot:string,plan:Plan){
 return plan.jobs.flatMap(job=>job.units.flatMap(unit=>attempts(runRoot,job,unit.configId).map(a=>{const exit=maybe<any>(join(a.path,'collected.json'));return {job:job.key,configId:unit.configId,attempt:a.number,lane:a.lane,laneGroup:a.laneGroup,start:Date.parse(exit?.startedAt),end:Date.parse(exit?.endedAt)};})));
}
/** Largest number of units alive at one instant, from the recorded windows alone. */
export function peak(rows:{start:number;end:number}[]){const edges=rows.flatMap(r=>[[r.start,1],[r.end,-1]]).sort((a,b)=>a[0]-b[0]||a[1]-b[1]);let now=0,top=0;for(const [,d] of edges){now+=d;top=Math.max(top,now);}return top;}
export const overlaps=(a:{start:number;end:number}[],b:{start:number;end:number}[])=>Math.min(...a.map(r=>r.end),...b.map(r=>r.end))>Math.max(...a.map(r=>r.start),...b.map(r=>r.start))||a.some(x=>b.some(y=>x.start<y.end&&y.start<x.end));
export const release=(directory:string,name:string)=>join(directory,'release-'+name);
export const exists=existsSync;
export {read,files};
