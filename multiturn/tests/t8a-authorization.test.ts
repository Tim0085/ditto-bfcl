import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {readFileSync,writeFileSync,existsSync,mkdirSync} from 'node:fs';
import {stage,scratch} from './t8a-helpers.ts';
import {json,read,files,lines,digest,now} from '../src/ts/scheduler/io.ts';
import {freeze} from '../src/ts/scheduler/plan.ts';
import {runSchedule} from '../src/ts/scheduler/scheduler.ts';
import {failurePause,pendingPauses,authorizePauses} from '../src/ts/scheduler/authorization.ts';
import type {RunUnitLauncher} from '../src/ts/run-unit.ts';
function setup(){
 const root=scratch(),s=stage('authorization-fix2',['multi_turn_base_0','multi_turn_base_4','multi_turn_base_10','multi_turn_base_11','multi_turn_base_12','multi_turn_base_13']);s.egress.backend='fixtures';freeze(s,root);
 let starts=0;
 const launcher:RunUnitLauncher={kind:'local-process',list:async()=>[],adopt:async()=>undefined,toUnitView:s=>s.block,start:async spec=>{
  starts++;const b=spec.block;assert(Array.isArray(b.caseIds));assert.equal(typeof b.configId,'string');const configId=b.configId as string;
  for(const caseId of b.caseIds.slice(0,2))json(join(spec.outputRoot,'configs',configId,'failures',caseId+'.r1.json'),{caseId,configId:b.configId,round:1,disposition:'skipped',failureType:'context-error'});
  return {unitId:spec.unitId,isAlive:async()=>false,stop:async()=>{},kill:async()=>{throw Error('Unexpected kill');},wait:async()=>({exitCode:1,signal:null,killed:false,stoppedByPlan:false,oomKilled:null,startedAt:now(),endedAt:now(),summary:{consecutiveFailure:{failureType:'context-error',count:2}}})};
 }};
 return {root,dir:join(root,'scheduler'),launcher,get starts(){return starts;}};
}
const note=(id:string)=>`pause:${id} 授权原文：仅批准这次暂停后恢复`;
function receipt(dir:string,id:string){const p=read(join(dir,'failure-pauses',id+'.json'));return {pauseId:id,pausedAt:p.at,pauseDigest:digest(p),at:now(),authorization:note(id)};}
async function denied(x:ReturnType<typeof setup>,label:string,authorization?:string){
 const n=x.starts,prior=lines(join(x.dir,'resume-refusals.jsonl')).length;
 await assert.rejects(runSchedule(x.root,x.launcher,{resumeAuthorization:authorization}),/needs user authorization/);
 assert.equal(x.starts,n);const rows=lines(join(x.dir,'resume-refusals.jsonl'));assert.equal(rows.length,prior+1);assert(rows.at(-1).reason);
 console.log(JSON.stringify({label,root:x.root,starts:x.starts-n,refusal:rows.at(-1)}));
}
test('Failure -> refusal -> scoped authorization -> second pause refuses first authorization',async()=>{
 const x=setup();assert.equal((await runSchedule(x.root,x.launcher)).reason,'consecutive-failure');assert.equal(x.starts,1);
 const first=read(files(join(x.dir,'failure-pauses'))[0]),stop=readFileSync(join(x.dir,'stop-report.json'));
 await denied(x,'no authorization');await denied(x,'plain old unscoped text','仅批准第一次暂停后恢复');
 assert(stop.equals(readFileSync(join(x.dir,'stop-report.json'))));
 const text=note(first.pauseId);await runSchedule(x.root,x.launcher,{resumeAuthorization:text});assert.equal(x.starts,2);
 const saved=read(join(x.dir,'failure-authorizations',first.pauseId+'.json'));assert.equal(saved.authorization,text);assert.equal(saved.pausedAt,first.at);assert.equal(saved.pauseDigest,digest(first));assert(Number.isFinite(Date.parse(saved.at)));
 const second=files(join(x.dir,'failure-pauses')).map(p=>read(p)).find(p=>p.pauseId!==first.pauseId);assert(second);
 await denied(x,'second pause without authorization');await denied(x,'reuse first scoped original',text);
 const secondFile=join(x.dir,'failure-authorizations',second.pauseId+'.json');json(secondFile,saved);await denied(x,'copy old receipt');
 // Correct filename/ID alone still cannot transplant the original text from the first pause.
 json(secondFile,{...receipt(x.dir,second.pauseId),authorization:text});await denied(x,'old text in otherwise matched receipt');
 console.log(JSON.stringify({normalPath:true,first:saved,second:second.pauseId}));
});
test('Malformed, mismatched and orphan authorization files all refuse before any unit starts',async()=>{
 const variants=['empty-object','empty-file','not-json','null','array','number','wrong-id','id-type','blank-note','note-type','missing-at','invalid-at','impossible-date','future-at','before-pause','wrong-pausedAt','bad-digest','nonexistent-pause','scope-only','wrong-scope'];
 for(const variant of variants){
  const x=setup(),id=failurePause(x.dir,variant,{}),a:any=receipt(x.dir,id);let file=join(x.dir,'failure-authorizations',id+'.json'),raw:string|undefined;
  switch(variant){
   case 'empty-object':raw='{}';break;case 'empty-file':raw='';break;case 'not-json':raw='{';break;case 'null':raw='null';break;case 'array':raw='[]';break;case 'number':raw='3';break;
   case 'wrong-id':a.pauseId=digest('other');break;case 'id-type':a.pauseId=3;break;case 'blank-note':a.authorization=' ';break;case 'note-type':a.authorization={text:'yes'};break;
   case 'missing-at':delete a.at;break;case 'invalid-at':a.at='yesterday';break;case 'impossible-date':a.at='2026-02-30T00:00:00.000Z';break;case 'future-at':a.at='2099-01-01T00:00:00.000Z';break;case 'before-pause':a.at='2020-01-01T00:00:00.000Z';break;
   case 'wrong-pausedAt':a.pausedAt=now()+'bad';break;case 'bad-digest':a.pauseDigest=digest('changed');break;
   case 'nonexistent-pause':a.pauseId=digest('missing');file=join(x.dir,'failure-authorizations',a.pauseId+'.json');break;
   case 'scope-only':a.authorization='pause:'+id;break;case 'wrong-scope':a.authorization=note(digest('old'));break;
  }
  mkdirSync(join(x.dir,'failure-authorizations'),{recursive:true});writeFileSync(file,raw??JSON.stringify(a));const before=readFileSync(file);
  await denied(x,variant);assert(!existsSync(join(x.root,'egress')));assert(before.equals(readFileSync(file)));
  if(variant==='empty-object')await denied(x,'bad record plus fresh input still refuses',note(id));
 }
});
test('Valid receipt reused, multiple pause scope exact, mutated pause rejected at commit',()=>{
 const dir=join(scratch(),'scheduler'),one=failurePause(dir,'one',{}),two=failurePause(dir,'two',{}),text=note(one)+' pause:'+two;
 assert.throws(()=>pendingPauses(dir,note(one)),/authorization/);
 const pending=pendingPauses(dir,text);authorizePauses(dir,pending,text);assert.equal(pendingPauses(dir).length,0);
 const three=failurePause(dir,'three',{});assert.throws(()=>pendingPauses(dir,text),/authorization/);
 const p=pendingPauses(dir,note(three));json(join(dir,'failure-pauses',three+'.json'),{...p[0],details:{edited:true}});
 assert.throws(()=>authorizePauses(dir,p,note(three)),/changed/);assert(!existsSync(join(dir,'failure-authorizations',three+'.json')));
 json(join(dir,'failure-pauses',one+'.json'),{...read<any>(join(dir,'failure-pauses',one+'.json')),details:{edited:true}});assert.throws(()=>pendingPauses(dir,note(three)),/digest mismatch/);
});
test('Legacy consecutive failure with only README in pause directory still requires authorization',async()=>{
 const x=setup();json(join(x.dir,'stop-report.json'),{reason:'consecutive-failure'});mkdirSync(join(x.dir,'failure-pauses'),{recursive:true});writeFileSync(join(x.dir,'failure-pauses/README.txt'),'unrelated note');
 await denied(x,'legacy README does not suppress migration');assert.equal(files(join(x.dir,'failure-pauses')).filter(p=>p.endsWith('.json')).length,1);assert(!existsSync(join(x.root,'egress')));
});
