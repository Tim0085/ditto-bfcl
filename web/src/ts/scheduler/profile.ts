import {isSample,reconnect} from './reconnect.ts';
import {join,resolve} from 'node:path';
import {existsSync,readFileSync} from 'node:fs';
import {isDeepStrictEqual} from 'node:util';
import {createHash} from 'node:crypto';
import {read,lines,json,digest,files,ROOT} from './io.ts';
import {categories,capabilities,profileNumbers,checkPlan,type Plan} from './plan.ts';
import {merged,attempts,sourceRef} from './records.ts';
export function optimize(A:Record<string,number>){
  if(capabilities.some(k=>!Number.isFinite(A[k])||A[k]<0))throw new Error('Missing or invalid profiling time');
  let best:number[]|undefined,minimum=Infinity;
  // Lexicographic tie-break in Context, Infer, Interaction, Memory order.
  for(let a=1;a<=5;a++)for(let b=1;b<=6-a;b++)for(let c=1;c<=7-a-b;c++){const d=8-a-b-c;if(d<1)continue;const allocation=[a,b,c,d],value=Math.max(...capabilities.map((k,i)=>A[k]/allocation[i]));if(value<minimum){minimum=value;best=allocation;}}
  if(best!.every(n=>n===2))throw new Error('Targeted equals Uniform (2/2/2/2); stop and report');
  return {copies:Object.fromEntries(capabilities.map((k,i)=>[k,best![i]])),objectiveMs:minimum};
}
// Every allocation optimize() looks at, smallest objective first. The sort is stable, so ties keep optimize()'s
// enumeration order and the first entry is the allocation optimize() picks (profile() checks this).
export function ranking(A:Record<string,number>){
  if(capabilities.some(k=>!Number.isFinite(A[k])||A[k]<0))throw new Error('Missing or invalid profiling time');
  const all:{copies:Record<string,number>;objectiveMs:number}[]=[];
  for(let a=1;a<=5;a++)for(let b=1;b<=6-a;b++)for(let c=1;c<=7-a-b;c++){const d=8-a-b-c;if(d<1)continue;const allocation=[a,b,c,d];all.push({copies:Object.fromEntries(capabilities.map((k,i)=>[k,allocation[i]])),objectiveMs:Math.max(...capabilities.map((k,i)=>A[k]/allocation[i]))});}
  return all.sort((x,y)=>x.objectiveMs<y.objectiveMs?-1:x.objectiveMs>y.objectiveMs?1:0);
}
const ms=(v:unknown):v is number=>typeof v==='number'&&Number.isFinite(v)&&v>=0;
// Egress retries of one SAMPLE step, from the task record (modelSteps[].output.message.metadata, written by egress/gateway.ts).
// The step keeps only its last, successful attempt: that attempt's own limiter wait and API time. Taken out: the failed
// attempts' API time and limiter wait, the cooldown before the last attempt (the limiter counts it inside that attempt's
// rateWaitMs, so it is the last failure's retryDelayMs, at most that rateWaitMs) and any budget wait (budgetWaitMs).
export function modelRetry(step:any,row:any,cooldowns:any[],where:string){
  const metadata=step?.output?.message?.metadata,timing=metadata?.modelTiming,failures=metadata?.failedModelAttempts??[];
  const bad=(what:string)=>new Error('Invalid profiling model retry record ('+what+'): '+where);
  if(!timing||typeof timing!=='object'||!ms(timing.apiMs)||!ms(timing.rateWaitMs)||(timing.budgetWaitMs!==undefined&&!ms(timing.budgetWaitMs)))throw bad('modelTiming');
  if(row.modelTiming!==undefined&&!isDeepStrictEqual(row.modelTiming,timing))throw bad('steps.jsonl modelTiming differs from the task record');
  if(!Array.isArray(failures)||(metadata.failedModelAttempts!==undefined&&!failures.length))throw bad('failedModelAttempts');
  for(const f of failures){
    if(typeof f?.id!=='string'||!f.id||!ms(f.apiMs)||!ms(f.rateWaitMs)||(f.retryDelayMs!==undefined&&!ms(f.retryDelayMs))
      ||(f.turn!==undefined&&f.turn!==step.turn)||(f.step!==undefined&&f.step!==step.step))throw bad('failed attempt');
    // A retry with a cooldown has exactly one limiter cooldown row (egress/limiter.ts) with the same delay; one without has none.
    const rows=cooldowns.filter(c=>c.reservationId===f.id);
    if(f.retryDelayMs===undefined?rows.length!==0:rows.length!==1||rows[0].delayMs!==f.retryDelayMs)throw bad('rate.cooldowns.jsonl row of '+f.id);
  }
  const sum=(key:string)=>failures.reduce((n:number,f:any)=>n+f[key],0),failedApiMs=sum('apiMs'),failedRateWaitMs=sum('rateWaitMs');
  if(failures.length?timing.retryApiMs!==failedApiMs||timing.retryRateWaitMs!==failedRateWaitMs||timing.physicalAttempts!==failures.length+1
    :timing.retryApiMs!==undefined||timing.retryRateWaitMs!==undefined||timing.physicalAttempts!==undefined)throw bad('retry totals');
  const cooldownMs=failures.length?Math.min(failures.at(-1).retryDelayMs??0,timing.rateWaitMs):0,budgetWaitMs=timing.budgetWaitMs??0;
  return {failedAttempts:failures.length,failedAttemptIds:failures.map((f:any)=>f.id as string),failedApiMs,failedRateWaitMs,cooldownMs,budgetWaitMs,deductMs:failedApiMs+failedRateWaitMs+cooldownMs+budgetWaitMs};
}
// The query web_backend.py (_search_arguments) sends for these tool arguments; undefined when it sends none.
function searchQuery(args:any){
  if(!args||typeof args!=='object'||Array.isArray(args)||Object.keys(args).some(k=>!['keywords','max_results','region'].includes(k)))return;
  return {keywords:args.keywords,max_results:args.max_results??10,region:args.region??'wt-wt'};
}
// Egress retries of the search calls of one task (egress/search.ts writes one search-records file per attempt). web_backend.py
// numbers a call as the n-th search_engine_query tool call of the task in its one Python backend, so call n is the n-th
// search ACT.TOOL row of the task in start order, and its query must equal that row's arguments. The row keeps the last
// attempt; the earlier failed attempts' API time and their cooldowns go (the limiter waits each cooldown before the next
// attempt; search records carry no limiter wait). Failed web fetches are ordinary tool work and stay.
export function searchRetries(taskId:string,taskRows:any[],steps:any[],records:any[],ledger:any[],cooldowns:any[],where:string){
  const bad=(what:string)=>new Error('Profiling search retries cannot be matched ('+what+'): '+where);
  const reserved=new Map(ledger.filter(r=>r.kind==='reserve'&&r.taskId===taskId).map(r=>[r.id,r]));
  const retained=new Set(ledger.filter(r=>r.kind==='retain_failed').map(r=>r.id)),own=new Set(records.map(r=>r.reservationId));
  if(own.size!==records.length||own.size!==reserved.size||[...own].some(id=>!reserved.has(id)))throw bad('search-records and search-ledger.jsonl reservations differ');
  const calls=new Map<number,any[]>();
  for(const r of records){const res=reserved.get(r.reservationId);
    if(r.taskId!==taskId||res.call!==r.call||res.configId!==r.configId||res.caseId!==r.caseId||!Number.isSafeInteger(r.call)||r.call<1||!Number.isSafeInteger(r.attempt)||r.attempt<1||!ms(r.apiMs))throw bad('record '+r.reservationId);
    if(!calls.has(r.call))calls.set(r.call,[]);calls.get(r.call)!.push(r);}
  const out=new Map<string,any>();if(!calls.size)return out;
  const requests=new Map<string,any>();
  for(const step of steps)for(const a of step?.output?.actionRequests??[]){if(typeof a?.id!=='string'||requests.has(a.id))throw bad('missing or repeated tool call id');requests.set(a.id,a);}
  const searches=taskRows.filter(r=>r.node==='INTERACTION.ACT.TOOL'&&r.action==='call').filter(r=>{const a=requests.get(r.toolCallId);if(!a)throw bad('tool call '+r.toolCallId+' not in the task record');return a.name==='search_engine_query';});
  if(searches.some(r=>typeof r.started?.ns!=='string'||!/^\d+$/.test(r.started.ns)||typeof r.invocationId!=='string'||r.pid!==searches[0].pid||r.pythonPid!==searches[0].pythonPid))throw bad('search calls not timed in one Worker and one Python backend');
  searches.sort((x,y)=>{const a=BigInt(x.started.ns),b=BigInt(y.started.ns);return a<b?-1:a>b?1:0;});
  if(new Set(searches.map(r=>r.started.ns)).size!==searches.length)throw bad('two search calls start at the same time');
  for(const [call,list] of [...calls].sort((x,y)=>x[0]-y[0])){list.sort((x,y)=>x.attempt-y.attempt);const row=searches[call-1];
    if(!row||list.some((r,i)=>r.attempt!==i+1||!isDeepStrictEqual(r.query,searchQuery(requests.get(row.toolCallId).arguments))))throw bad('call '+call);
    const failed=list.slice(0,-1);if(!failed.length)continue;
    let cooldownMs=0;
    for(const r of failed){const rows=cooldowns.filter(c=>c.reservationId===r.reservationId);
      if(r.reply?.ok!==false||!retained.has(r.reservationId)||rows.length!==1||!ms(rows[0].delayMs))throw bad('failed attempt '+r.reservationId);cooldownMs+=rows[0].delayMs;}
    const failedApiMs=failed.reduce((n:number,r:any)=>n+r.apiMs,0);
    out.set(row.invocationId,{call,toolCallId:row.toolCallId,failedAttempts:failed.length,failedAttemptIds:failed.map(r=>r.reservationId as string),failedApiMs,cooldownMs,deductMs:failedApiMs+cooldownMs});
  }
  return out;
}
// One run root, with all checks of the single-root program. rawA is the old rule (SAMPLE minus connectRetryWaitMs);
// A also takes out the egress retries above, once per step, never more than the step's remaining workMs.
function measure(root:string){const plan=read<Plan>(join(root,'plan.json')),byCategory:Record<string,any>={};checkPlan(plan,false);
  const used=new Map<string,string|null>(),use=(path:string)=>{if(!used.has(path))used.set(path,existsSync(path)?sourceRef(root,path).sha256:null);};
  const egress=join(root,'egress'),load=(name:string)=>{use(join(egress,name));return lines(join(egress,name));};
  use(join(root,'plan.json'));const ledger=load('ledger.jsonl'),modelCooldowns=load('rate.cooldowns.jsonl'),searchLedger=load('search-ledger.jsonl'),searchCooldowns=load('search-rate.cooldowns.jsonl');
  const reserves=new Map(ledger.filter(r=>r.kind==='reserve').map(r=>[r.id,r])),retainedByTask=new Map<string,string[]>(),searchByTask=new Map<string,any[]>(),measuredTasks=new Set<string>();
  for(const r of ledger.filter(r=>r.kind==='retain_failed')){const taskId=reserves.get(r.id)?.taskId;if(typeof taskId!=='string')throw new Error('egress/ledger.jsonl retain_failed without its reservation: '+r.id);retainedByTask.set(taskId,[...retainedByTask.get(taskId)??[],r.id]);}
  for(const path of files(join(egress,'search-records')).filter(p=>p.endsWith('.json'))){use(path);const r=read(path);searchByTask.set(r?.taskId,[...searchByTask.get(r?.taskId)??[],r]);}
  for(const category of categories){const jobs=plan.jobs.filter(j=>j.category===category);const ids=jobs.flatMap(j=>j.caseIds).sort();if(JSON.stringify(ids)!==JSON.stringify(profileNumbers.map(n=>category+'_'+n).sort()))throw new Error('Profiling requires exactly the fixed 8 cases per category');
    let connectRetries=0,connectRetryWaitMs=0;const A=Object.fromEntries(capabilities.map(k=>[k,0])),rawA=Object.fromEntries(capabilities.map(k=>[k,0])),sources:any[]=[],deductions:any[]=[];
    for(const job of jobs){if(job.round!==1||job.units.length!==1)throw new Error('Invalid profiling round/config');const cid=job.units[0].configId,cfg=plan.stage.configs.find(c=>c.id===cid)!;
      if(cfg.group!=='Uniform'||cfg.c!==1||Object.values(job.units[0].copies!).some(n=>n!==2))throw new Error('Profiling must use Uniform8/c1');
      const history=attempts(root,job,cid);if(history.length!==1)throw new Error('Profiling interrupted or retried; no allocation published');
      const map=merged(root,job,cid);if(map.size!==job.caseIds.length||[...map.values()].some(r=>r.kind!=='tasks'))throw new Error('Profiling has failed/skipped/interrupted/missing cases');
      const directory=join(history[0].path,'output','configs',cid),summary=read(join(directory,'block-summary.json'));
      if(summary.exitCode!==0||summary.failed||summary.notStarted)throw new Error('Profiling did not finish cleanly');
      if(Object.keys(summary.recordingFailures??{}).length||Object.values(summary.workerRecordingFailures??{}).some((r:any)=>Object.keys(r??{}).length))throw new Error('Profiling measurements incomplete; no allocation published');
      const rows=lines(join(directory,'steps.jsonl'));
      for(const caseId of job.caseIds){const task=map.get(caseId);sources.push({runId:plan.runId,...sourceRef(root,task.path)});use(task.path);const found=new Set<string>();
        const taskId=task.data.taskId,where=plan.runId+' '+caseId,taskRows=rows.filter(r=>r.taskId===taskId),steps:any[]=task.data.modelSteps;measuredTasks.add(taskId);
        // SAMPLE rows and model steps are matched one to one by the budget receipt the egress gives each request.
        const byReceipt=new Map<string,any>();
        for(const step of steps){const id=step?.output?.message?.metadata?.budgetReceipt?.id;if(typeof id!=='string'||byReceipt.has(id)||reserves.get(id)?.taskId!==taskId)throw new Error('Profiling model step without its own egress/ledger.jsonl reservation: '+where);byReceipt.set(id,step);}
        const samples=taskRows.filter(isSample);
        if(samples.length!==steps.length||new Set(samples.map(r=>r.budgetReceipt?.id)).size!==samples.length||samples.some(r=>!byReceipt.has(r.budgetReceipt?.id)))throw new Error('Profiling SAMPLE steps do not match the task model steps one to one: '+where);
        // Every failed model attempt of the task is a retain_failed in the egress ledger, and nothing else is.
        const failedIds=steps.flatMap(s=>(s.output.message.metadata.failedModelAttempts??[]).map((f:any)=>f?.id)),retained=retainedByTask.get(taskId)??[];
        if(failedIds.length!==retained.length||new Set(failedIds).size!==failedIds.length||failedIds.some(id=>!retained.includes(id)))throw new Error('Profiling model retries differ from egress/ledger.jsonl retain_failed: '+where);
        const search=searchRetries(taskId,taskRows,steps,searchByTask.get(taskId)??[],searchLedger,searchCooldowns,where);
        for(const row of taskRows.filter(r=>r.graphId&&r.graphId!=='diagnostic')){const capability=row.node?.startsWith('CONTEXT.')?'Context':row.node?.startsWith('INFER.')?'Infer':row.node?.startsWith('MEMORY.')?'Memory':row.node?.startsWith('INTERACTION.')?'Interaction':null;
          if(!capability)throw new Error('Unknown profiling node');if(!Number.isFinite(row.workMs)||row.workMs<0||row.success===false)throw new Error('Invalid/failed profiling measurement');
          const net=reconnect(row);let retry:any;
          if(isSample(row)){if(net.workExcludingConnectRetryMs===null)throw new Error('Missing or invalid profiling connectRetries/connectRetryWaitMs/workMs: '+join(directory,'steps.jsonl')+' task '+task.data.taskId);connectRetries+=net.connectRetries;connectRetryWaitMs+=net.connectRetryWaitMs;
            const step=byReceipt.get(row.budgetReceipt.id);retry={turn:step.turn,step:step.step,budgetReceiptId:row.budgetReceipt.id,...modelRetry(step,row,modelCooldowns,where)};}
          else retry=search.get(row.invocationId);
          const deduct=retry?.deductMs??0;
          if(!(deduct>=0)||deduct>net.workExcludingConnectRetryMs!)throw new Error('Profiling egress retry deduction exceeds the step workMs: '+where+' '+row.invocationId);
          if(deduct)deductions.push({capability,caseId,taskId,node:row.node,invocationId:row.invocationId,workMs:row.workMs,...retry});
          rawA[capability]+=net.workExcludingConnectRetryMs!;A[capability]+=net.workExcludingConnectRetryMs!-deduct;found.add(capability);
        }if(found.size!==4)throw new Error('Profiling capability measurements missing');
        for(const id of search.keys())if(!deductions.some(d=>d.invocationId===id))throw new Error('Profiling search retry on a step that is not measured: '+where);
      }sources.push({runId:plan.runId,...sourceRef(root,join(directory,'steps.jsonl'))});use(join(directory,'steps.jsonl'));
    }
    const deducted=Object.fromEntries(['Infer','Interaction'].map(k=>{const list=deductions.filter(d=>d.capability===k);return [k,{steps:list.length,failedAttempts:list.reduce((n,d)=>n+d.failedAttempts,0),ms:list.reduce((n,d)=>n+d.deductMs,0)}];}));
    const own=ranking(A)[0];
    byCategory[category]={rawA,A,connectRetries,connectRetryWaitMs,deducted,deductions,copies:own.copies,objectiveMs:own.objectiveMs,equalsUniform:Object.values(own.copies).every(n=>n===2),sources};
  }
  // No failed model attempt or search record may belong to a task that was not measured above.
  for(const taskId of [...retainedByTask.keys(),...searchByTask.keys()])if(!measuredTasks.has(taskId))throw new Error('Egress retry or search records of a task outside the profiling cases: '+String(taskId));
  return {root,plan,byCategory,files:[...used].map(([path,sha256])=>({path:path.slice(root.length+1).replaceAll('\\','/'),sha256}))};
}
// The frozen plans of several roots must be the same design: only the runId (and the per-unit seeds and case orders
// derived from it) may differ.
function design(plan:Plan){const {runId,...stage}=plan.stage;
  return {version:plan.version,stage,targeted:plan.targeted,fingerprints:plan.fingerprints,jobs:plan.jobs.map(j=>({...j,units:j.units.map(({seed,caseIds,...u})=>({...u,caseIds:[...caseIds].sort()}))}))};}
export function profile(input:string|string[],output:string){const roots=(Array.isArray(input)?input:[input]).map(r=>resolve(r));
  if(!roots.length)throw new Error('Profiling needs at least one run root');
  if(new Set(roots.map(r=>process.platform==='win32'?r.toLowerCase():r)).size!==roots.length)throw new Error('The same profiling run root is given twice');
  // Summed in runId order, so the order of --root never changes the result.
  const measured=roots.map(measure).sort((x,y)=>x.plan.runId<y.plan.runId?-1:x.plan.runId>y.plan.runId?1:0),first=measured[0].plan,base=design(first);
  if(new Set(measured.map(m=>m.plan.runId)).size!==measured.length)throw new Error('Profiling run roots repeat a runId');
  for(const m of measured){const other=design(m.plan);for(const key of Object.keys(base) as (keyof typeof base)[])if(!isDeepStrictEqual(base[key],other[key]))throw new Error(`Profiling run roots have different frozen plans (${key}): ${first.runId} and ${m.plan.runId}`);}
  const byCategory:Record<string,any>={};
  for(const category of categories){const parts=measured.map(m=>m.byCategory[category]),add=(field:string)=>Object.fromEntries(capabilities.map(k=>[k,parts.reduce((n,p)=>n+p[field][k],0)]));
    const A=parts.length===1?parts[0].A:add('A'),rawA=parts.length===1?parts[0].rawA:add('rawA'),chosen=optimize(A),candidates=ranking(A);
    if(!isDeepStrictEqual(candidates[0].copies,chosen.copies))throw new Error('Profiling ranking disagrees with optimize()');
    byCategory[category]={A,rawA,connectRetries:parts.reduce((n,p)=>n+p.connectRetries,0),connectRetryWaitMs:parts.reduce((n,p)=>n+p.connectRetryWaitMs,0),
      deducted:Object.fromEntries(['Infer','Interaction'].map(k=>[k,{steps:parts.reduce((n,p)=>n+p.deducted[k].steps,0),failedAttempts:parts.reduce((n,p)=>n+p.deducted[k].failedAttempts,0),ms:parts.reduce((n,p)=>n+p.deducted[k].ms,0)}])),
      ...chosen,candidates:candidates.slice(0,5),sources:parts.flatMap(p=>p.sources)};
  }
  // The computing program: sha256 of these two files as run now (same hashing as plan.ts fingerprints()), and per root whether
  // they equal that root's plan fingerprints. Recorded only; a root frozen with other code is not refused.
  const programFiles=Object.fromEntries(['src/ts/scheduler/profile.ts','scripts/t8a.ts'].map(p=>[p,createHash('sha256').update(readFileSync(join(ROOT,p))).digest('hex')]));
  const program={files:programFiles,roots:measured.map(m=>{const same=Object.fromEntries(Object.entries(programFiles).map(([p,h])=>[p,m.plan.fingerprints?.[p]===h]));return {runId:m.plan.runId,matchesPlanFingerprints:Object.values(same).every(Boolean),files:same};})};
  const result={version:1,status:'complete',program,...(measured.length===1?{sourceRunId:first.runId,planHash:first.hash}:{}),sourceRunIds:measured.map(m=>m.plan.runId),sourceMode:first.stage.egress.mode,
    measurement:'steps.jsonl workMs = ended.ns-started.ns; SAMPLE subtracts connectRetryWaitMs exactly once and requires connectRetries/connectRetryWaitMs; SAMPLE also subtracts, exactly once, its egress retries from the task record (modelSteps metadata matched by budgetReceipt id): failed attempts apiMs+rateWaitMs, the cooldown before the last attempt (last failure retryDelayMs, at most the last attempt rateWaitMs) and budgetWaitMs, checked against egress/ledger.jsonl retain_failed and rate.cooldowns.jsonl; an ACT.TOOL search call with egress retries (search-records of the task, call n = n-th search_engine_query call in start order, same query) subtracts its failed attempts apiMs and their cooldowns (search-rate.cooldowns.jsonl delayMs), checked against search-ledger.jsonl; failed web fetches stay as tool work; other nodes unchanged; Worker queue and diagnostic nodes excluded; a deduction never exceeds the step workMs; rawA is the old rule (connect waits only); A sums the deducted time over all run roots in runId order and chooses the allocation; category connectRetryWaitMs reports total deducted',
    tieBreak:'lexicographically smallest [Context,Infer,Interaction,Memory]',
    roots:measured.map(m=>({runId:m.plan.runId,planHash:m.plan.hash,root:m.root,files:m.files,byCategory:Object.fromEntries(Object.entries(m.byCategory).map(([c,v]:[string,any])=>{const {sources,...rest}=v;return [c,rest];}))})),byCategory};
  json(output,result,true);return result;
}
