import assert from 'node:assert/strict';
import {join,resolve} from 'node:path';
import {mkdirSync,cpSync,readFileSync} from 'node:fs';
import {read,json,ROOT,lines,files} from '../src/ts/scheduler/io.ts';
import {attempts,merged} from '../src/ts/scheduler/records.ts';
import {freeze,matrix,categories} from '../src/ts/scheduler/plan.ts';
import {runSchedule} from '../src/ts/scheduler/scheduler.ts';
import {LocalProcessLauncher} from '../src/ts/scheduler/local-process.ts';
import {exportRun} from '../src/ts/scheduler/export.ts';
import {profile} from '../src/ts/scheduler/profile.ts';
import {stage,comparisonView,command,referenceRoot} from './t8a-helpers.ts';
const root=resolve(process.argv[2]),mode=process.argv[3]??'smoke';mkdirSync(root,{recursive:true});
let s=stage('t8a-'+mode);
if(mode==='profile'){s=read(join(ROOT,'config/stages/profile.json'));s.python='E:/Anaconda3/python.exe';s.runId='t8a-profile';s.stall={idleMs:120000,stopGraceMs:10000,pollMs:100};}
if(mode==='matrix'){
  s.configs=matrix();const split=resolve(process.argv[4]);s.targetedSplit=split;s.batches[0].configs=s.configs.map(c=>c.id);
}
const plan=freeze(s,root);const result=await runSchedule(root,new LocalProcessLauncher(join(root,'scheduler','units')));console.log(JSON.stringify(result));assert.equal(result.status,'complete');
if(mode==='profile'){const p=profile(root,join(root,'targeted-split.json'));console.log(JSON.stringify(p));}
else {comparisonView(root,join(root,'compare-input'));json(join(root,'cases.json'),s.batches[0].caseIds);const comparison=await command(s.python,['-B','-X','utf8','scripts/compare.py','--new-run',join(root,'compare-input'),'--old-run',join(referenceRoot,'runs/multiturn-full800-001'),'--cases',join(root,'cases.json'),'--output',join(root,'comparison')],join(root,'compare-process'));console.log(JSON.stringify(comparison));assert.equal(comparison.code,0);}
const one=exportRun(root,join(root,'export-1'));exportRun(root,join(root,'export-2'));console.log(JSON.stringify({summary:one.summary,taskCount:one.taskRows.length}));
for(const file of files(join(root,'export-1')))assert(readFileSync(file).equals(readFileSync(file.replace('export-1','export-2'))));
if(mode==='matrix'){
 assert.equal(one.taskRows.length,72);assert(one.taskRows.every(r=>r.state==='completed'&&r.scoreStatus==='scored'));const launched:any[]=[];
 for(const unit of plan.jobs[0].units){const attempt=attempts(root,plan.jobs[0],unit.configId)[0],life=read(join(attempt.path,'output','configs',unit.configId,'lifecycle.json'));const expected=unit.copies?Object.values(unit.copies).reduce((a,b)=>a+b,0):0;assert.equal(life.processes.length,expected);launched.push({configId:unit.configId,workers:life.processes.length,pids:life.processes.map((p:any)=>p.pid)});}
 const host=lines(join(root,'scheduler','host.jsonl')),peak={cpuPercent:Math.max(...host.map(r=>r.cpuPercent??0)),usedMemoryBytes:Math.max(...host.map(r=>r.usedMemoryBytes)),processCount:Math.max(...host.map(r=>r.processCount??0))};
 assert.equal(lines(join(root,'scheduler','events.jsonl')).find(r=>r.kind==='block-start').configs.length,18);json(join(root,'matrix-verification.json'),{configurations:18,tasks:72,workers:launched,hostPeak:peak,exportByteIdentical:true},true);console.log(JSON.stringify({matrix:'PASS',hostPeak:peak}));
}
