import {join} from 'node:path';
import {existsSync} from 'node:fs';
import {auxiliaryLines,maybe} from './io.ts';
const finite=(v:any)=>typeof v==='number'&&Number.isFinite(v)&&v>=0;
export const copyCount=(copies:any)=>copies?Object.values(copies).reduce<number>((a,b)=>a+Number(b),0):0;
export function containerMetrics(attempt:string){
 const path=join(attempt,'logs','docker-stats.jsonl'),missing:string[]=[],rows=auxiliaryLines(path);
 if(auxiliaryLines(join(attempt,'logs','docker-stats-errors.jsonl')).length)missing.push('docker-stats-errors.jsonl: sampling failures recorded');
 const samples=rows.map(r=>{try{const s=JSON.parse(r.stdout),m=/^([\d.]+)\s*(B|kB|KB|MB|GB|KiB|MiB|GiB|TiB)\s*\//.exec(s.MemUsage),scales:Record<string,number>={B:1,kB:1e3,KB:1e3,MB:1e6,GB:1e9,KiB:1024,MiB:1024**2,GiB:1024**3,TiB:1024**4};return {at:Date.parse(r.at),cpu:Number(String(s.CPUPerc).replace('%',''))/100,rss:m?Number(m[1])*scales[m[2]]:NaN,valid:r.available===true};}catch{return {at:NaN,cpu:NaN,rss:NaN,valid:false};}});
 if(!existsSync(path))missing.push('docker-stats.jsonl unavailable (local-process or not recorded)');
 if(samples.length<2||samples.some(s=>!s.valid||![s.at,s.cpu,s.rss].every(finite)))missing.push('container samples incomplete; scheduler starts collection after observed exit to avoid a Docker wait child holding hung-request pauses open; cgroup task-window totals are authoritative');
 const exit=maybe(join(attempt,'logs','exit.json')),start=Date.parse(exit?.startedAt),end=Date.parse(exit?.endedAt);
 let cpu=0,gb=0,fullCpu=0,fullGb=0;
 for(let i=1;i<samples.length;i++){const a=samples[i-1],b=samples[i],dt=(b.at-a.at)/1000;if(dt<=0){missing.push('container sample times not increasing');continue;}cpu+=(a.cpu+b.cpu)/2*dt;gb+=(a.rss+b.rss)/2/1e9*dt;
  const lo=Math.max(a.at,start),hi=Math.min(b.at,end);if(hi>lo){const fraction=((lo+hi)/2-a.at)/(b.at-a.at),seconds=(hi-lo)/1000;fullCpu+=(a.cpu+(b.cpu-a.cpu)*fraction)*seconds;fullGb+=(a.rss+(b.rss-a.rss)*fraction)/1e9*seconds;}}
 const covered=finite(start)&&finite(end)&&samples.length>=2&&samples[0].at<=start&&samples.at(-1)!.at>=end;
 return {containerCpuSeconds:missing.length||!covered?null:fullCpu,containerGbSeconds:missing.length||!covered?null:fullGb,containerSampledCpuSeconds:missing.length?null:cpu,containerSampledGbSeconds:missing.length?null:gb,containerSampleWindow:missing.length?null:{start:samples[0].at,end:samples.at(-1)!.at},containerMissing:[...missing,...(!covered?['container lifetime not fully covered; full totals unavailable']:[])]};
}
export function taskMetrics(data:any,raw:any[],complete:boolean,group:string){
 const own=raw.filter(r=>r.taskId===data?.taskId),pids=[...new Set(own.map(r=>r.pid).filter(p=>Number.isInteger(p)&&p>0))].sort((a,b)=>a-b);
 const selected=own.filter(r=>r.node==='CONTEXT.SELECT');
 const counts=selected.map(r=>Array.isArray(r.selectedItemIds)?r.selectedItemIds.length:null);
 const missing:string[]=[];
 if(!complete||!pids.length)missing.push('nodeProcessCount: step recording incomplete');
 if(!data||!Object.hasOwn(data,'assignment'))missing.push('fixedAssignment: unavailable');
 else if(group==='Direct')missing.push('fixedAssignment: not applicable for Direct');
 if(!selected.length||counts.some(c=>c===null))missing.push('selectedItemCounts: selectedItemIds not recorded');
 const tools=own.filter(r=>r.node==='INTERACTION.ACT.TOOL'),pythonPids=[...new Set(tools.map(r=>r.pythonPid).filter(p=>Number.isInteger(p)&&p>0))];
 const pidProblem=!complete||!pids.length||own.some(r=>!Number.isInteger(r.pid)||r.pid<=0)?'step recording incomplete or node PID invalid':!tools.length?'tool steps missing':tools.some(r=>!Number.isInteger(r.pythonPid)||r.pythonPid<0)?'tool pythonPid missing or invalid':pythonPids.length!==1?'inconsistent or absent task Python PID':pids.includes(pythonPids[0])?'Python PID overlaps node PID':null;
 if(pidProblem)missing.push('processCount: '+pidProblem);
 return {processCount:pidProblem?null:pids.length+pythonPids.length,nodeProcessCount:complete&&pids.length?pids.length:null,nodePids:pids,fixedAssignment:data&&Object.hasOwn(data,'assignment')?data.assignment:null,assignmentRule:group==='Direct'?'Direct has no Worker assignment':'fixed at task admission; Infer is dynamically selected',selectedItemCounts:selected.length&&counts.every(c=>c!==null)?counts:null,missing};
}
