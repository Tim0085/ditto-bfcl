import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {mkdtempSync,mkdirSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {stage} from './t8a-helpers.ts';
import {freeze} from '../src/ts/scheduler/plan.ts';
import {json,read,now} from '../src/ts/scheduler/io.ts';
import {observeLauncher} from '../src/ts/scheduler/launcher-operations.ts';
import {terminationEvidence} from '../src/ts/scheduler/termination.ts';
import {recordInterrupted} from '../src/ts/scheduler/records.ts';
import {requireFTemp} from '../src/ts/scheduler/launcher.ts';
import {recoverEgress,closeEgress} from '../src/ts/scheduler/egress.ts';
import {runSchedule} from '../src/ts/scheduler/scheduler.ts';
import {scoringFields,ScoringTrace} from '../src/ts/step-log.ts';
import type {RunUnitLauncher} from '../src/ts/run-unit.ts';
const fresh=()=>mkdtempSync(join(tmpdir(),'t8c-contract-'));
const exit=()=>({exitCode:0,signal:null,killed:false,stoppedByPlan:false,oomKilled:null,startedAt:now(),endedAt:now(),summary:null});
test('Concurrent stop dispatch does not wait for a blocked unit; failures retain operation and unit',async()=>{
  const root=fresh(),errors:any[]=[],stuck=new Set<string>(),sent:string[]=[],release:(()=>void)[]=[];
  const source:RunUnitLauncher={kind:'local-process',toUnitView:s=>s.block,list:async()=>[],adopt:async()=>undefined,
    start:async s=>({unitId:s.unitId,isAlive:async()=>true,wait:async()=>exit(),stop:async()=>{sent.push(s.unitId);await new Promise<void>(r=>release.push(r));},kill:async()=>{throw Error('delivery failed');}})};
  const observed=observeLauncher(source,join(root,'events.jsonl'),errors,stuck),units=[];
  for(const unitId of ['a','b'])units.push(await observed.launcher.start({unitId,runId:'t8c',block:{},outputRoot:root,logDir:root,guardReportDir:root,egressUrl:'http://127.0.0.1:1'}));
  await Promise.all(units.map(u=>u.stop('planned')));assert.deepEqual(sent,['a','b']);assert.equal(observed.pending.size,2);
  for(let i=0;i<3;i++)await units[0].kill('no in-flight');assert(stuck.has('a'));assert.equal(errors.length,3);assert(errors.every(e=>e.operation==='kill'&&e.unitId==='a'));
  release.forEach(r=>r());await Promise.all(observed.pending);
});
test('Kill evidence keeps collector snapshot and authoritative late receipts, with three explicit outcomes',()=>{
  const root=fresh();for(const [status,outcome] of [['requested','not-dispatched'],['dispatched','unconfirmed'],['succeeded','confirmed']]){
    const a=join(root,status);json(join(a,'logs','exit.json'),{...exit(),exitCode:137,oomKilled:false});json(join(a,'logs','kill-outcome.json'),{containerId:'cid',outcome});json(join(a,'logs','kill-requests','one.json'),{containerId:'cid',status});
    assert.equal(terminationEvidence(a).outcome,outcome);
  }
  const a=join(root,'dispatched'),before=readFileSync(join(a,'logs','kill-outcome.json'));
  json(join(a,'logs','kill-requests','one.json'),{containerId:'cid',status:'succeeded'});
  const late=terminationEvidence(a);assert.equal(late.outcome,'confirmed');assert.equal(late.collectedOutcome,'unconfirmed');assert(before.equals(readFileSync(join(a,'logs','kill-outcome.json'))));
});
test('Docker interruption attribution uses complete exit times without control.json and excludes recovered starts',()=>{
  const root=fresh(),s=stage('t8c-interruption',['web_search_no_snippet_0']),p=freeze(s,root),job=p.jobs[0],a={path:join(root,'attempt'),caseIds:job.caseIds,unitId:'u'};
  json(join(a.path,'logs','exit.json'),{...exit(),startedAt:'2026-11-06T00:00:00Z',endedAt:'2026-11-06T00:00:02Z'});
  mkdirSync(join(root,'egress'));const {writeFileSync}=requireFs();
  writeFileSync(join(root,'egress','ledger.jsonl'),JSON.stringify({configId:'direct-c1',taskId:'t8c-interruption/direct-c1/r1/web_search_no_snippet_0',caseId:'web_search_no_snippet_0',id:'r'})+'\n');
  writeFileSync(join(root,'egress','rate.jsonl'),JSON.stringify({id:'r',at:Date.parse('2026-11-06T00:00:01Z')})+'\n');
  recordInterrupted(a,'direct-c1',job,root);assert.equal(read(join(a.path,'interruptions.json')).length,1);
});
test('SELECT IDs enrich both callers without adding scoring events',()=>{
  assert.deepEqual(scoringFields('CONTEXT.SELECT',{}, {selectedItemIds:['a','b']}),{selectedItemIds:['a','b']});
  const trace=new ScoringTrace('t');trace.add('CONTEXT.SELECT',{}, {selectedItemIds:['a']},{});assert.equal(trace.events.length,0);
});
test('Recovery rejects live launcher units even when no local registry or control.json exists',async()=>{
  const root=fresh(),s=stage('t8c-recover-live');freeze(s,root);json(join(root,'egress','stopped.json'),{});
  const launcher:RunUnitLauncher={kind:'docker',toUnitView:s=>s.block,start:async()=>{throw Error('no start');},list:async()=>['live-container'],adopt:async()=>({unitId:'live-container',isAlive:async()=>true,wait:async()=>exit(),stop:async()=>{},kill:async()=>{}})};
  await assert.rejects(recoverEgress(root,'offline test authorization',launcher),/Run unit still alive/);
});
test('CLI startup failure is configuration-not-started and retains all cases for resume',async()=>{
  const root=fresh(),s=stage('t8c-not-started',['web_search_no_snippet_0']);s.egress.backend='fixtures';freeze(s,root);
  const report=await runSchedule(root,{kind:'local-process',toUnitView:s=>s.block,list:async()=>[],adopt:async()=>undefined,start:async s=>{const dir=join(s.outputRoot,'configs','direct-c1');mkdirSync(dir,{recursive:true});fs.writeFileSync(join(dir,'tasks'),'directory collision fixture');return {unitId:s.unitId,isAlive:async()=>false,wait:async()=>({...exit(),exitCode:2}),stop:async()=>{},kill:async()=>{}};}});
  assert.equal(report.reason,'configuration-not-started');assert.equal(report.complete,false);
});
test('The main entry rejects C temp before creating anything',()=>{
  const before=process.env.TEMP;try{process.env.TEMP='C:/Users/Tim/AppData/Local/Temp';assert.throws(requireFTemp,/TEMP must be set/);}finally{process.env.TEMP=before;}
});

test('A start reply failure plus failed cleanup enumeration retains unresolved attempts and egress',async()=>{
  const root=fresh(),s=stage('t8c-cleanup-enumeration',['web_search_no_snippet_0']);s.egress.backend='fixtures';freeze(s,root);let started=false;
  try{
    await assert.rejects(runSchedule(root,{kind:'local-process',toUnitView:s=>s.block,list:async()=>{if(started)throw Error('enumeration unavailable');return [];},adopt:async()=>undefined,start:async()=>{started=true;throw Error('lost start return');}}),/lost start return/);
    const report=read(join(root,'scheduler','stop-report.json'));assert.equal(report.reason,'unit-launcher-error');assert.equal(report.egressLeftRunning,true);assert.equal(report.stuckUnits.length,1);assert(report.stuckUnits[0].startsWith(s.runId));assert(report.launcherErrors.some((r:any)=>r.kind==='cleanup-error'));
  }finally{await closeEgress(root);}
});
import * as fs from 'node:fs';
function requireFs(){return fs;}
