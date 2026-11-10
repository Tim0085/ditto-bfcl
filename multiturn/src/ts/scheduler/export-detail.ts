import {join} from 'node:path';
import {existsSync,readdirSync} from 'node:fs';
import {read,files} from './io.ts';
import {jsonRows} from './export-stream.ts';
import {sourceRef} from './records.ts';
import type {Plan,PlannedJob} from './plan.ts';
import type {FeeConfirmation} from './export-ledger.ts';
// T9 C1: extra export tables for the release workbook. Everything here is derived from records that
// already exist in a run root; nothing is estimated. Absent values stay null and are listed in missing.
const finite=(v:any):v is number=>typeof v==='number'&&Number.isFinite(v);
export const keyOf=(...parts:any[])=>JSON.stringify(parts);
const quantile=(sorted:Float64Array,p:number)=>{if(!sorted.length)return null;const i=(sorted.length-1)*p,lo=Math.floor(i);return sorted[lo]+(sorted[Math.ceil(i)]-sorted[lo])*(i-lo);};
// Values are kept once, in 64K Float64Array chunks (outside the JS heap): about 8 bytes per step value at
// main-experiment scale. Quantiles are exact (sorted copy at output time), linear interpolation as export.ts.
const CHUNK=65536;
export class Samples{chunks:Float64Array[]=[];count=0;missing=0;
 push(v:any){if(!finite(v)){this.missing++;return;}const i=this.count%CHUNK;if(i===0)this.chunks.push(new Float64Array(CHUNK));this.chunks[this.chunks.length-1][i]=v;this.count++;}
 *values(){let left=this.count;for(const c of this.chunks){const n=Math.min(left,CHUNK);for(let i=0;i<n;i++)yield c[i];left-=n;}}}
export function describe(input:Samples|Samples[]){const list=Array.isArray(input)?input:[input],n=list.reduce((a,s)=>a+s.count,0),missing=list.reduce((a,s)=>a+s.missing,0),v=new Float64Array(n);let k=0,sum=0;
 for(const s of list)for(const x of s.values()){v[k++]=x;sum+=x;}v.sort();
 return {samples:n,missing,expected:n+missing,sum:n?sum:null,mean:n?sum/n:null,p50:quantile(v,.5),p90:quantile(v,.9),p95:quantile(v,.95),p99:quantile(v,.99),max:n?v[n-1]:null};}
export const capabilityOf=(node:any)=>typeof node!=='string'?null:node.startsWith('CONTEXT.')?'Context':node.startsWith('INFER.')?'Infer':node.startsWith('INTERACTION.')?'Interaction':node.startsWith('MEMORY.')?'Memory':null;
const groupKey=(cid:string,category:string,round:number)=>keyOf(cid,category,round);
type Rates={cachedInput:number;uncachedInput:number;output:number};
const cost=(r:Rates|undefined,input:number|null,cached:number|null,output:number|null)=>r&&input!==null&&cached!==null&&output!==null?((input-cached)*r.uncachedInput+cached*r.cachedInput+output*r.output)/1e6:null;
const lowest=(v:number[])=>v.reduce((a,b)=>b<a?b:a,Infinity),highest=(v:number[])=>v.reduce((a,b)=>b>a?b:a,-Infinity);
const addN=(a:number|null,b:number|null)=>a===null||b===null?null:a+b;

/** Latency layers per configuration x category x round; unit is ms throughout. Step layers are merged from Phases. */
const capabilities=['Context','Infer','Interaction','Memory'];
export const latencyLayers=['task_execution','task_sojourn','model_api','model_rate_wait','model_attempt_api','model_attempt_rate_wait','failed_model_attempt_api','failed_model_attempt_rate_wait','retry_cooldown','graph_schedule','ipc','worker_queue','tool_service',
 ...capabilities.flatMap(c=>[c+'_queue',c+'_work'])] as const;
export class Latency{map=new Map<string,Map<string,Samples>>();
 get(key:string,layer:string){return describe(this.map.get(key)?.get(layer)??new Samples());}
 add(key:string,layer:string,value:any){let m=this.map.get(key);if(!m)this.map.set(key,m=new Map());let s=m.get(layer);if(!s)m.set(layer,s=new Samples());s.push(value);}
 *rows(phases:Phases){const keys=new Set([...this.map.keys(),...phases.groupKeys()]);
  for(const key of [...keys].sort()){const [configId,category,round]=JSON.parse(key),m=this.map.get(key),steps=phases.byGroup(key);
   const merged=(field:'graphSchedule'|'ipc'|'queue'|'work',capability?:string)=>{const list=steps.filter(e=>capability===undefined||e.capability===capability).map(e=>e.entry[field]);return list.some(s=>s.count||s.missing)?list:null;};
   for(const layer of latencyLayers){let s:Samples|Samples[]|null|undefined=m?.get(layer);
    if(layer==='graph_schedule')s=merged('graphSchedule');else if(layer==='ipc')s=merged('ipc');else if(layer==='worker_queue')s=merged('queue');
    else{const cap=/^(Context|Infer|Interaction|Memory)_(queue|work)$/.exec(layer);if(cap)s=merged(cap[2] as 'queue'|'work',cap[1]);}
    if(!s)continue;yield {configId,category,round,layer,unit:'ms',...describe(s)};}}}}

/** Four step phases per configuration x category x round x capability x node. Direct has no graph, IPC or queue: those stay empty, not missing. */
type PhaseEntry={steps:number;graphSchedule:Samples;ipc:Samples;queue:Samples;work:Samples};
export class Phases{map=new Map<string,PhaseEntry>();
 add(cid:string,category:string,round:number,row:any,direct=false){if(row.diagnostic)return;const key=keyOf(cid,category,round,capabilityOf(row.node),row.node??null);let e=this.map.get(key);if(!e)this.map.set(key,e={steps:0,graphSchedule:new Samples(),ipc:new Samples(),queue:new Samples(),work:new Samples()});
  e.steps++;if(!direct){e.graphSchedule.push(row.graphScheduleMs);e.ipc.push(row.ipcMs);e.queue.push(row.queueMs);}e.work.push(row.workMs);}
 groupKeys(){return [...this.map.keys()].map(k=>{const [a,b,c]=JSON.parse(k);return keyOf(a,b,c);});}
 byGroup(group:string){const [a,b,c]=JSON.parse(group);return [...this.map.keys()].sort().map(k=>({k,p:JSON.parse(k)})).filter(x=>x.p[0]===a&&x.p[1]===b&&x.p[2]===c).map(x=>({capability:x.p[3],entry:this.map.get(x.k)!}));}
 *rows(){for(const key of [...this.map.keys()].sort()){const [configId,category,round,capability,node]=JSON.parse(key),e=this.map.get(key)!,out:any={configId,category,round,capability,node,steps:e.steps};
  for(const name of ['graphSchedule','ipc','queue','work'] as const){const d=describe(e[name]);out[name+'Samples']=d.samples;out[name+'Missing']=d.missing;out[name+'SumMs']=d.sum;out[name+'MeanMs']=d.mean;out[name+'P95Ms']=d.p95;}yield out;}}}

/** Process CPU and memory per role, from resources.jsonl "processes" rows (1 s), clipped to the task window. */
export function roleOf(p:any){const cmd=String(p.command??'');if(p.role==='worker')return String(p.workerId??'worker').split('-')[0];if(p.role==='main')return /config-main/.test(cmd)?'main':'init';if(p.role==='python')return /docker-entry\.py/.test(cmd)?'entry':'python';return String(p.role??'unknown');}
type RoleAcc={pids:Set<number>;rssSum:number;rssCount:number;peak:number|null;cpu:number;gib:number};
export class Processes{map=new Map<string,RoleAcc>();missing=new Map<string,string[]>();
 addAttempt(cid:string,category:string,round:number,directory:string,start:number|null,end:number|null){
  const key=keyOf(cid,category,round);if(start===null||end===null){this.note(key,'process resources: activity window missing');return;}
  const series=new Map<number,{t:number;cpu:number;rss:number;role:string}[]>();let unavailable=0;
  for(const r of jsonRows(join(directory,'resources.jsonl'))){if(r.kind!=='processes')continue;if(r.available!==true)unavailable++;const t=Date.parse(r.at?.wall);if(!Number.isFinite(t)||!Array.isArray(r.rows))continue;
   for(const p of r.rows){if(!Number.isInteger(p.pid)||!finite(p.cpuSeconds)||!finite(p.rssBytes))continue;let s=series.get(p.pid);if(!s)series.set(p.pid,s=[]);s.push({t,cpu:p.cpuSeconds,rss:p.rssBytes,role:roleOf(p)});}}
  if(unavailable)this.note(key,`process resources: ${unavailable} process sample(s) unavailable or partial`);
  for(const [pid,s] of [...series].sort((a,b)=>a[0]-b[0])){const role=s[0].role,acc=this.acc(cid,category,round,role);let seen=false;
   for(const x of s)if(x.t>=start&&x.t<=end){seen=true;acc.rssSum+=x.rss;acc.rssCount++;acc.peak=acc.peak===null?x.rss:Math.max(acc.peak,x.rss);}
   for(let i=1;i<s.length;i++){const a=s[i-1],b=s[i],lo=Math.max(a.t,start),hi=Math.min(b.t,end),dt=Math.max(0,hi-lo);if(b.t<=a.t||!dt)continue;seen=true;acc.cpu+=(b.cpu-a.cpu)*dt/(b.t-a.t);const f=((lo+hi)/2-a.t)/(b.t-a.t);acc.gib+=(a.rss+(b.rss-a.rss)*f)/1024**3*dt/1000;}
   if(seen)acc.pids.add(pid);}
 }
 private acc(cid:string,category:string,round:number,role:string){const key=keyOf(cid,category,round,role);let a=this.map.get(key);if(!a)this.map.set(key,a={pids:new Set(),rssSum:0,rssCount:0,peak:null,cpu:0,gib:0});return a;}
 private note(key:string,m:string){const l=this.missing.get(key)??[];if(!l.includes(m))l.push(m);this.missing.set(key,l);}
 *rows(){for(const key of [...this.map.keys()].sort()){const [configId,category,round,role]=JSON.parse(key),a=this.map.get(key)!;
  yield {configId,category,round,role,processCount:a.pids.size,samples:a.rssCount,meanRssBytes:a.rssCount?a.rssSum/a.rssCount:null,peakRssBytes:a.peak,cpuSeconds:a.cpu,gibSeconds:a.gib,missing:this.missing.get(keyOf(configId,category,round))??[]};}}}

/** Score record path, the same selection rule as scoring.ts scoreFor. */
export function scoreFile(root:string,job:PlannedJob,cid:string,caseId:string,path:string){const source=sourceRef(root,path);return files(join(root,'scores',job.key,cid,caseId)).filter(p=>p.endsWith('result.json')).map(p=>({number:Number(/score-(\d+)/.exec(p)?.[1]),path:p,value:read(p)})).filter(r=>r.value.source.sha256===source.sha256).sort((a,b)=>a.number-b.number).at(-1)?.path??null;}
export function officialFailure(official:any){if(!official||official.valid!==false)return {officialFailureType:null,officialFailureMessage:null};
 for(const part of ['official_result','irrelevance_result'])if(official[part]?.valid===false)return {officialFailureType:official[part].error_type??null,officialFailureMessage:official[part].error_message??null};
 return {officialFailureType:null,officialFailureMessage:null};}

export type TaskCost={requests:number;settled:number;unknown:number;confirmedFree:number;confirmedCharged:number;confirmedChargedCny:number;input:number|null;cached:number|null;output:number|null;reasoning:number|null;
 valley:number|null;peak:number|null;usd:number;heldPeakCny:number;heldUsd:number;failedAttempts:number;http429:number;timeouts:number;retries:number;maxBody:number|null;firstRequestAt:number|null};
const taskCost=():TaskCost=>({requests:0,settled:0,unknown:0,confirmedFree:0,confirmedCharged:0,confirmedChargedCny:0,input:0,cached:0,output:0,reasoning:0,valley:0,peak:0,usd:0,heldPeakCny:0,heldUsd:0,failedAttempts:0,http429:0,timeouts:0,retries:0,maxBody:null,firstRequestAt:null});
export type GroupCounts={attempts:number;failed:number;http429:number;timeouts:number;retries:number;cooldowns:number;cooldownMs:number;http429Cooldowns:number};
const groupCounts=():GroupCounts=>({attempts:0,failed:0,http429:0,timeouts:0,retries:0,cooldowns:0,cooldownMs:0,http429Cooldowns:0});

/** One row per reservation, in ledger order (pending ones after, then records without a ledger reservation). */
export function modelRequests(root:string,plan:Plan,confirmations:Map<string,FeeConfirmation>,push:(row:any)=>void,latency:Latency){
 const prices=(plan.stage as any).prices,jobs=new Map<string,PlannedJob>(),perTask=new Map<string,TaskCost>(),groups=new Map<string,GroupCounts>(),jobGroups=new Map<string,GroupCounts>(),jobApis=new Map<string,Samples>(),intervals=new Map<string,number[]>();
 for(const job of plan.jobs)for(const unit of job.units)for(const id of job.caseIds)jobs.set(keyOf(unit.configId,id,job.round),job);
 const dir=join(root,'egress','model-records'),seen=new Set<string>(),pending=new Map<string,any>(),failedKey=new Map<string,string>();let rows=0;
 const emit=(id:string,reserve:any,end:any,ledgerStatus:string)=>{
  const path=join(dir,id+'.json'),rec=existsSync(path)?read(path):null,missing:string[]=[];if(!rec)missing.push('model record unavailable');seen.add(id);
  const taskId=rec?.taskId??reserve?.taskId??null,cid=rec?.configId??reserve?.configId??null,caseId=rec?.caseId??reserve?.caseId??null,round=Number(/\/r(\d+)\//.exec(String(taskId))?.[1]),job=jobs.get(keyOf(cid,caseId,round));
  const u=ledgerStatus==='settled'?end?.usage:null,input=finite(u?.inputTokens)?u.inputTokens:null,cached=finite(u?.cachedInputTokens)?u.cachedInputTokens:null,output=finite(u?.outputTokens)?u.outputTokens:null,reasoning=finite(u?.reasoningTokens)?u.reasoningTokens:null;
  const confirmation=ledgerStatus==='settled'?null:confirmations.get(id)??null,held=ledgerStatus!=='settled'&&ledgerStatus!=='absent'&&!confirmation;
  const tf=rec?.transportFailure,httpStatus=finite(tf?.httpStatus)?tf.httpStatus:finite(rec?.httpStatus)?rec.httpStatus:null,timeout=tf?.timeout===true||/TIMEOUT|ETIMEDOUT/i.test(String(tf?.code??tf?.name??''));
  const body=rec?.requestBody?Buffer.byteLength(JSON.stringify(rec.requestBody),'utf8'):null;if(rec&&body===null)missing.push('requestBodyBytes: requestBody unavailable');
  const started=finite(rec?.requestStartedAt)?rec.requestStartedAt:null,finished=finite(rec?.responseReceivedAt)?rec.responseReceivedAt:started!==null&&finite(rec?.apiMs)?started+rec.apiMs:null;
  const row={reservationId:id,configId:cid,category:job?.category??null,round:Number.isFinite(round)?round:null,blockId:job?.blockId??null,jobKey:job?.key??null,caseId,taskId,turn:rec?.logicalTurn??null,step:rec?.logicalStep??null,retryAttempt:rec?.retryAttempt??null,
   status:rec?.status??null,errorCategory:rec?.errorCategory??null,transportPhase:tf?.phase??null,transportCode:tf?.code??null,httpStatus,timeout:rec?timeout:null,requestStartedAt:started,responseReceivedAt:finite(rec?.responseReceivedAt)?rec.responseReceivedAt:null,
   apiMs:finite(rec?.apiMs)?rec.apiMs:null,rateWaitMs:finite(rec?.rateWaitMs)?rec.rateWaitMs:null,retryDelayMs:finite(rec?.retryDelayMs)?rec.retryDelayMs:null,requestBodyBytes:body,ledgerStatus,
   inputTokens:input,cachedInputTokens:cached,uncachedInputTokens:input!==null&&cached!==null?input-cached:null,outputTokens:output,reasoningTokens:reasoning,
   valleyCny:ledgerStatus==='settled'?cost(prices?.valley,input,cached,output):null,peakCny:ledgerStatus==='settled'?cost(prices?.peak,input,cached,output):null,referenceUsd:ledgerStatus==='settled'&&finite(end?.microUsd)?end.microUsd/1e6:null,
   heldPeakCny:held?(finite(end?.heldMicroCny)?end.heldMicroCny:finite(reserve?.microCny)?reserve.microCny:0)/1e6:null,heldReferenceUsd:held?(finite(end?.heldMicroUsd)?end.heldMicroUsd:finite(reserve?.microUsd)?reserve.microUsd:0)/1e6:null,
   feeConfirmation:confirmation?.conclusion??null,confirmedChargedCny:confirmation?.conclusion==='charged'?confirmation.chargedCny:null,recordFile:rec?'egress/model-records/'+id+'.json':null,missing};
  if(ledgerStatus==='settled'&&input===null)missing.push('usage unavailable in ledger settlement');if(!job)missing.push('no frozen job for this request');
  push(row);rows++;
  if(job){const g=groupKey(cid,job.category,round),jk=keyOf(job.key,cid);for(const [m,k] of [[groups,g],[jobGroups,jk]] as const){let c=m.get(k);if(!c)m.set(k,c=groupCounts());c.attempts++;if(row.status!=="completed")c.failed++;if(httpStatus===429)c.http429++;if(timeout)c.timeouts++;if(finite(row.retryAttempt)&&row.retryAttempt>0)c.retries++;}
   if(row.status==="completed"){let s=jobApis.get(jk);if(!s)jobApis.set(jk,s=new Samples());s.push(row.apiMs);}
   if(row.status!=='completed')failedKey.set(id,g);
   latency.add(g,'model_attempt_api',row.apiMs);latency.add(g,'model_attempt_rate_wait',row.rateWaitMs);
   if(row.status==='completed'){latency.add(g,'model_api',row.apiMs);latency.add(g,'model_rate_wait',row.rateWaitMs);}else{latency.add(g,'failed_model_attempt_api',row.apiMs);latency.add(g,'failed_model_attempt_rate_wait',row.rateWaitMs);if(row.retryDelayMs!==null)latency.add(g,'retry_cooldown',row.retryDelayMs);}
   if(started!==null&&finished!==null){const k=keyOf(job.key,cid);let l=intervals.get(k);if(!l)intervals.set(k,l=[]);l.push(started,finished);}}
  if(taskId){let t=perTask.get(taskId);if(!t)perTask.set(taskId,t=taskCost());t.requests++;
   if(ledgerStatus==='settled'){t.settled++;t.input=addN(t.input,input);t.cached=addN(t.cached,cached);t.output=addN(t.output,output);t.reasoning=addN(t.reasoning,reasoning);t.valley=addN(t.valley,row.valleyCny);t.peak=addN(t.peak,row.peakCny);t.usd+=row.referenceUsd??0;}
   else if(confirmation?.conclusion==='not-charged')t.confirmedFree++;else if(confirmation?.conclusion==='charged'){t.confirmedCharged++;t.confirmedChargedCny+=confirmation.chargedCny!;}
   else if(ledgerStatus!=='absent'){t.unknown++;t.heldPeakCny+=row.heldPeakCny!;t.heldUsd+=row.heldReferenceUsd!;}
   if(row.status!=='completed')t.failedAttempts++;if(httpStatus===429)t.http429++;if(timeout)t.timeouts++;if(finite(row.retryAttempt)&&row.retryAttempt>0)t.retries++;
   if(body!==null)t.maxBody=t.maxBody===null?body:Math.max(t.maxBody,body);if(started!==null)t.firstRequestAt=t.firstRequestAt===null?started:Math.min(t.firstRequestAt,started);}
 };
 const ledger=join(root,'egress','ledger.jsonl');
 for(const r of jsonRows(ledger,true)){if(r.kind==='reserve')pending.set(r.id,r);else if(r.kind==='settle'||r.kind==='retain_failed'){const reserve=pending.get(r.id);pending.delete(r.id);emit(r.id,reserve,r,r.kind==='settle'?'settled':'retained');}}
 for(const [id,reserve] of pending)emit(id,reserve,null,'pending');
 if(existsSync(dir))for(const name of readdirSync(dir).filter(n=>n.endsWith('.json')).sort()){const id=name.slice(0,-5);if(!seen.has(id))emit(id,null,null,'absent');}
 for(const r of jsonRows(join(root,'egress','rate.cooldowns.jsonl'))){const g=failedKey.get(r.reservationId);if(!g)continue;const c=groups.get(g)!;c.cooldowns++;if(finite(r.delayMs))c.cooldownMs+=r.delayMs;if(r.reason==='http_429')c.http429Cooldowns++;}
 return {rows,perTask,groups,jobGroups,intervals,jobApi:(k:string)=>{const d=describe(jobApis.get(k)??new Samples());return {modelApiSamples:d.samples,modelApiP50Ms:d.p50,modelApiP95Ms:d.p95,modelApiMaxMs:d.max};}};
}

/** Peak and time-weighted mean of model requests in flight, per block x configuration and per block (all configurations). */
export function inFlight(intervals:number[]){const ev:[number,number][]=[];let busy=0,lo=Infinity,hi=-Infinity;for(let i=0;i<intervals.length;i+=2){const a=intervals[i],b=Math.max(intervals[i],intervals[i+1]);ev.push([a,1],[b,-1]);busy+=b-a;lo=Math.min(lo,a);hi=Math.max(hi,b);}
 ev.sort((x,y)=>x[0]-y[0]||x[1]-y[1]);let cur=0,peak=0;for(const [,d] of ev){cur+=d;peak=Math.max(peak,cur);}
 return {requests:intervals.length/2,peakInFlight:intervals.length?peak:null,meanInFlight:intervals.length&&hi>lo?busy/(hi-lo):null,firstRequestAt:intervals.length?lo:null,lastResponseAt:intervals.length?hi:null};}

/** Units running at once, OOM kills and host load per block, from scheduler/events.jsonl and host.jsonl. */
export function blockLoad(root:string,plan:Plan,intervals:Map<string,number[]>){
 const events=Array.from(jsonRows(join(root,'scheduler','events.jsonl'))),host=Array.from(jsonRows(join(root,'scheduler','host.jsonl'))).filter(h=>!h.malformed),vm=Array.from(jsonRows(join(root,'scheduler','docker-vm.jsonl'))).filter(v=>!v.malformed);
 return plan.jobs.map(job=>{const starts=events.filter(e=>e.kind==='block-start'&&e.job===job.key),ends=events.filter(e=>e.kind==='block-end'&&e.job===job.key),exits=events.filter(e=>e.kind==='unit-exit'&&e.job===job.key);
  const span=exits.map(e=>[Date.parse(e.startedAt),Date.parse(e.endedAt)]).filter(([a,b])=>Number.isFinite(a)&&Number.isFinite(b));
  const flat:number[]=[];for(const [a,b] of span)flat.push(a,b);const units=inFlight(flat);
  const all:number[]=[];for(const unit of job.units)all.push(...(intervals.get(keyOf(job.key,unit.configId))??[]));const egress=inFlight(all);
  const lo=Date.parse(starts[0]?.at),hi=Date.parse(ends.at(-1)?.at),inside=host.filter(h=>{const t=Date.parse(h.at);return Number.isFinite(lo)&&Number.isFinite(hi)&&t>=lo&&t<=hi;});
  const pick=(f:(h:any)=>any)=>inside.map(f).filter(finite);const free=pick(h=>finite(h.totalMemoryBytes)&&finite(h.usedMemoryBytes)?h.totalMemoryBytes-h.usedMemoryBytes:null),cpu=pick(h=>h.cpuPercent),inVm=vm.filter(v=>{const t=Date.parse(v.at);return Number.isFinite(lo)&&Number.isFinite(hi)&&t>=lo&&t<=hi;}),vmFree=inVm.map(v=>v.approxAvailableBytes).filter(finite),vmUsed=inVm.map(v=>v.containerMemUsedBytes).filter(finite),vmTotal=inVm.map(v=>v.memTotalBytes).filter(finite);
  const missing=[...(!starts.length?['block-start event unavailable']:[]),...(!ends.length?['block-end event unavailable']:[]),...(!inside.length?['host samples unavailable inside block window']:[]),...(!vmFree.length?['Docker VM memory not sampled (scheduler/docker-vm.jsonl, T9 C1 #33)']:[])];
  return {jobKey:job.key,blockId:job.blockId,category:job.category,round:job.round,configs:job.units.length,blockStart:starts[0]?.at??null,blockEnd:ends.at(-1)?.at??null,unitExits:exits.length,maxConcurrentUnits:units.peakInFlight,meanConcurrentUnits:units.meanInFlight,
   oomKilled:exits.filter(e=>e.oomKilled===true).length,killedUnits:exits.filter(e=>e.killed===true).length,egressRequests:egress.requests,egressPeakInFlight:egress.peakInFlight,egressMeanInFlight:egress.meanInFlight,
   hostSamples:inside.length,hostMinFreeMemoryBytes:free.length?lowest(free):null,hostMaxUsedMemoryBytes:free.length?highest(pick(h=>h.usedMemoryBytes)):null,hostMaxCpuPercent:cpu.length?highest(cpu):null,
   dockerVmSamples:inVm.length,dockerVmUnavailableSamples:inVm.filter(v=>v.available!==true).length,dockerVmTotalBytes:vmTotal.length?highest(vmTotal):null,dockerVmMaxContainerMemBytes:vmUsed.length?highest(vmUsed):null,dockerVmMinApproxAvailableBytes:vmFree.length?lowest(vmFree):null,missing};});
}
