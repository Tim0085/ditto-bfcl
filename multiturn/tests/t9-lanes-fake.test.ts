// T9 segment A: the block loop with in-memory units and a real fixture egress. Takes the scheduler lock.
// Covers the branches real containers cannot reach on demand: adoption order, stall, launcher error.
import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {existsSync,writeFileSync,readFileSync} from 'node:fs';
import {stage,scratch} from './t8a-helpers.ts';
import {json,read,lines,now,files,digest,maybe} from '../src/ts/scheduler/io.ts';
import {consecutiveFailure,pauseIdentity,attempts} from '../src/ts/scheduler/records.ts';
import {freeze,matrix,type Plan} from '../src/ts/scheduler/plan.ts';
import {runSchedule} from '../src/ts/scheduler/scheduler.ts';
import type {RunUnitLauncher} from '../src/ts/run-unit.ts';
const scorer={score:async()=>({exitCode:0,timedOut:false,stdout:'',stderr:''})};
const layout=[[['direct-c1']],[['direct-c4','mono-4-c4'],['direct-c8']]];
function setup(name:string,lanes:string[][][]|undefined=layout,idleMs=120000,blockSize=3,ids=['direct-c1','direct-c4','mono-4-c4','direct-c8']){
 const root=scratch(),s=stage(name,['multi_turn_base_0','multi_turn_base_4','multi_turn_base_10','multi_turn_base_11','multi_turn_base_12','multi_turn_base_13']);s.egress.backend='fixtures';s.blockSize=blockSize;
 s.configs=ids.map(id=>matrix().find(c=>c.id===id)!);s.batches[0].configs=s.configs.map(c=>c.id);if(lanes)s.batches[0].lanes=lanes;s.stall={idleMs,stopGraceMs:100,pollMs:10};
 return {root,plan:freeze(s,root)};
}
type Behaviour={polls?:number;exitCode?:number;writes?:boolean;never?:boolean;neverStarted?:boolean;stopThrows?:boolean;onPoll?:()=>void;results?:(spec:any)=>void;summary?:any};
/** Units finish after a few polls and publish full results, unless told otherwise. */
function fake(behaviour:(cid:string,attempt:string)=>Behaviour=()=>({})){
 const alive=new Map<string,any>(),trace:{event:string;cid:string;unitId:string;alive:number}[]=[];let top=0;
 const finish=(spec:any)=>{for(const caseId of spec.block.caseIds)json(join(spec.outputRoot,'configs',spec.block.configId,'tasks',caseId+'.r1.json'),{caseId,configId:spec.block.configId,round:1,modelSteps:[],completed:[],status:'completed',finishedAt:Date.now()});};
 const unit=(unitId:string,cid:string,b:Behaviour,spec?:any)=>{let polls=0,stopped=false;const collected=()=>{alive.delete(unitId);trace.push({event:'end',cid,unitId,alive:alive.size});};
  return {unitId,isAlive:async()=>{polls++;b.onPoll?.();if(stopped||!b.never&&polls>(b.polls??3)){if(!stopped&&b.writes!==false&&(spec||b.results))(b.results??finish)(spec);collected();return false;}return true;},
   stop:async()=>{stopped=true;if(b.stopThrows)throw Error('fake stop failure');},kill:async()=>{stopped=true;},
   wait:async()=>({exitCode:b.exitCode??0,signal:null,killed:false,stoppedByPlan:stopped,oomKilled:null,startedAt:now(),endedAt:now(),summary:b.neverStarted?null:(b.summary??{}),...(b.neverStarted?{collection:{neverStarted:true}}:{})})};};
 const launcher:RunUnitLauncher={kind:'local-process',toUnitView:s=>s.block,list:async()=>[],adopt:async()=>undefined,start:async spec=>{const cid=spec.block.configId as string,u=unit(spec.unitId,cid,behaviour(cid,spec.unitId),spec);alive.set(spec.unitId,u);top=Math.max(top,alive.size);trace.push({event:'start',cid,unitId:spec.unitId,alive:alive.size});return u;}};
 return {launcher,trace,alive,unit,get top(){return top;}};
}
const starts=(x:{trace:any[]})=>x.trace.filter(t=>t.event==='start').map(t=>t.cid);
const index=(x:{trace:any[]},event:string,cid:string,job=0)=>{const rows=x.trace.map((t,i)=>({...t,i})).filter(t=>t.event===event&&t.cid===cid);return rows[job]?.i??-1;};
const events=(root:string)=>lines(join(root,'scheduler','events.jsonl'));
const attemptDirs=(root:string,job:any,cid:string)=>files(join(root,'blocks',job.blockId,cid)).filter(p=>p.endsWith('attempt.json'));
test('groups of a lane run in turn, lanes side by side, blocks one after another',async()=>{
 const {root,plan}=setup('t9-order'),x=fake(cid=>({polls:cid==='direct-c1'?40:3}));
 const report=await runSchedule(root,x.launcher,{scorer});assert.equal(report.status,'complete',JSON.stringify(report));
 for(const job of [0,1]){assert(index(x,'end','direct-c4',job)<index(x,'start','direct-c8',job));assert(index(x,'end','mono-4-c4',job)<index(x,'start','direct-c8',job));assert(index(x,'start','direct-c1',job)<index(x,'end','direct-c4',job));assert(index(x,'end','direct-c1',job)>index(x,'start','direct-c8',job),'lane 1 overlaps both groups');}
 assert.equal(x.top,3);assert(index(x,'end','direct-c1',0)<index(x,'start','direct-c1',1),'the next block waits for every lane');
 const e=events(root),groups=e.filter(r=>r.kind==='group-start');assert.deepEqual(groups.map(r=>[r.job,r.lane,r.laneGroup,r.configs.join('+')]),plan.jobs.flatMap(j=>[[j.key,1,1,'direct-c1'],[j.key,2,1,'direct-c4+mono-4-c4'],[j.key,1+1,2,'direct-c8']]));
 for(const j of plan.jobs){const block=e.findIndex(r=>r.kind==='block-end'&&r.job===j.key),last=e.map(r=>r.kind==='unit-exit'&&r.job===j.key).lastIndexOf(true);assert(block>last,'block-end after all lanes');}
 const a=read(attemptDirs(root,plan.jobs[0],'direct-c8')[0]);assert.equal(a.lane,2);assert.equal(a.laneGroup,2);assert.equal(a.nonConcurrent,false,'running by plan is not a supplement');
});
test('no lanes: every unit starts together, no group event, no lane field',async()=>{
 const {root,plan}=setup('t9-flat',null as any),x=fake();assert.equal((await runSchedule(root,x.launcher,{scorer})).status,'complete');
 assert.equal(x.top,4);assert.deepEqual(starts(x).slice(0,4),plan.jobs[0].units.map(u=>u.configId));assert(!events(root).some(e=>e.kind==='group-start'));
 const a=read(attemptDirs(root,plan.jobs[0],'direct-c8')[0]);assert.deepEqual(Object.keys(a),['number','path','unitId','caseIds','nonConcurrent']);
});
test('planned stop: a group not started never starts and leaves no attempt; a resume keeps the order',async()=>{
 const {root,plan}=setup('t9-stop');let sent=false;
 const x=fake(cid=>({never:cid!=='direct-c8',writes:false,onPoll:()=>{if(cid==='mono-4-c4'&&!sent){sent=true;process.emit('SIGTERM');}}}));
 const report=await runSchedule(root,x.launcher,{scorer});assert.equal(report.status,'paused');assert.equal(report.reason,'planned-stop');
 assert(!starts(x).includes('direct-c8'));assert.deepEqual(attemptDirs(root,plan.jobs[0],'direct-c8'),[]);assert.equal(events(root).filter(e=>e.kind==='group-start').length,2);
 const y=fake();assert.equal((await runSchedule(root,y.launcher,{scorer})).status,'complete');
 assert(index(y,'end','direct-c4')<index(y,'start','direct-c8'));assert(index(y,'end','mono-4-c4')<index(y,'start','direct-c8'));
 assert.equal(read(attemptDirs(root,plan.jobs[0],'direct-c4').sort().at(-1)!).number,2);assert.equal(read(attemptDirs(root,plan.jobs[0],'direct-c8')[0]).number,1);
});
for(const [label,bad,reason] of [['unit failure',{exitCode:1},'unit-failure'],['configuration not started',{exitCode:null as any,writes:false,neverStarted:true},'configuration-not-started']] as const)
 test(`pause only (${label}): the rest of the block still runs, then the run pauses`,async()=>{
  const {root,plan}=setup('t9-pause-'+reason),x=fake(cid=>cid==='direct-c4'?{...bad}:{});
  const report=await runSchedule(root,x.launcher,{scorer});assert.equal(report.reason,reason);assert.equal(report.status,'paused');
  assert(starts(x).includes('direct-c8'),'the later group still starts');assert.equal(starts(x).length,4,'the next block does not start');assert.deepEqual(attemptDirs(root,plan.jobs[1],'direct-c1'),[]);
 });
test('pause only (single stalled config): the later group still starts',async()=>{
 const {root}=setup('t9-stall',layout,600),x=fake(cid=>cid==='direct-c4'?{never:true,writes:false}:{polls:cid==='direct-c1'?30:3});
 const report=await runSchedule(root,x.launcher,{scorer});assert.equal(report.reason,'stall');assert(starts(x).includes('direct-c8'));assert.equal(starts(x).length,4);
});
test('launcher error: stopping, so the later group does not start',async()=>{
 const {root,plan}=setup('t9-launcher',layout,600),x=fake(cid=>cid==='direct-c4'?{never:true,writes:false,stopThrows:true}:{polls:cid==='direct-c1'?30:3});
 const report=await runSchedule(root,x.launcher,{scorer});assert.equal(report.reason,'stall');assert(!starts(x).includes('direct-c8'));assert.deepEqual(attemptDirs(root,plan.jobs[0],'direct-c8'),[]);assert((report as any).launcherErrors.some((e:any)=>e.operation==='stop'));
});
test('an adopted unit is watched first and counts in its group; earlier work waits for it',async()=>{
 const {root,plan}=setup('t9-adopt'),job=plan.jobs[0],spec=job.units.find(u=>u.configId==='direct-c8')!,unitId='adopted-direct-c8';
 const a=join(root,'blocks',job.blockId,'direct-c8','r1','attempt-1');json(join(a,'attempt.json'),{number:1,unitId,caseIds:spec.caseIds,nonConcurrent:false,lane:2,laneGroup:2});
 for(const caseId of spec.caseIds)json(join(a,'output/configs/direct-c8/tasks',caseId+'.r1.json'),{caseId,configId:'direct-c8',round:1,modelSteps:[],completed:[],status:'completed',finishedAt:Date.now()});
 const x=fake(),adopted=x.unit(unitId,'direct-c8',{polls:20});x.alive.set(unitId,adopted);
 const launcher:RunUnitLauncher={...x.launcher,list:async()=>x.alive.has(unitId)?[unitId]:[],adopt:async(_run,id)=>id===unitId?adopted:undefined};
 const report=await runSchedule(root,launcher,{scorer});assert.equal(report.status,'complete',JSON.stringify(report));
 assert(index(x,'end','direct-c8')<index(x,'start','direct-c4'),'group 1 starts only after the adopted group 2 unit is collected');assert.equal(starts(x).filter(c=>c==='direct-c8').length,1,'block 1 reuses the adopted unit; only block 2 starts direct-c8');
 const groups=events(root).filter(e=>e.kind==='group-start'&&e.job===job.key);assert.deepEqual(groups.map(g=>[g.lane,g.laneGroup]),[[1,1],[2,2],[2,1]]);
 assert(existsSync(join(a,'collected.json')));assert.equal(attemptDirs(root,job,'direct-c8').length,1,'never a second attempt for an adopted unit');
});
test('resume skips a group with nothing left',async()=>{
 const {root,plan}=setup('t9-skip');const job=plan.jobs[0];
 for(const cid of ['direct-c4','mono-4-c4']){const spec=job.units.find(u=>u.configId===cid)!,a=join(root,'blocks',job.blockId,cid,'r1','attempt-1');json(join(a,'attempt.json'),{number:1,unitId:'done-'+cid,caseIds:spec.caseIds,nonConcurrent:false,lane:2,laneGroup:1});json(join(a,'collected.json'),{exitCode:0});for(const caseId of spec.caseIds)json(join(a,'output/configs',cid,'tasks',caseId+'.r1.json'),{caseId,configId:cid,round:1,modelSteps:[],completed:[],status:'completed',finishedAt:Date.now()});}
 const x=fake();assert.equal((await runSchedule(root,x.launcher,{scorer})).status,'complete');
 const groups=events(root).filter(e=>e.kind==='group-start'&&e.job===job.key);assert.deepEqual(groups.map(g=>[g.lane,g.laneGroup]),[[1,1],[2,2]]);
 // Per group (commander ruling on review item 6): the c8 group ran whole, as frozen, so it is no supplement.
 assert.equal(read(attemptDirs(root,job,'direct-c8')[0]).nonConcurrent,false,'a complete group run by plan is not a supplement');
 assert.equal(read(attemptDirs(root,job,'direct-c1')[0]).nonConcurrent,false);
});
test('per group: a group missing a config is a supplement, the other groups of the block are not',async()=>{
 const {root,plan}=setup('t9-partial');const job=plan.jobs[0],spec=job.units.find(u=>u.configId==='direct-c4')!,a=join(root,'blocks',job.blockId,'direct-c4','r1','attempt-1');
 json(join(a,'attempt.json'),{number:1,unitId:'done-direct-c4',caseIds:spec.caseIds,nonConcurrent:false,lane:2,laneGroup:1});json(join(a,'collected.json'),{exitCode:0});
 for(const caseId of spec.caseIds)json(join(a,'output/configs/direct-c4/tasks',caseId+'.r1.json'),{caseId,configId:'direct-c4',round:1,modelSteps:[],completed:[],status:'completed',finishedAt:Date.now()});
 const x=fake();assert.equal((await runSchedule(root,x.launcher,{scorer})).status,'complete');
 assert.equal(read(attemptDirs(root,job,'mono-4-c4')[0]).nonConcurrent,true,'mono-4-c4 ran without its tier peer');
 assert.equal(read(attemptDirs(root,job,'direct-c8')[0]).nonConcurrent,false);assert.equal(read(attemptDirs(root,job,'direct-c1')[0]).nonConcurrent,false);
 const e=events(root).filter(r=>r.job===job.key),g=(l:number,n:number)=>e.find(r=>r.kind==='group-start'&&r.lane===l&&r.laneGroup===n);
 assert.equal(g(2,1).supplement,true);assert.equal(g(2,2).supplement,false);assert.equal(g(1,1).supplement,false);
 assert.equal(e.find(r=>r.kind==='block-start').supplement,false,'block-start keeps its whole-block meaning (any attempt beyond the first)');
});
test('no lanes: one group is the whole block, so a resumed block still marks every unit as before',async()=>{
 const {root,plan}=setup('t9-flat-partial',null as any);const job=plan.jobs[0],spec=job.units.find(u=>u.configId==='direct-c4')!,a=join(root,'blocks',job.blockId,'direct-c4','r1','attempt-1');
 json(join(a,'attempt.json'),{number:1,unitId:'done-direct-c4',caseIds:spec.caseIds,nonConcurrent:false});json(join(a,'collected.json'),{exitCode:0});
 for(const caseId of spec.caseIds)json(join(a,'output/configs/direct-c4/tasks',caseId+'.r1.json'),{caseId,configId:'direct-c4',round:1,modelSteps:[],completed:[],status:'completed',finishedAt:Date.now()});
 const x=fake();assert.equal((await runSchedule(root,x.launcher,{scorer})).status,'complete');
 for(const cid of ['direct-c1','mono-4-c4','direct-c8'])assert.equal(read(attemptDirs(root,job,cid)[0]).nonConcurrent,true,cid);
 for(const cid of ['direct-c1','mono-4-c4','direct-c8'])assert.equal(read(attemptDirs(root,plan.jobs[1],cid)[0]).nonConcurrent,false,'next block whole');
});
// Cross-attempt authorization, in memory. One config, one block of 6 so a live unit can keep failing.
const X='context-error',Y='tool-channel',failure=(cid:string,caseId:string,type:string,streak:number,at:number)=>({caseId,configId:cid,round:1,disposition:'skipped',failureType:type,streak,ended:{wall:new Date(at).toISOString()}});
const done=(cid:string,caseId:string,at:number)=>({caseId,configId:cid,round:1,modelSteps:[],completed:[],status:'completed',finishedAt:at});
function single(name:string){const {root,plan}=setup(name,null as any,120000,6,['direct-c4']);const job=plan.jobs[0],order=job.units[0].caseIds,dir=(n:number)=>join(root,'blocks',job.blockId,'direct-c4','r1','attempt-'+n),o=(n:number)=>join(dir(n),'output/configs/direct-c4');return {root,plan,job,order,dir,o};}
const pauseIds=(root:string)=>files(join(root,'scheduler/failure-pauses')).filter(p=>p.endsWith('.json')).map(p=>read(p).pauseId).sort();
const refused=async(root:string,launcher:RunUnitLauncher,authorization?:string)=>{await assert.rejects(runSchedule(root,launcher,{scorer,resumeAuthorization:authorization}),/needs user authorization/);};
const allow=(ids:string[],note:string)=>ids.map(i=>'pause:'+i).join(' ')+' '+note;
function liveUnit(x:ReturnType<typeof fake>,unitId:string,b:Behaviour){const u=x.unit(unitId,'direct-c4',b);x.alive.set(unitId,u);return {...x.launcher,list:async()=>x.alive.has(unitId)?[unitId]:[],adopt:async(_r:string,id:string)=>id===unitId?u:undefined} as RunUnitLauncher;}
test('bypass closed (review p6/S5): a live unit authorized for a pair needs a new authorization for its T7 streak',async()=>{
 const s=single('t9-bypass'),[a,b,c,...rest]=s.order;
 json(join(s.dir(1),'attempt.json'),{number:1,unitId:'u1',caseIds:s.order,nonConcurrent:false});json(join(s.o(1),'failures',a+'.r1.json'),failure('direct-c4',a,X,1,1000));json(join(s.dir(1),'collected.json'),{exitCode:137,summary:null});
 json(join(s.dir(2),'attempt.json'),{number:2,unitId:'u2',caseIds:s.order.slice(1),nonConcurrent:true});json(join(s.o(2),'failures',b+'.r1.json'),failure('direct-c4',b,X,1,2000));
 const x=fake(),launcher=liveUnit(x,'u2',{polls:3,results:()=>{json(join(s.o(2),'failures',c+'.r1.json'),failure('direct-c4',c,X,2,3000));},summary:{consecutiveFailure:{failureType:X,caseIds:[b,c]}}});
 await refused(s.root,launcher);const first=pauseIds(s.root);assert.deepEqual(first,[digest('u2/cross-attempt/'+X+'/'+b)]);
 const r=await runSchedule(s.root,launcher,{scorer,resumeAuthorization:allow(first,'reviewed the pair')});assert.equal(r.reason,'consecutive-failure');
 const second=pauseIds(s.root);assert.equal(second.length,2);assert(second.includes(digest('u2')),'the T7 pause keeps the unit identity');
 await refused(s.root,fake().launcher);await refused(s.root,fake().launcher,allow(first,'old pause only'));
 const y=fake(),last=await runSchedule(s.root,y.launcher,{scorer,resumeAuthorization:allow(second.filter(i=>!first.includes(i)),'reviewed the streak')});assert.equal(last.status,'complete',JSON.stringify(last));
 assert.equal((await runSchedule(s.root,fake().launcher,{scorer})).status,'complete','authorized pauses are not asked again');
 void rest;
});
test('S5b: a live unit authorized for one pair needs a new authorization for a pair of another type',async()=>{
 const s=single('t9-s5b'),[a,y,b,c,...rest]=s.order;
 json(join(s.dir(1),'attempt.json'),{number:1,unitId:'u1',caseIds:s.order,nonConcurrent:false});json(join(s.o(1),'failures',a+'.r1.json'),failure('direct-c4',a,X,1,1000));json(join(s.o(1),'failures',y+'.r1.json'),failure('direct-c4',y,Y,1,1100));json(join(s.dir(1),'collected.json'),{exitCode:137,summary:null});
 json(join(s.dir(2),'attempt.json'),{number:2,unitId:'u2',caseIds:s.order.slice(2),nonConcurrent:true});json(join(s.o(2),'failures',b+'.r1.json'),failure('direct-c4',b,X,1,2000));
 const x=fake(),launcher=liveUnit(x,'u2',{polls:3,results:()=>{json(join(s.o(2),'failures',c+'.r1.json'),failure('direct-c4',c,Y,1,3000));for(const id of rest)json(join(s.o(2),'tasks',id+'.r1.json'),done('direct-c4',id,3100));}});
 await refused(s.root,launcher);const first=pauseIds(s.root);assert.equal(first.length,1);
 const r=await runSchedule(s.root,launcher,{scorer,resumeAuthorization:allow(first,'reviewed the first pair')});assert.equal(r.reason,'consecutive-failure');
 const second=pauseIds(s.root);assert.equal(second.length,2);const fresh=second.filter(i=>!first.includes(i));
 assert.deepEqual(read(join(s.root,'scheduler/failure-pauses',fresh[0]+'.json')).details.crossAttempt.map((p:any)=>p.failureType).sort(),[X,Y]);
 await refused(s.root,fake().launcher);assert.equal((await runSchedule(s.root,fake().launcher,{scorer,resumeAuthorization:allow(fresh,'reviewed the second pair')})).status,'complete');
});
test('a pair found at collection gets the same pause id from the next startup scan; once authorized it is not asked again (S8 shape)',async()=>{
 const s=single('t9-same-id'),[a,b,...rest]=s.order;
 json(join(s.dir(1),'attempt.json'),{number:1,unitId:'u1',caseIds:s.order,nonConcurrent:false});json(join(s.o(1),'failures',a+'.r1.json'),failure('direct-c4',a,X,1,1000));json(join(s.dir(1),'collected.json'),{exitCode:137,summary:null});
 const x=fake(()=>({results:(spec:any)=>{json(join(spec.outputRoot,'configs/direct-c4/failures',b+'.r1.json'),failure('direct-c4',b,X,1,Date.now()));for(const id of rest)json(join(spec.outputRoot,'configs/direct-c4/tasks',id+'.r1.json'),done('direct-c4',id,Date.now()+1));}}));
 const r=await runSchedule(s.root,x.launcher,{scorer});assert.equal(r.reason,'consecutive-failure');const ids=pauseIds(s.root);assert.equal(ids.length,1);
 const two=attempts(s.root,s.job,'direct-c4')[1],scan=consecutiveFailure(two,'direct-c4',undefined,{root:s.root,job:s.job})!;assert.equal(digest(pauseIdentity(two.unitId,scan)),ids[0],'startup scan names the pair as collection did');
 await refused(s.root,fake().launcher);assert.deepEqual(pauseIds(s.root),ids,'the scan adds no second pause');
 assert.equal((await runSchedule(s.root,fake().launcher,{scorer,resumeAuthorization:allow(ids,'reviewed')})).status,'complete');
 assert.equal((await runSchedule(s.root,fake().launcher,{scorer})).status,'complete');assert.equal(files(join(s.root,'scheduler/failure-authorizations')).filter(p=>p.endsWith('.json')).length,1);
});
for(const [label,text,reason] of [['bad JSON','{not json','scheduler-error'],['null','null','invalid-task-record']] as const)
 test(`a damaged older record found by the startup scan still writes the stop report (${label}: ${reason}, as before T9)`,async()=>{
  const s=single('t9-damaged'),[a,b]=s.order;
  json(join(s.dir(1),'attempt.json'),{number:1,unitId:'u1',caseIds:s.order,nonConcurrent:false});writeFileSync(join((()=>{json(join(s.o(1),'tasks',a+'.r1.json'),done('direct-c4',a,1000));return s.o(1);})(),'tasks',a+'.r1.json'),text);json(join(s.dir(1),'collected.json'),{exitCode:0,summary:{}});
  json(join(s.dir(2),'attempt.json'),{number:2,unitId:'u2',caseIds:s.order.slice(1),nonConcurrent:true});json(join(s.o(2),'tasks',b+'.r1.json'),done('direct-c4',b,2000));json(join(s.dir(2),'collected.json'),{exitCode:0,summary:{}});
  const x=fake();await assert.rejects(runSchedule(s.root,x.launcher,{scorer}));const report=maybe<any>(join(s.root,'scheduler/stop-report.json'));
  assert.equal(report?.reason,reason);assert.equal(report.status,'paused');assert.deepEqual(starts(x),[],'nothing started');
  assert(lines(join(s.root,'scheduler/events.jsonl')).some(e=>e.kind==='schedule-error'));
 });
// Fix-review round: pending and lost pauses are checked before a damaged record is reported, as before T9.
function damagedOlderRecord(name:string){const s=single(name),[a,b]=s.order;
 json(join(s.dir(1),'attempt.json'),{number:1,unitId:'u1',caseIds:s.order,nonConcurrent:false});json(join(s.o(1),'tasks',a+'.r1.json'),done('direct-c4',a,1000));writeFileSync(join(s.o(1),'tasks',a+'.r1.json'),'null');json(join(s.dir(1),'collected.json'),{exitCode:0,summary:{}});
 json(join(s.dir(2),'attempt.json'),{number:2,unitId:'u2',caseIds:s.order.slice(1),nonConcurrent:true});json(join(s.o(2),'tasks',b+'.r1.json'),done('direct-c4',b,2000));json(join(s.dir(2),'collected.json'),{exitCode:0,summary:{}});
 return {...s,report:join(s.root,'scheduler/stop-report.json'),repair:()=>writeFileSync(join(s.o(1),'tasks',a+'.r1.json'),JSON.stringify(done('direct-c4',a,1000)))};}
test('a pending pause is refused before a damaged record is reported; the stop report stays as it was',async()=>{
 const s=single('t9-pending-damaged'),[a,b,c]=s.order,reportPath=join(s.root,'scheduler/stop-report.json');
 json(join(s.dir(1),'attempt.json'),{number:1,unitId:'u1',caseIds:s.order,nonConcurrent:false});json(join(s.o(1),'failures',a+'.r1.json'),failure('direct-c4',a,X,1,1000));json(join(s.o(1),'failures',b+'.r1.json'),failure('direct-c4',b,X,2,1100));json(join(s.dir(1),'collected.json'),{exitCode:0,summary:{consecutiveFailure:{failureType:X,caseIds:[a,b]}}});
 json(join(s.dir(2),'attempt.json'),{number:2,unitId:'u2',caseIds:s.order.slice(2),nonConcurrent:true});writeFileSync(join((()=>{json(join(s.o(2),'tasks',c+'.r1.json'),done('direct-c4',c,2000));return s.o(2);})(),'tasks',c+'.r1.json'),'{not json');json(join(s.dir(2),'collected.json'),{exitCode:0,summary:{}});
 json(reportPath,{at:new Date().toISOString(),status:'paused',reason:'consecutive-failure',pauseIds:[],marker:'previous report'});const before=readFileSync(reportPath);
 const x=fake();await refused(s.root,x.launcher);assert(readFileSync(reportPath).equals(before),'the refusal keeps the previous stop report');assert.deepEqual(starts(x),[]);
 const ids=pauseIds(s.root);assert.deepEqual(ids,[digest('u1')]);
 // Authorized but still damaged: the damage is reported now, nothing is authorized or started.
 await assert.rejects(runSchedule(s.root,x.launcher,{scorer,resumeAuthorization:allow(ids,'reviewed')}),/Invalid JSON/);assert.equal(read(reportPath).reason,'scheduler-error');
 assert.deepEqual(files(join(s.root,'scheduler/failure-authorizations')),[]);assert.deepEqual(starts(x),[]);
 writeFileSync(join(s.o(2),'tasks',c+'.r1.json'),JSON.stringify(done('direct-c4',c,2000)));
 await refused(s.root,fake().launcher);
 assert.equal((await runSchedule(s.root,fake().launcher,{scorer,resumeAuthorization:allow(ids,'reviewed after repair')})).status,'complete');
});
test('review scenario 5: a stop report naming a lost pause refuses with a damaged record and still refuses after the repair',async()=>{
 const s=damagedOlderRecord('t9-lost-damaged'),gone='a'.repeat(64);json(s.report,{at:new Date().toISOString(),status:'paused',reason:'consecutive-failure',pauseIds:[gone],marker:'names a lost pause'});const before=readFileSync(s.report);
 const x=fake();await assert.rejects(runSchedule(s.root,x.launcher,{scorer}),/needs user authorization.*missing/);assert(readFileSync(s.report).equals(before));assert.deepEqual(starts(x),[]);
 s.repair();const y=fake();await assert.rejects(runSchedule(s.root,y.launcher,{scorer}),/needs user authorization.*missing/);assert(readFileSync(s.report).equals(before));assert.deepEqual(starts(y),[]);
});
test('review scenario 6: a legacy consecutive-failure report refuses with a damaged record and still refuses after the repair',async()=>{
 const s=damagedOlderRecord('t9-legacy-damaged');json(s.report,{at:new Date().toISOString(),status:'paused',reason:'consecutive-failure',marker:'legacy'});const before=readFileSync(s.report);
 await refused(s.root,fake().launcher);assert(readFileSync(s.report).equals(before));const ids=pauseIds(s.root);assert.equal(ids.length,1);
 s.repair();await refused(s.root,fake().launcher);assert(readFileSync(s.report).equals(before));assert.deepEqual(pauseIds(s.root),ids);
 assert.equal((await runSchedule(s.root,fake().launcher,{scorer,resumeAuthorization:allow(ids,'reviewed the legacy pause')})).status,'complete');
});
void ({} as Plan);
