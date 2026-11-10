import {join,relative} from 'node:path';
import {existsSync,statSync,readFileSync} from 'node:fs';
import {files,read,maybe,json,eachLine,digest,auxiliaryLines} from './io.ts';
import type {PlannedJob} from './plan.ts';
export class RecordValidationError extends Error {
 constructor(readonly file:string,readonly missing:string[]){super(`Incomplete final result: ${file}; ${missing.join('; ')}`);}
}
export function attempts(root:string,job:PlannedJob,cid:string){const base=join(root,'blocks',job.blockId,cid,`r${job.round}`);return files(base).filter(p=>p.endsWith('attempt.json')).map(p=>({...read(p),path:p.slice(0,-'attempt.json'.length)})).sort((a,b)=>a.number-b.number);}
export function configurationNotStarted(attempt:any,cid:string,observedExit?:any){
  const exit=observedExit??maybe(join(attempt.path,'collected.json'))??maybe(join(attempt.path,'logs','exit.json'));
  if(exit?.collection?.neverStarted===true)return true;
  // T7 publishes block.json only after all three output directories exist.
  // A missing block manifest plus CLI exit 2 is a startup failure, not a task failure.
  const directory=join(attempt.path,'output','configs',cid);
  return exit?.exitCode===2&&exit.summary===null&&!existsSync(join(directory,'block.json'))
    &&!files(directory).some(p=>/[\\/](tasks|failures)[\\/].+\.json$/.test(p));
}
export function merged(root:string,job:PlannedJob,cid:string){const result=new Map<string,any>();for(const attempt of attempts(root,job,cid)){
  if(configurationNotStarted(attempt,cid))continue;
  const directory=join(attempt.path,'output','configs',cid);
  for(const kind of ['tasks','failures'])for(const path of files(join(directory,kind)).filter(p=>p.endsWith('.json'))){const data=read(path);
    const missing=[!job.caseIds.includes(data?.caseId)&&'caseId: missing or mismatched',data?.configId!==cid&&'configId: missing or mismatched',data?.round!==job.round&&'round: missing or mismatched',...(kind==='tasks'?[!Array.isArray(data?.modelSteps)&&'modelSteps: array required',!Array.isArray(data?.completed)&&'completed: array required',!['completed','terminated'].includes(data?.status)&&'status: completed or terminated required']:[])].filter(Boolean) as string[];
    if(missing.length)throw new RecordValidationError(path,missing);
    if(kind==='failures'&&!['skipped','interrupted'].includes(data.disposition))throw new Error('Missing T7 disposition');
    const previous=result.get(data.caseId);if(previous&&(previous.kind==='tasks'||previous.data.disposition==='skipped'))throw new Error('Duplicate permanent result');
    result.set(data.caseId,{kind,data,path,attempt:attempt.number,unitId:attempt.unitId});
  }
  for(const data of maybe<any[]>(join(attempt.path,'interruptions.json'))??[])if(!result.has(data.caseId)||result.get(data.caseId).data.disposition==='interrupted')result.set(data.caseId,{kind:'failures',data,path:join(attempt.path,'interruptions.json'),attempt:attempt.number,unitId:attempt.unitId});
}return result;}
export function remaining(root:string,job:PlannedJob,cid:string){const map=merged(root,job,cid);return job.units.find(u=>u.configId===cid)!.caseIds.filter(id=>!map.has(id)||map.get(id).data.disposition==='interrupted');}
// T7 counts a streak inside one attempt, so a stop between two failures would reset it.
// Attempts of one config run one after another, so results are joined in attempt order and
// by each task's end time inside an attempt. A same-type pair is reported when no completed
// task lies between and the two sit in different attempts; inside one attempt T7 decides.
// Results are read through merged(), the same reader remaining() uses: attempts whose configuration
// never started are skipped (their tasks/ may not even be a directory), and a damaged record fails
// with the same error as before T9. Completed tasks and skipped failures are permanent there.
export function crossAttemptFailures(root:string,job:PlannedJob,cid:string){
  if(attempts(root,job,cid).length<2)return [];
  const rows=[...merged(root,job,cid).values()].filter(r=>r.kind==='tasks'||r.data.disposition==='skipped').map(r=>{
    const failureType:string|null=r.kind==='tasks'?null:String(r.data.failureType),at=r.kind==='tasks'?r.data.finishedAt:Date.parse(r.data.ended?.wall);
    return {attempt:r.attempt as number,unitId:r.unitId as string,caseId:r.data.caseId as string,failureType,at:Number.isFinite(at)?at as number:Infinity,path:r.path as string};})
    // Ties: at the same instant the failure sorts first, and a completion does not clear failures of its own
    // attempt and instant (they are put back below). A same-millisecond completion never separates two failures.
    .sort((a,b)=>a.attempt-b.attempt||(a.at===b.at?0:a.at<b.at?-1:1)||(a.failureType===null?1:0)-(b.failureType===null?1:0)||(a.caseId<b.caseId?-1:a.caseId>b.caseId?1:0));
  const latest=new Map<string,(typeof rows)[number]>(),pairs:{failureType:string;earlier:(typeof rows)[number];later:(typeof rows)[number]}[]=[];
  for(const row of rows){
    if(row.failureType===null){latest.clear();for(const tied of rows)if(tied.failureType!==null&&tied.attempt===row.attempt&&tied.at===row.at)latest.set(tied.failureType,tied);continue;}
    const earlier=latest.get(row.failureType);if(earlier&&earlier.attempt!==row.attempt)pairs.push({failureType:row.failureType,earlier,later:row});
    latest.set(row.failureType,row);
  }
  return pairs;
}
export function consecutiveFailure(attempt:any,cid:string,summary?:any,scope?:{root:string;job:PlannedJob}){
  const failures=files(join(attempt.path,'output','configs',cid,'failures')).filter(p=>p.endsWith('.json')).map(p=>({path:p,record:read(p)})).filter(({record:r})=>r.disposition==='skipped'&&Number.isSafeInteger(r.streak)&&r.streak>=2);
  if(summary?.consecutiveFailure||failures.length)return {summary:summary??null,failures};
  // Only without T7 evidence: a pair belongs to the attempt that closes it, so each later repeat
  // needs its own authorization; pauseIdentity names the pause after the pairs.
  const crossAttempt=scope?crossAttemptFailures(scope.root,scope.job,cid).filter(p=>p.later.attempt===attempt.number):[];
  return crossAttempt.length?{summary:summary??null,failures,crossAttempt}:null;
}
// A cross-attempt pair does not stop its unit, so the same live unit can bring new evidence after an
// authorization. T7 evidence keeps the original identity (the unit, which T7 stops); cross-attempt
// evidence is named by its pairs (failure type and the later case), so new pairs need a new authorization.
// Startup scan and collection read the same files and therefore name the same pairs the same way.
export const pauseIdentity=(unitId:string,evidence:{crossAttempt?:{failureType:string;later:{caseId:string}}[]})=>evidence.crossAttempt?.length?unitId+'/cross-attempt/'+evidence.crossAttempt.map(p=>p.failureType+'/'+p.later.caseId).sort().join(','):unitId;
export function activity(directory:string){let latest=0;for(const p of files(directory).filter(p=>/(steps\.jsonl|graphs\.jsonl|tasks[\\/].+\.json|failures[\\/].+\.json)$/.test(p)))latest=Math.max(latest,statSync(p).mtimeMs);return latest;}
export function recordInterrupted(attempt:any,cid:string,job:PlannedJob,root:string,observedExit?:unknown){
  const dir=join(attempt.path,'output','configs',cid),seen=new Set<string>();
  for(const p of files(dir).filter(p=>p.endsWith('.jsonl')&&!p.endsWith('resources.jsonl')))for(const row of auxiliaryLines(p))if(typeof row.taskId==='string')seen.add(row.taskId.split('/').at(-1)!);
  // Recovery timestamps are conservative limiter bounds, never evidence that
  // the old request started in this attempt. Own steps and real new starts
  // still identify interruption; ledger liabilities are untouched.
  const exit:any=observedExit??maybe(join(attempt.path,'logs','exit.json'))??maybe(join(attempt.path,'collected.json'));
  // T10: both files are read a line at a time (eachLine, same rows as lines()); only this configuration's reservations
  // in this round are kept, and only their rate rows. Same result as joining the whole files.
  const started=Date.parse(exit?.startedAt??maybe(join(attempt.path,'logs','control.json'))?.startedAt??''),ended=Date.parse(exit?.endedAt??'')||Infinity,own:any[]=[],sent=new Map<unknown,unknown>();
  eachLine(join(root,'egress','ledger.jsonl'),true,row=>{if(row.configId===cid&&row.taskId?.includes(`/r${job.round}/`))own.push({id:row.id,caseId:row.caseId});});
  const ids=new Set(own.map(r=>r.id));
  eachLine(join(root,'egress','rate.jsonl'),true,r=>{if(r.recovered!==true&&r.at<=ended&&ids.has(r.id))sent.set(r.id,r.at);});
  for(const row of own)if(((sent.get(row.id)??-Infinity) as number)>=started)seen.add(row.caseId);
  const interrupted=attempt.caseIds.filter((caseId:string)=>seen.has(caseId)&&!existsSync(join(dir,'tasks',`${caseId}.r${job.round}.json`))&&!existsSync(join(dir,'failures',`${caseId}.r${job.round}.json`))).map((caseId:string)=>({caseId,configId:cid,round:job.round,disposition:'interrupted',failureType:'scheduler-unit-exit',source:'scheduler',taskId:`${read(join(root,'plan.json')).runId}/${cid}/r${job.round}/${caseId}`}));
  if(!existsSync(join(attempt.path,'interruptions.json')))json(join(attempt.path,'interruptions.json'),interrupted,true);
}
export function sourceRef(root:string,path:string){return {path:relative(root,path).replaceAll('\\','/'),sha256:digest(readFileSync(path,'utf8'))};}
