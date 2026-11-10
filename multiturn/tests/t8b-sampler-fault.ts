import assert from 'node:assert/strict';
import { mkdir,mkdtemp,readFile,cp,rm } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DockerLauncher } from '../src/ts/docker/launcher.ts';
import type { RunUnitSpec } from '../src/ts/run-unit.ts';
import { docker,labels,inspect,removeExited,save } from '../src/ts/docker/common.ts';
import { block,fakeServer } from './t7-helpers.ts';
const parent=join(tmpdir(),'t8b-scratch');await mkdir(parent,{recursive:true});const root=await mkdtemp(join(parent,'sampler-fault-'));
const imageId=JSON.parse((await docker(['image','inspect','ditto-sec1-bfcl:dev'])).stdout)[0].Id;
const runtime=JSON.parse(await readFile('runs/offline/t8b-20261105/runtime.json','utf8')).runtime;
const runId='t8b-sampler-'+process.pid;
class BrokenCgroup extends DockerLauncher {
  override toUnitView(spec:RunUnitSpec){const view=super.toUnitView(spec);view.sampling.cgroupDirectory='/t8b-deliberately-missing-cgroup';return view;}
}
const launcher=new BrokenCgroup(imageId,runtime),gateway=await fakeServer((_request,response)=>response.end('{}'));
try{
  const b=await block(root,gateway.url);b.runId=runId;b.sampling.strict=true;
  const spec={runId,unitId:'cgroup-fault',block:{...b},outputRoot:root,logDir:join(root,'unit'),guardReportDir:join(root,'guards'),egressUrl:gateway.url};
  const unit=await launcher.start(spec),exit=await unit.wait();assert.equal(exit.exitCode,1);assert.equal((exit.summary as any).completed,0);assert.match((exit.summary as any).stopReason,/cpu\.stat.*ENOENT/);assert.equal(gateway.requests,0);
  const samples=(await readFile(join(root,'configs',b.configId,'resources.jsonl'),'utf8')).trim().split('\n').map(l=>JSON.parse(l));assert(samples.some(r=>r.kind==='cgroup'&&r.available===false));
  console.log(JSON.stringify({test:'real container missing cgroup stops strict config',imageId,exit,modelRequests:gateway.requests,samples}));
  // Deterministic boundary fixtures in a Linux container: record an exited PID but keep live-read errors strict.
  const source=`import assert from 'node:assert/strict';import fs from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';
const root='/output/fixture';await fs.mkdir(root+'/cg',{recursive:true});await fs.mkdir(root+'/proc',{recursive:true});
for(const [name,value] of Object.entries({'cpu.stat':'usage_usec 1','memory.current':'1','cpu.max':'200000 100000','memory.max':'4294967296','memory.swap.max':'0','cgroup.procs':'987654'}))await fs.writeFile(root+'/cg/'+name,value);
const original=fs.readFile;let mode='gone';fs.readFile=async function(path,...args){if(String(path).startsWith(root+'/proc/987654/')||String(path).startsWith(root+'/proc/987655/')){if(mode==='gone')await fs.writeFile(root+'/cg/cgroup.procs','');if(mode==='mixed'&&String(path).includes('/987654/'))await fs.writeFile(root+'/cg/cgroup.procs','987655');const e=Error('injected process read failure');e.code='EACCES';throw e;}return original.call(this,path,...args);};syncBuiltinESMExports();
const {resourceSampler}=await import('/app/src/ts/resource-sampler.ts');const settings={enabled:true,strict:true,intervalMs:10000,processIntervalMs:10000,cgroupDirectory:root+'/cg',procDirectory:root+'/proc',clockTicks:100,pageBytes:4096,expected:{cpuMax:'200000 100000',memoryMax:'4294967296',swapMax:'0'}};
const sampler=await resourceSampler('/output/disappeared.jsonl',settings,()=>[],()=>{throw Error('must not stop for disappeared PID')});await sampler.stop();
const rows=(await original('/output/disappeared.jsonl','utf8')).trim().split('\\n').map(JSON.parse);const proc=rows.find(r=>r.kind==='processes');assert.equal(proc.available,true);assert.equal(proc.rows[0].exitedDuringSample,true);assert.equal(proc.rows[0].cpuSeconds,null);assert(proc.rows[0].reasons[0].includes('injected'));
mode='live';await fs.writeFile(root+'/cg/cgroup.procs','987654');await assert.rejects(resourceSampler('/output/live-error.jsonl',settings,()=>[],()=>{}),/injected process read failure/);
await fs.mkdir(root+'/proc/123',{recursive:true});for(const name of ['stat','statm','cmdline'])await fs.writeFile(root+'/proc/123/'+name,await original('/proc/self/'+name));
await fs.writeFile(root+'/cg/cgroup.procs','123 987654');const partial=await resourceSampler('/output/partial.jsonl',{...settings,strict:false},()=>[],()=>{});await partial.stop();
assert.equal((await original('/output/partial.jsonl','utf8')).trim().split('\\n').map(JSON.parse).find(r=>r.kind==='processes').available,'partial');
mode='mixed';await fs.writeFile(root+'/cg/cgroup.procs','987654 987655');const none=await resourceSampler('/output/none.jsonl',{...settings,strict:false},()=>[],()=>{});await none.stop();
assert.equal((await original('/output/none.jsonl','utf8')).trim().split('\\n').map(JSON.parse).find(r=>r.kind==='processes').available,false);
console.log(JSON.stringify({disappearedPidNullAndReasonRecorded:true,strictDidNotStop:true,availableForNormalDisappearance:proc.available,permissionErrorForStillListedPidRemainsStrict:true,mixedLiveCoverage:'partial',noUsableLiveRows:false,departedRowsNotCountedAsUsable:true}));`;
  const args=['create','--pull=never',...labels(runId,'boundary-fixtures'),'--network','none','--mount',`type=bind,source=${root},target=/output`,imageId,'node','--experimental-transform-types','--input-type=module','-e',source];
  const id=(await docker(args)).stdout.trim();await docker(['start',id]);await docker(['wait',id]);const info=await inspect(id),log=await docker(['logs',id]);await save(join(root,'fixture-process.json'),{command:['docker',...args],info,log});await removeExited(id,runId,'boundary-fixtures');console.log(log.stdout,log.stderr);assert.equal(info.State.ExitCode,0);
}finally{await gateway.close();await cp(root,resolve('runs/offline/t8b-20261105/raw',root.split(/[\\/]/).at(-1)!),{recursive:true});if(!(await launcher.list(runId)).length)await rm(root,{recursive:true});}
