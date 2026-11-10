// T9 segment A, no scheduler lock: lanes validation, cross-attempt join and the resource message.
import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {mkdirSync} from 'node:fs';
import {stage,scratch} from './t8a-helpers.ts';
import {mainLanes} from './t9-helpers.ts';
import {generate,laneOrder,lanePlace,matrix,type StageConfig} from '../src/ts/scheduler/plan.ts';
import {crossAttemptFailures,consecutiveFailure,pauseIdentity} from '../src/ts/scheduler/records.ts';
import {resource} from '../src/ts/scheduler/export-resource.ts';
import {json} from '../src/ts/scheduler/io.ts';
function main(lanes?:unknown):StageConfig{
 const s=stage('t9-core',['web_search_no_snippet_0']);s.configs=matrix().map(c=>c.copies==='profile'?{...c,copies:{Context:2,Infer:2,Interaction:2,Memory:2}}:c);s.batches[0].configs=s.configs.map(c=>c.id);s.blockSize=4;
 if(lanes!==undefined)(s.batches[0] as any).lanes=lanes;return s;
}
const copy=()=>structuredClone(mainLanes);
test('the main-experiment layout freezes and keeps its order',()=>{
 const plan=generate(main(copy()));assert.deepEqual(plan.stage.batches[0].lanes,mainLanes);
 const order=laneOrder(plan,plan.jobs[0]);assert.deepEqual(order.map(l=>l.map(g=>g.configs.length)),[[5],[7,6]]);
 assert.deepEqual(lanePlace(plan,plan.jobs[0],'direct-c1'),{lane:1,laneGroup:1});assert.deepEqual(lanePlace(plan,plan.jobs[0],'targeted-7-c4'),{lane:2,laneGroup:1});assert.deepEqual(lanePlace(plan,plan.jobs[0],'uniform-32-c8'),{lane:2,laneGroup:2});
});
test('a stage without lanes writes no lanes field and runs as one group',()=>{
 const plan=generate(main());assert.equal(Object.hasOwn(plan.stage.batches[0],'lanes'),false);assert(!JSON.stringify(plan).includes('"lanes"'));
 assert.deepEqual(laneOrder(plan,plan.jobs[0]),[[{configs:plan.jobs[0].units.map(u=>u.configId)}]]);assert.deepEqual(lanePlace(plan,plan.jobs[0],'direct-c1'),{});
});
const rejected:[string,(l:string[][][])=>unknown,RegExp][]=[
 ['missing config',l=>{l[1][1].pop();return l;},/Config targeted-11-c8 of batch test is missing/],
 ['duplicate inside a group',l=>{l[0][0].push('direct-c1');return l;},/Config direct-c1 appears twice/],
 ['duplicate across lanes',l=>{l[1][0].push('direct-c1');return l;},/Config direct-c1 appears twice/],
 ['config outside the batch',l=>{l[0][0].push('ghost-c1');return l;},/name config ghost-c1/],
 ['one tier split into two groups of a lane',l=>{l[1][1].push(l[1][0].pop()!);return l;},/Concurrency 4 is split .*targeted-7-c4/],
 ['one tier split across lanes',l=>{l[0][0].push(l[1][1].pop()!);return l;},/Concurrency 8 is split .*targeted-11-c8/],
 ['one tier split into a second group of its lane',l=>{l[0].push([l[0][0].pop()!]);return l;},/Concurrency 1 is split .*targeted-8-c1/],
 ['empty group',l=>{l[1].push([]);return l;},/Invalid lanes/],
 ['empty lane',l=>{l.push([]);return l;},/Invalid lanes/],
 ['no lanes at all',()=>[],/Invalid lanes/],
 ['null instead of an absent field',()=>null,/Invalid lanes/],
 ['a group that is not a list',()=>[['direct-c1']],/Invalid lanes/],
];
for(const [name,change,message] of rejected)test('freeze refuses: '+name,()=>{assert.throws(()=>generate(main(change(copy()))),message);});
test('other legal layouts: one lane in sequence, three lanes side by side',()=>{
 const flat=mainLanes.flat();assert.equal(generate(main([flat])).stage.batches[0].lanes!.length,1);assert.equal(generate(main(flat.map(g=>[g]))).stage.batches[0].lanes!.length,3);
});
// Each record uses the fields T7 really writes: tasks carry finishedAt, failures ended.wall.
function results(rows:[number,string,string|null,number,string?][]){
 const root=scratch(),job:any={key:'r1-b',blockId:'b',round:1,caseIds:rows.map(r=>r[1]),units:[]},cid='cfg';
 for(const [attempt,caseId,failureType,at,disposition] of rows){
  const path=join(root,'blocks/b',cid,'r1',`attempt-${attempt}`),directory=join(path,'output/configs',cid);mkdirSync(directory,{recursive:true});
  json(join(path,'attempt.json'),{number:attempt,unitId:'u'+attempt,caseIds:[]});
  if(failureType===null)json(join(directory,'tasks',caseId+'.r1.json'),{caseId,configId:cid,round:1,modelSteps:[],completed:[],status:'completed',finishedAt:at});
  else json(join(directory,'failures',caseId+'.r1.json'),{caseId,configId:cid,round:1,disposition:disposition??'skipped',failureType,streak:1,ended:{wall:new Date(at).toISOString()}});
 }
 return {root,job,cid};
}
const pairs=(rows:Parameters<typeof results>[0])=>{const x=results(rows);return crossAttemptFailures(x.root,x.job,x.cid).map(p=>[p.failureType,p.earlier.caseId,p.later.caseId,p.later.attempt]);};
test('cross-attempt join',()=>{
 assert.deepEqual(pairs([[1,'a','context-error',10],[2,'b','context-error',20]]),[['context-error','a','b',2]],'last failure of attempt 1 meets first of attempt 2');
 assert.deepEqual(pairs([[1,'a','context-error',10],[1,'b',null,15],[2,'c','context-error',20]]),[],'a completed task in attempt 1 separates them');
 assert.deepEqual(pairs([[1,'a','context-error',10],[2,'b',null,15],[2,'c','context-error',20]]),[],'a completed task in attempt 2 separates them');
 assert.deepEqual(pairs([[1,'a','context-error',10],[2,'b','tool-channel',20]]),[],'different types are not the same failure');
 assert.deepEqual(pairs([[1,'a','context-error',10],[2,'b','tool-channel',20],[2,'c','context-error',30]]),[['context-error','a','c',2]],'a skipped task of another type is not a completed task');
 assert.deepEqual(pairs([[1,'a','context-error',10],[2,'x','context-error',15,'interrupted'],[2,'c','context-error',20]]),[['context-error','a','c',2]],'an interrupted task does not separate them');
 assert.deepEqual(pairs([[1,'a','context-error',10],[1,'b',null,5],[2,'c','context-error',20]]),[['context-error','a','c',2]],'order inside an attempt is end time, not file name');
 assert.deepEqual(pairs([[1,'a','context-error',10],[1,'b','tool-channel',12],[1,'c','context-error',14]]),[],'inside one attempt T7 alone decides');
 assert.deepEqual(pairs([[1,'a','context-error',10],[2,'b','context-error',20],[3,'c','context-error',30]]),[['context-error','a','b',2],['context-error','b','c',3]],'every later repeat is reported against the attempt closing it');
 const one=results([[1,'a','context-error',10]]);assert.deepEqual(crossAttemptFailures(one.root,one.job,one.cid),[]);
});
test('same instant: the failure is ordered before the completion, whatever the case ids',()=>{
 assert.deepEqual(pairs([[1,'a','context-error',10],[2,'b',null,20],[2,'c','context-error',20]]),[['context-error','a','c',2]],'b sorts before c by id, but the failure comes first');
 assert.deepEqual(pairs([[1,'a','context-error',10],[2,'z',null,20],[2,'c','context-error',20]]),[['context-error','a','c',2]],'and the same when the completion sorts last');
 assert.deepEqual(pairs([[1,'a','context-error',10],[2,'b',null,19],[2,'c','context-error',20]]),[],'one millisecond earlier the completion still separates them');
});
test('same instant at the end of the earlier attempt: the completion does not separate its failure from the next attempt',()=>{
 assert.deepEqual(pairs([[1,'a',null,10],[1,'b','context-error',10],[2,'c','context-error',20]]),[['context-error','b','c',2]],'completion a sorts before failure b by id');
 assert.deepEqual(pairs([[1,'z',null,10],[1,'b','context-error',10],[2,'c','context-error',20]]),[['context-error','b','c',2]],'completion z sorts after failure b by id');
 assert.deepEqual(pairs([[1,'a',null,9],[1,'b','context-error',10],[2,'c','context-error',20]]),[['context-error','b','c',2]],'a completion before the failure never separates');
 assert.deepEqual(pairs([[1,'b','context-error',9],[1,'a',null,10],[2,'c','context-error',20]]),[],'a completion one millisecond after the failure still separates them');
 assert.deepEqual(pairs([[1,'a',null,10],[1,'b','context-error',10],[1,'d','tool-channel',10],[2,'c','context-error',20],[2,'e','tool-channel',21]]).map(p=>p[1]+'->'+p[2]),['b->c','d->e'],'every failure of the tied instant is kept');
});
test('pause identity: T7 evidence keeps the unit, cross-attempt evidence is named by its pairs',()=>{
 assert.equal(pauseIdentity('u2',{}),'u2');assert.equal(pauseIdentity('u2',{crossAttempt:[]}),'u2');
 const one=[{failureType:'context-error',later:{caseId:'b'}}],two=[{failureType:'tool-channel',later:{caseId:'c'}},...one];
 assert.equal(pauseIdentity('u2',{crossAttempt:one}),'u2/cross-attempt/context-error/b');
 assert.notEqual(pauseIdentity('u2',{crossAttempt:two}),pauseIdentity('u2',{crossAttempt:one}),'a new pair on the same unit is a new pause');
 assert.equal(pauseIdentity('u2',{crossAttempt:two}),pauseIdentity('u2',{crossAttempt:[...two].reverse()}),'pair order does not matter');
 // The startup scan passes no summary; collection passes the unit's summary. Same files, same name.
 const x=results([[1,'a','context-error',10],[2,'b','context-error',20]]),scope={root:x.root,job:x.job},at2={number:2,unitId:'u2',path:join(x.root,'blocks/b',x.cid,'r1','attempt-2')+'/'};
 const scan=consecutiveFailure(at2,x.cid,undefined,scope)!,collect=consecutiveFailure(at2,x.cid,{},scope)!;
 assert.equal(pauseIdentity('u2',scan),pauseIdentity('u2',collect));assert.equal(pauseIdentity('u2',scan),'u2/cross-attempt/context-error/b');
 assert.equal(pauseIdentity('u2',consecutiveFailure(at2,x.cid,{consecutiveFailure:{failureType:'context-error',caseIds:['b','c']}},scope)!),'u2','T7 evidence keeps the old identity');
});
test('an attempt whose configuration never started is skipped, even when its tasks is a file',()=>{
 const rows:[number,string,string|null,number][]=[[1,'a','context-error',10],[3,'c','context-error',30]];
 const without=results(rows),expected=crossAttemptFailures(without.root,without.job,without.cid).map(p=>[p.failureType,p.earlier.caseId,p.later.caseId,p.later.attempt]);
 assert.deepEqual(expected,[['context-error','a','c',3]]);
 const x=results(rows),path=join(x.root,'blocks/b',x.cid,'r1','attempt-2'),fs=process.getBuiltinModule('node:fs');
 json(join(path,'attempt.json'),{number:2,unitId:'u2',caseIds:[]});json(join(path,'collected.json'),{exitCode:2,summary:null});
 fs.mkdirSync(join(path,'output/configs',x.cid),{recursive:true});fs.writeFileSync(join(path,'output/configs',x.cid,'tasks'),'t8c startup fixture');
 assert.deepEqual(crossAttemptFailures(x.root,x.job,x.cid).map(p=>[p.failureType,p.earlier.caseId,p.later.caseId,p.later.attempt]),expected,'same result as without the not-started attempt');
 const at3={number:3,unitId:'u3',path:join(x.root,'blocks/b',x.cid,'r1','attempt-3')+'/'};assert.equal((consecutiveFailure(at3,x.cid,undefined,{root:x.root,job:x.job}) as any).crossAttempt.length,1);
 const at2={number:2,unitId:'u2',path:path+'/'};assert.equal(consecutiveFailure(at2,x.cid,{exitCode:2},{root:x.root,job:x.job}),null,'collecting the not-started attempt itself (the scheduler call that failed) no longer reads its tasks file');
});
test('a pair is attached to the attempt that closes it and leaves older callers unchanged',()=>{
 const x=results([[1,'a','context-error',10],[2,'b','context-error',20]]),scope={root:x.root,job:x.job},at=(n:number)=>({number:n,unitId:'u'+n,path:join(x.root,'blocks/b',x.cid,'r1',`attempt-${n}`)+'/'});
 assert.equal(consecutiveFailure(at(1),x.cid,undefined,scope),null);
 const evidence:any=consecutiveFailure(at(2),x.cid,undefined,scope);assert.equal(evidence.crossAttempt[0].earlier.unitId,'u1');assert.equal(evidence.crossAttempt[0].later.unitId,'u2');assert.deepEqual(evidence.failures,[]);
 assert.equal(consecutiveFailure(at(2),x.cid),null,'the two-argument form stays the per-attempt T7 check');
});
test('resource message names the side that is not covered',()=>{
 const root=scratch(),sample=(at:number)=>({kind:'cgroup',available:true,at:{wall:new Date(at).toISOString()},cpuUs:at*1000,rssBytes:1000}),write=(rows:any[])=>{const d=scratch();json(join(d,'x.json'),{});require_write(d,rows);return d;};
 function require_write(d:string,rows:any[]){const fs=process.getBuiltinModule('node:fs');fs.writeFileSync(join(d,'resources.jsonl'),rows.map(r=>JSON.stringify(r)).join('\n')+'\n');}
 const late=resource(write([sample(1500),sample(2000)]),1000,2000,200,false);assert.deepEqual(late.missing,['resource window not fully covered; first sample 500ms after window start']);
 const tail=resource(write([sample(1000),sample(1500)]),1000,2000,200,false);assert.deepEqual(tail.missing,['resource window not fully covered; tail gap 500ms, allowed 200ms']);
 const both=resource(write([sample(1500),sample(1600)]),1000,2000,200,false);assert.deepEqual(both.missing,['resource window not fully covered; first sample 500ms after window start; tail gap 400ms, allowed 200ms']);
 assert(root);
});
