import test from 'node:test';
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {rmSync,existsSync} from 'node:fs';
import {LocalProcessLauncher} from '../src/ts/scheduler/local-process.ts';
import {runSchedule} from '../src/ts/scheduler/scheduler.ts';
import {freeze,generate} from '../src/ts/scheduler/plan.ts';
import {read,ROOT,auxiliaryLines,json} from '../src/ts/scheduler/io.ts';
import {scratch,stage} from './t8a-helpers.ts';
import type {RunUnitSpec,RunUnitLauncher} from '../src/ts/run-unit.ts';
test('Duplicate batches/configs/task identities are rejected before execution',()=>{const base=stage('duplicates');for(const mode of ['batch','config','task']){const s=structuredClone(base);if(mode==='config')s.batches[0].configs.push(s.batches[0].configs[0]);else s.batches.push({...structuredClone(s.batches[0]),id:mode==='task'?'other':s.batches[0].id});assert.throws(()=>generate(s),/duplicate/i);}});
test('A start rejection after real spawn still adopts and drains every registered unit',async()=>{const dir=scratch(),s=stage('startup-failure',['multi_turn_base_0']);freeze(s,dir);
 class FailingLauncher extends LocalProcessLauncher {override async start(spec:RunUnitSpec):Promise<never>{await super.start(spec);throw new Error('injected failure after child created');}}
 const launcher=new FailingLauncher(join(dir,'scheduler','units'));
 try{await assert.rejects(runSchedule(dir,launcher),/injected failure/);const ids=await launcher.list(s.runId);assert.equal(ids.length,1);for(const id of ids){const unit=await launcher.adopt(s.runId,id);assert(unit);assert.equal(await unit.isAlive(),false);const [a,b]=await Promise.all([unit.wait(),unit.wait()]);assert.deepEqual(a,b);}
 assert(existsSync(join(dir,'scheduler','egress','exit.json')));console.log(JSON.stringify({startupFailureAllOwnedUnitsReaped:true,egressClosed:true}));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('A launcher handshake timeout never grants a late shell permission to execute the CLI',async()=>{const dir=scratch();try{const spec={runId:'timeout',unitId:'timeout-unit',block:{configId:'never-run'},outputRoot:join(dir,'output'),logDir:join(dir,'logs'),guardReportDir:join(dir,'guards'),egressUrl:'http://127.0.0.1:1'},launcher=new LocalProcessLauncher(join(dir,'registry'),[],1);await assert.rejects(launcher.start(spec),/failed to open control/);assert.equal(existsSync(join(spec.logDir,'start-permit.json')),false);assert.equal(existsSync(join(spec.logDir,'shell.jsonl')),false);const unit=await launcher.adopt('timeout','timeout-unit');assert.equal(await unit!.isAlive(),false);console.log(JSON.stringify({lateHandshakeCannotExecute:true,ownedProcessReaped:true}));}finally{rmSync(dir,{recursive:true,force:true});}});
test('A changed frozen plan is rejected before starting the next block',async()=>{const dir=scratch();let starts=0;try{const s=stage('freeze-test',['multi_turn_base_0','multi_turn_miss_func_0']);freeze(s,dir);const launcher:RunUnitLauncher={kind:'local-process',toUnitView:spec=>spec.block,list:async()=>[],adopt:async()=>undefined,start:async spec=>{starts++;const plan=read(join(dir,'plan.json'));plan.stage.seed++;json(join(dir,'plan.json'),plan);return {unitId:spec.unitId,isAlive:async()=>false,stop:async()=>{},kill:async()=>{},wait:async()=>({exitCode:0,signal:null,killed:false,stoppedByPlan:false,oomKilled:null,startedAt:new Date().toISOString(),endedAt:new Date().toISOString(),summary:null})};}};await assert.rejects(runSchedule(dir,launcher),/Frozen plan/);assert.equal(starts,1);assert(existsSync(join(dir,'scheduler','egress','exit.json')));}finally{rmSync(dir,{recursive:true,force:true});}});
