// T9 C1 #11: report how much of the profiled "Infer" work time is egress rate waiting.
// Read-only. Does not change profile.ts or the published targeted-split.json; it recomputes the
// per-capability work time A with profile.ts's own rows and rules, then the same A with each
// SAMPLE step's modelTiming.rateWaitMs taken out, and runs profile.ts's optimize() on both.
// Usage: node --import ./scripts/egress-offline-guard.mjs --experimental-transform-types scripts/profile-basis.ts --root <2a run root> --output <new json>
import {parseArgs} from 'node:util';
import {join,resolve} from 'node:path';
import {existsSync} from 'node:fs';
import {read,lines,json} from '../src/ts/scheduler/io.ts';
import {categories,capabilities,type Plan} from '../src/ts/scheduler/plan.ts';
import {merged,attempts} from '../src/ts/scheduler/records.ts';
import {optimize} from '../src/ts/scheduler/profile.ts';
import {isSample,reconnect} from '../src/ts/scheduler/reconnect.ts';
import {capabilityOf} from '../src/ts/scheduler/export-detail.ts';
const {values}=parseArgs({options:{root:{type:'string'},output:{type:'string'}}});
if(!values.root||!values.output)throw new Error('--root and --output are required');
const root=resolve(values.root),output=resolve(values.output);if(existsSync(output))throw new Error('Output exists: '+output);
const plan=read<Plan>(join(root,'plan.json')),published=read(join(root,'targeted-split.json'));
const candidates=()=>{const out:number[][]=[];for(let a=1;a<=5;a++)for(let b=1;b<=6-a;b++)for(let c=1;c<=7-a-b;c++){const d=8-a-b-c;if(d>=1)out.push([a,b,c,d]);}return out;};
const objective=(A:Record<string,number>,x:number[])=>Math.max(...capabilities.map((k,i)=>A[k]/x[i]));
const safe=(A:Record<string,number>)=>{try{return optimize(A);}catch(e){return {error:String(e)};}};
const byCategory:Record<string,any>={};
for(const category of categories){
  const A=Object.fromEntries(capabilities.map(k=>[k,0])) as Record<string,number>,rate=Object.fromEntries(capabilities.map(k=>[k,0])) as Record<string,number>;let samples=0,rateMissing=0,retryCooldownMs=0;
  for(const job of plan.jobs.filter(j=>j.category===category)){const cid=job.units[0].configId,history=attempts(root,job,cid),map=merged(root,job,cid),directory=join(history[0].path,'output','configs',cid),rows=lines(join(directory,'steps.jsonl'));
    for(const caseId of job.caseIds){const task=map.get(caseId);
      for(const row of rows.filter(r=>r.taskId===task.data.taskId&&r.graphId&&r.graphId!=='diagnostic')){const cap=capabilityOf(row.node)!,net=reconnect(row);A[cap]+=net.workExcludingConnectRetryMs!;
        if(isSample(row)){samples++;const w=row.modelTiming?.rateWaitMs;if(typeof w==='number'&&Number.isFinite(w))rate[cap]+=w;else rateMissing++;}}}}
  for(const r of lines(join(root,'egress','rate.cooldowns.jsonl'))){const rec=join(root,'egress','model-records',String(r.reservationId)+'.json');if(existsSync(rec)&&String(read(rec).caseId).startsWith(category+'_'))retryCooldownMs+=Number(r.delayMs)||0;}
  const deducted=Object.fromEntries(capabilities.map(k=>[k,A[k]-rate[k]])) as Record<string,number>;
  const before=safe(A),after=safe(deducted),pub=published.byCategory[category];
  byCategory[category]={workMs:A,rateWaitMs:rate,workMinusRateWaitMs:deducted,inferRateWaitShare:A.Infer>0?rate.Infer/A.Infer:null,retryCooldownMsInsideInfer:retryCooldownMs,sampleSteps:samples,sampleStepsWithoutRateWait:rateMissing,
    matchesPublishedA:capabilities.every(k=>Math.abs(A[k]-pub.A[k])<=1e-6*Math.max(1,Math.abs(pub.A[k]))),publishedCopies:pub.copies,
    before,after,sameAllocation:JSON.stringify((before as any).copies)===JSON.stringify((after as any).copies),
    candidates:candidates().map(x=>({copies:Object.fromEntries(capabilities.map((k,i)=>[k,x[i]])),objectiveMs:objective(A,x),objectiveMsAfterRateWait:objective(deducted,x)}))};
}
const cooldowns=lines(join(root,'egress','rate.cooldowns.jsonl'));
const result={version:1,sourceRunId:plan.runId,planHash:plan.hash,rule:'A = sum of steps.jsonl workMs (SAMPLE: minus connectRetryWaitMs, as profile.ts); "after" also subtracts each SAMPLE step modelTiming.rateWaitMs; optimize() from profile.ts unchanged',
  allSame:Object.values(byCategory).every((c:any)=>c.sameAllocation),retryCooldowns:cooldowns.map(c=>({configId:c.configId,reservationId:c.reservationId,delayMs:c.delayMs,reason:c.reason})),
  note:'Egress retry cooldowns are inside the SAMPLE work time as well; they are listed, not deducted, because the dispatch asked for rateWaitMs only.',byCategory};
json(output,result,true);console.log(JSON.stringify({allSame:result.allSame,byCategory:Object.fromEntries(Object.entries(byCategory).map(([k,v]:any)=>[k,{before:v.before.copies,after:v.after.copies,inferRateWaitShare:v.inferRateWaitShare,matchesPublishedA:v.matchesPublishedA}]))}));
