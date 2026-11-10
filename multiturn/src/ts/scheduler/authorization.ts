import {join,basename} from 'node:path';
import {existsSync} from 'node:fs';
import {json,read,maybe,files,digest,now,log} from './io.ts';
type Pause={pauseId:string;at:string;reason:'consecutive-failure';details:unknown};
const object=(v:any)=>v!==null&&typeof v==='object'&&!Array.isArray(v);
const timestamp=(v:unknown):v is string=>typeof v==='string'&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString()===v;
// Explicit scope within the original text; do not guess the meaning of natural language.
function scope(text:unknown){
 if(typeof text!=='string')throw new Error('authorization must be a string');
 const ids=[...text.matchAll(/\bpause:([a-f0-9]{64})\b/g)].map(m=>m[1]);
 if(!ids.length||!text.replace(/\bpause:[a-f0-9]{64}\b/g,'').trim())throw new Error('authorization needs pause:<pauseId> and a nonempty explanation');
 return [...new Set(ids)].sort();
}
function refuse(directory:string,pauseIds:string[],reason:string):never{
 log(join(directory,'resume-refusals.jsonl'),{at:now(),pauseIds,reason});
 throw new Error('Resume after consecutive failures needs user authorization: '+reason);
}
export function failurePause(directory:string,identity:string,details:unknown){
 const pauseId=digest(identity),path=join(directory,'failure-pauses',pauseId+'.json');
 if(!existsSync(path))json(path,{pauseId,at:now(),reason:'consecutive-failure',details},true);
 return pauseId;
}
export function failurePauseIds(directory:string){
 return files(join(directory,'failure-pauses')).filter(p=>p.endsWith('.json')).map(p=>basename(p,'.json'));
}
function inspect(directory:string){
 const pauses=new Map<string,Pause>(),authorized=new Set<string>();
 for(const file of files(join(directory,'failure-pauses')).filter(p=>p.endsWith('.json'))){
  try{const p=read(file);if(!object(p)||typeof p.pauseId!=='string'||!/^[a-f0-9]{64}$/.test(p.pauseId)||basename(file)!==p.pauseId+'.json'||!timestamp(p.at)||p.reason!=='consecutive-failure'||!('details'in p)||pauses.has(p.pauseId))throw Error('invalid pause record');pauses.set(p.pauseId,p);}
  catch(e){refuse(directory,[],`Invalid pause ${file}: ${String(e)}`);}
 }
 for(const file of files(join(directory,'failure-authorizations')).filter(p=>p.endsWith('.json'))){
  try{
   const a=read(file);if(!object(a)||typeof a.pauseId!=='string'||basename(file)!==a.pauseId+'.json')throw Error('pauseId/file mismatch');
   const p=pauses.get(a.pauseId);if(!p)throw Error('authorization points to nonexistent pause');
   if(a.pausedAt!==p.at||a.pauseDigest!==digest(p))throw Error('pause timestamp/digest mismatch');
   if(!timestamp(a.at)||Date.parse(a.at)<Date.parse(p.at)||Date.parse(a.at)>Date.now())throw Error('invalid authorization time');
   const ids=scope(a.authorization);if(!ids.includes(p.pauseId)||ids.some(id=>!pauses.has(id)))throw Error('authorization scope mismatch');
   authorized.add(p.pauseId);
  }catch(e){refuse(directory,[basename(file,'.json')],`Invalid authorization ${file}: ${String(e)}`);}
 }
 return [...pauses.values()].filter(p=>!authorized.has(p.pauseId));
}
function validateInput(directory:string,pending:Pause[],authorization?:string){
 if(!pending.length)return;
 const ids=pending.map(p=>p.pauseId).sort();
 try{if(JSON.stringify(scope(authorization))!==JSON.stringify(ids))throw Error('authorization scope must equal the pending pause IDs');}
 catch(e){refuse(directory,ids,String(e));}
}
export function pendingPauses(directory:string,authorization?:string):Pause[]{
 const prior=maybe(join(directory,'stop-report.json'));
 if(prior?.pauseIds!==undefined){
  if(!Array.isArray(prior.pauseIds)||prior.pauseIds.some((id:any)=>typeof id!=='string'||!/^[a-f0-9]{64}$/.test(id)))refuse(directory,[],'Invalid pause IDs in stop-report.json');
  for(const id of prior.pauseIds)if(!existsSync(join(directory,'failure-pauses',id+'.json')))refuse(directory,[id],'Pause recorded in stop-report.json is missing; restore the original pause record');
 }else if(prior?.reason==='consecutive-failure')failurePause(directory,'legacy:'+digest(prior),prior);
 const pending=inspect(directory);validateInput(directory,pending,authorization);return pending;
}
export function authorizePauses(directory:string,pending:Pause[],authorization:string){
 // Re-read before writing: an edit while egress starts cannot be silently authorized.
 const current=inspect(directory);
 if(digest(current)!==digest(pending))refuse(directory,current.map(p=>p.pauseId),'pause records changed before authorization');
 validateInput(directory,current,authorization);
 for(const pause of current){
  try{json(join(directory,'failure-authorizations',pause.pauseId+'.json'),{pauseId:pause.pauseId,pausedAt:pause.at,pauseDigest:digest(pause),at:now(),authorization},true);}
  catch(e){refuse(directory,[pause.pauseId],'Authorization could not be committed; existing record preserved: '+String(e));}
 }
}
