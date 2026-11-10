import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {stage} from './t8a-helpers.ts';
import {freeze} from '../src/ts/scheduler/plan.ts';
import {json,now} from '../src/ts/scheduler/io.ts';
import {drainUnits} from '../src/ts/scheduler/drain.ts';
import {observeLauncher} from '../src/ts/scheduler/launcher-operations.ts';
import type {RunUnit,RunUnitLauncher} from '../src/ts/run-unit.ts';
function fixture(flight:number){const root=mkdtempSync(join(tmpdir(),'t8c-cleanup-')),s=stage('cleanup',['web_search_no_snippet_0']);s.stall.stopGraceMs=40;s.stall.pollMs=5;const plan=freeze(s,root);json(join(root,'egress/status.json'),{at:Date.now(),active:{'direct-c1':flight}});return {root,plan};}
const exit=()=>({exitCode:0,signal:null,killed:false,stoppedByPlan:true,oomKilled:null,startedAt:now(),endedAt:now(),summary:null});
async function observed(root:string,units:RunUnit[],errors:any[],stuck:Set<string>){const source:RunUnitLauncher={kind:'local-process',toUnitView:s=>s.block,list:async()=>[],adopt:async()=>undefined,start:async s=>units.find(u=>u.unitId===s.unitId)!};const wrapper=observeLauncher(source,join(root,'events.jsonl'),errors,stuck),running=new Map<string,RunUnit>();for(const u of units)running.set(u.unitId,await wrapper.launcher.start({runId:'cleanup',unitId:u.unitId,block:{},outputRoot:root,logDir:root,guardReportDir:root,egressUrl:'http://127.0.0.1:1'}));return running;}
test('Cleanup stops all units, bounds a held request, and never collects or kills a live unit',async()=>{
 const {root,plan}=fixture(1),errors:any[]=[],stuck=new Set<string>(),sent:string[]=[];let kills=0,waits=0;
 const running=await observed(root,['a','b'].map(unitId=>({unitId,isAlive:async()=>true,stop:async()=>{sent.push(unitId);await new Promise(()=>{});},kill:async()=>{kills++;},wait:async()=>{waits++;return exit();}})),errors,stuck);
 const start=Date.now();await drainUnits(root,plan,running,stuck,join(root,'events.jsonl'),80,errors,'cleanup');
 assert.deepEqual(sent,['a','b']);assert.equal(stuck.size,2);assert.equal(running.size,0);assert.equal(kills,0);assert.equal(waits,0);assert(Date.now()-start>=80);assert(Date.now()-start<3000);
});
test('Cleanup requires a full zero-in-flight grace, then collects only the exited unit',async()=>{
 const {root,plan}=fixture(0),errors:any[]=[],stuck=new Set<string>();let live=true,killedAt=0,waits=0;
 const running=await observed(root,[{unitId:'a',isAlive:async()=>live,stop:async()=>{},kill:async()=>{killedAt=Date.now();live=false;},wait:async()=>{assert.equal(live,false);waits++;return exit();}}],errors,stuck);
 const start=Date.now();await drainUnits(root,plan,running,stuck,join(root,'events.jsonl'),80,errors,'cleanup');assert(killedAt-start>=40);assert.equal(waits,1);assert.equal(stuck.size,0);assert.equal(errors.length,0);
});
test('A failed liveness observation preserves the unit and records its operation',async()=>{
 const {root,plan}=fixture(0),errors:any[]=[],stuck=new Set<string>();let kills=0;
 const running=await observed(root,[{unitId:'a',isAlive:async()=>{throw Error('inspect unavailable');},stop:async()=>{},kill:async()=>{kills++;},wait:async()=>exit()}],errors,stuck);
 await drainUnits(root,plan,running,stuck,join(root,'events.jsonl'),80,errors,'cleanup');assert(stuck.has('a'));assert.equal(kills,0);assert(errors.some(e=>e.operation==='isAlive'&&e.unitId==='a'));assert(errors.some(e=>e.kind==='cleanup-observation-error'));
});
