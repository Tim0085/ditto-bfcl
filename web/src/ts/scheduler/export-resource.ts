import {join} from 'node:path';
import {jsonRows} from './export-stream.ts';
// T9 C1: totals are integrated from every available cgroup sample; coverage is reported beside them
// instead of nulling the block (user: keep the recorded data, explain shortfalls). The pre-T9 rule
// (first sample at window start, tail within one interval or the legacy 1000ms, no unavailable sample)
// survives unchanged as resourceSamplingOk, and its original missing texts are kept as notes.
export function resource(directory:string,start:number|null,end:number|null,intervalMs:number,legacy:boolean){
 const missing:string[]=[],unavailable:any[]=[],allowance=legacy?1000:intervalMs;let count=0,unavailableSamples=0,first:any,last:any,previous:any,cpu=0,gb=0,malformed=false,coveredMs=0,interiorGapMs=0,peak:number|null=null;
 for(const r of jsonRows(join(directory,'resources.jsonl'))){
  if(r.malformed)malformed=true;
  if(r.available!==true)unavailable.push({kind:r.kind,available:r.available,errors:r.errors,reason:r.reason});
  if(r.kind!=='cgroup')continue;count++;if(r.available!==true){unavailableSamples++;continue;}
  first??=r;last=r;const t=Date.parse(r.at.wall);
  if(start!==null&&end!==null&&t>=start&&t<=end&&Number.isFinite(r.rssBytes))peak=peak===null?r.rssBytes:Math.max(peak,r.rssBytes);
  if(previous&&start!==null&&end!==null){const a=previous,ta=Date.parse(a.at.wall),tb=t,lo=Math.max(ta,start),hi=Math.min(tb,end),dt=Math.max(0,hi-lo);
   if(tb>ta){cpu+=(r.cpuUs-a.cpuUs)/1e6*dt/(tb-ta);const fraction=((lo+hi)/2-ta)/(tb-ta);gb+=(a.rssBytes+(r.rssBytes-a.rssBytes)*fraction)/1e9*dt/1000;coveredMs+=dt;if(dt>0)interiorGapMs=Math.max(interiorGapMs,dt);}}
  previous=r;
 }
 const availability=unavailable.map(r=>({kind:r.kind,available:r.available??false,errors:r.errors??r.reason??'missing'}));
 const availableSamples=count-unavailableSamples;
 if(start===null||end===null||availableSamples<2){if(malformed)missing.push('malformed resource rows');if(start===null||end===null)missing.push('activity window missing');if(availableSamples<2||unavailableSamples)missing.push('cgroup samples incomplete');
  return {cpuSeconds:null,gbSeconds:null,gibSeconds:null,peakRssBytes:peak,resourceCoverage:null,resourceMaxGapMs:null,resourceUnavailableSamples:unavailableSamples,resourceSamples:count,resourceSamplingOk:false,missing,availability:unavailable.map(r=>({kind:r.kind,available:r.available??false,errors:r.errors??r.reason??'disabled'}))};}
 const tailMs=Math.max(0,end-Date.parse(last.at.wall)),startGapMs=Math.max(0,Date.parse(first.at.wall)-start),windowMs=end-start;
 // Same notes as before T9, now beside the values instead of replacing them.
 if(malformed)missing.push('malformed resource rows');if(unavailableSamples)missing.push('cgroup samples incomplete');
 const legacyOk=!malformed&&!unavailableSamples&&startGapMs<=0&&tailMs<=allowance;
 if(startGapMs>0||tailMs>allowance)missing.push(`resource window not fully covered; ${[...(startGapMs>0?[`first sample ${startGapMs}ms after window start`]:[]),...(tailMs>allowance?[`tail gap ${tailMs}ms, allowed ${allowance}ms`]:[])].join('; ')}`);
 else if(tailMs)missing.push(`resource tail gap ${tailMs}ms <= ${legacy?'user-authorized legacy limit':'sampling interval'} ${allowance}ms; totals cover observed samples only, no extrapolation`);
 return {cpuSeconds:cpu,gbSeconds:gb,gibSeconds:gb*1e9/1024**3,peakRssBytes:peak,resourceTailMs:tailMs,resourceTailAllowanceMs:allowance,legacyResourceSampler:legacy,resourceStartGapMs:startGapMs,resourceCoverage:windowMs>0?Math.min(1,coveredMs/windowMs):null,resourceMaxGapMs:Math.max(startGapMs,tailMs,interiorGapMs),resourceUnavailableSamples:unavailableSamples,resourceSamples:count,resourceSamplingOk:legacyOk,missing,availability:legacyOk?unavailable.filter(r=>r.kind==='processes').map(r=>({kind:r.kind,available:r.available,errors:r.reason??'process samples incomplete'})):availability};
}
