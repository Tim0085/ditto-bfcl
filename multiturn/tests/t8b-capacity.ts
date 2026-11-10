// Run after the protected T7 sampler has been repaired; never relax strict sampling.
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,readFile,readdir,cp,rm } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DockerLauncher,PIDS_LIMIT } from '../src/ts/docker/launcher.ts';
import { docker } from '../src/ts/docker/common.ts';
import { block,egress } from './t7-helpers.ts';
const parent=join(tmpdir(),'t8b-scratch');await mkdir(parent,{recursive:true});const root=await mkdtemp(join(parent,'capacity-'));
const imageId=JSON.parse((await docker(['image','inspect','ditto-sec1-bfcl:dev'])).stdout)[0].Id;
const runtime=JSON.parse(await readFile('runs/offline/t8b-20261105/runtime.json','utf8')).runtime;
const launcher=new DockerLauncher(imageId,runtime),gateway=await egress(root,'replay');
const cases=Array.from({length:16},(_,i)=>'multi_turn_base_'+i),runId='t8b-capacity-'+process.pid;
try{
  const b=await block(root,gateway.url,'Uniform','uniform32-c8',8,cases);b.runId=runId;b.copies={Context:8,Infer:8,Interaction:8,Memory:8};b.sampling.strict=true;
  const spec={runId,unitId:b.configId,block:{...b},outputRoot:root,logDir:join(root,'unit'),guardReportDir:join(root,'guards'),egressUrl:gateway.url};
  const unit=await launcher.start(spec),exit=await unit.wait();console.log(JSON.stringify({imageId,exit}));assert.equal(exit.exitCode,0);assert.equal((exit.summary as any).completed,16);assert.equal((exit.summary as any).maxActive,8);
  const directory=join(root,'configs',b.configId),events:{at:bigint;delta:number}[]=[];
  for(const id of cases){const task=JSON.parse(await readFile(join(directory,'tasks',id+'.r1.json'),'utf8'));events.push({at:BigInt(task.started.ns),delta:1},{at:BigInt(task.ended.ns),delta:-1});}
  events.sort((a,b)=>a.at===b.at?a.delta-b.delta:a.at<b.at?-1:1);let active=0,actualPeak=0;for(const event of events){active+=event.delta;actualPeak=Math.max(active,actualPeak);}assert.equal(actualPeak,8);
  const resources=(await readFile(join(directory,'resources.jsonl'),'utf8')).trim().split('\n').map(l=>JSON.parse(l));assert(resources.every(row=>row.available===true));
  const life=JSON.parse(await readFile(join(directory,'lifecycle.json'),'utf8'));assert.equal(life.processes.length,32);
  const samples=(await readFile(join(spec.logDir,'pids.jsonl'),'utf8')).trim().split('\n').map(l=>JSON.parse(l));const peak=Math.max(...samples.map(r=>r.peak));
  assert(peak<=PIDS_LIMIT/2,'Remeasure and select limit with at least 2x observed peak before accepting');
  const reports=await readdir(spec.guardReportDir);assert.equal(reports.length,33);for(const name of reports)assert.equal(JSON.parse(await readFile(join(spec.guardReportDir,name),'utf8')).deniedOperations,0);
  console.log(JSON.stringify({tasks:16,workers:32,requestedConcurrency:8,actualOverlappingTasks:actualPeak,threadPeak:peak,pidsLimit:PIDS_LIMIT,headroom:PIDS_LIMIT-peak,selectionRule:'at least twice measured peak',allSamplesAvailable:true,guardReports:33}));
}finally{await gateway.close();await cp(root,resolve('runs/offline/t8b-20261105/raw',root.split(/[\\/]/).at(-1)!),{recursive:true});if(!(await launcher.list(runId)).length)await rm(root,{recursive:true});}
