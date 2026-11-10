import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {join,resolve} from 'node:path';
import {mkdirSync,writeFileSync,readFileSync,readdirSync,existsSync,statSync,cpSync} from 'node:fs';
import {stage,comparisonView,command,referenceRoot} from './t8a-helpers.ts';
import {matrix,freeze} from '../src/ts/scheduler/plan.ts';
import {read,json,lines,files,sleep,env,ROOT} from '../src/ts/scheduler/io.ts';
import {attempts} from '../src/ts/scheduler/records.ts';
import {exportRun} from '../src/ts/scheduler/export.ts';
import {docker} from '../src/ts/docker/common.ts';
const root=resolve(process.argv[2]),split=resolve(process.argv[3]);mkdirSync(root,{recursive:true});
const cases=['multi_turn_base_0','multi_turn_base_4','multi_turn_base_10','multi_turn_base_11','multi_turn_miss_param_0','multi_turn_miss_param_4','multi_turn_miss_param_10','multi_turn_miss_param_36'];
const tag=process.argv.find(a=>a.startsWith('--tag='))?.slice(6)??'dev';
const imageId=JSON.parse((await docker(['image','inspect','ditto-sec1-bfcl:'+tag])).stdout)[0].Id;
const s=stage('t8c-main-shape',cases);s.configs=matrix();s.targetedSplit=split;s.batches[0].configs=s.configs.map(c=>c.id);s.blockSize=4;
s.launcher={kind:'docker',imageId,tag,runtime:{clockTicks:100,pageBytes:4096}};s.sampling.strict=true;s.stall={idleMs:180000,stopGraceMs:5000,pollMs:500};s.hostSampleMs=1000;
const barriers=join(root,'barriers');mkdirSync(barriers);const containerRoot=join(root,'docker'),plan=freeze(s,containerRoot);
json(join(root,'stage-docker.json'),s,true);
function launch(runRoot:string,options:any,label:string){const path=join(root,label+'-options.json');json(path,options,true);const args=['--experimental-transform-types','tests/t8c-runner.ts',runRoot,path];
  const child=spawn(process.execPath,args,{cwd:ROOT,windowsHide:true,env:env(join(root,'guards',label)),stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
  const done=new Promise<number|null>((yes,no)=>{child.once('error',no);child.once('close',code=>{json(join(root,label+'-process.json'),{command:['node',...args],pid:child.pid,code,stdout,stderr},true);yes(code);});});return {child,done};
}
const run=launch(containerRoot,{egress:{barriers}},'docker');
const overlap:any[]=[];
for(const job of plan.jobs){
  const end=Date.now()+240000;let observed=false;
  while(Date.now()<end){
    if(run.child.exitCode!==null)throw Error('scheduler exited before 18-container overlap: '+readFileSync(join(root,'docker-process.json'),'utf8'));
    const ids=(await docker(['ps','-q','--no-trunc','--filter','label=sec1.owner=ditto-sec1-bfcl','--filter','label=sec1.run='+s.runId])).stdout.trim().split(/\s+/).filter(Boolean);
    overlap.push({at:new Date().toISOString(),job:job.key,count:ids.length,ids});
    if(ids.length===18){observed=true;writeFileSync(join(barriers,'release-'+job.category),'release');break;}
    await sleep(250);
  }
  assert(observed,'18 containers did not overlap for '+job.key);
  // Block barriers are per category; only one block of each category is used in this matrix.
  while(!lines(join(containerRoot,'scheduler','events.jsonl')).some(e=>e.kind==='block-end'&&e.job===job.key)){assert(run.child.exitCode===null,'scheduler exited within block');await sleep(500);}
}
assert.equal(await run.done,0,read(join(root,'docker-process.json')).stderr);json(join(root,'container-overlap.json'),overlap,true);
assert.equal(read(join(containerRoot,'scheduler','stop-report.json')).status,'complete');
const resourceOnly=process.argv.includes('--resource-only'),summaries:any[]=[];
if(resourceOnly){
  const exported=exportRun(containerRoot,join(containerRoot,'export-1'));assert.equal(exported.taskRows.length,144);assert(exported.taskRows.every(r=>r.state==='completed'&&r.scoreStatus==='scored'));
  summaries.push({kind:'docker',tasks:144,scored:144,purpose:'Uncontended resource/IO resampling only; full functional comparisons are retained in main-matrix-release.'});
}else{
const local=structuredClone(s);local.launcher={kind:'local-process'};local.sampling.strict=false;
const localRoot=join(root,'local'),localPlan=freeze(local,localRoot);assert.deepEqual(localPlan.jobs,plan.jobs,'identical logical jobs, copies, seeds and orders');json(join(root,'stage-local.json'),local,true);
const hostRun=launch(localRoot,{},'local');assert.equal(await hostRun.done,0,read(join(root,'local-process.json')).stderr);assert.equal(read(join(localRoot,'scheduler','stop-report.json')).status,'complete');
for(const [kind,runRoot] of [['docker',containerRoot],['local',localRoot]] as const){
  const exported=exportRun(runRoot,join(runRoot,'export-1'));exportRun(runRoot,join(runRoot,'export-2'));
  assert.equal(exported.taskRows.length,144);assert(exported.taskRows.every(r=>r.state==='completed'&&r.scoreStatus==='scored'));
  if(kind==='docker')for(const row of exported.summary)for(const key of ['cpuSeconds','gbSeconds','cpuPerComplete','cpuPerCorrect','gbPerComplete','gbPerCorrect'])assert(typeof row[key]==='number'&&Number.isFinite(row[key]),`${row.configId}/${row.category}: ${key} must have a measured value`);
  assert(exported.taskRows.every(r=>Array.isArray(r.selectedItemCounts)&&r.selectedItemCounts.length>0));
  for(const p of files(join(runRoot,'export-1')))assert(readFileSync(p).equals(readFileSync(p.replace('export-1','export-2'))));
  comparisonView(runRoot,join(runRoot,'compare-input'));json(join(runRoot,'cases.json'),cases,true);
  const comp=await command(s.python,['-B','-X','utf8','scripts/compare.py','--new-run',join(runRoot,'compare-input'),'--old-run',join(referenceRoot,'runs/multiturn-full800-001'),'--cases',join(runRoot,'cases.json'),'--output',join(runRoot,'comparison')],join(runRoot,'comparison-process'));assert.equal(comp.code,0,comp.stdout+comp.stderr);
  summaries.push({kind,tasks:exported.taskRows.length,scored:144,selectedCountsPresent:144,exportByteIdentical:true});
}
// Both deployments are independently compared with the same immutable reference above.
// Also put all 36 output configurations in one comparison to exercise direct cross-deployment requests.
const combined=join(root,'combined'),requests:any[]=[];
for(const [kind,runRoot] of [['docker',containerRoot],['local',localRoot]] as const){
  const input=join(runRoot,'compare-input');for(const cid of readdirSync(join(input,'configs'))){
    const newId=kind+'-'+cid,dst=join(combined,'configs',newId);mkdirSync(dst,{recursive:true});cpSync(join(input,'configs',cid),dst,{recursive:true});
    for(const p of files(dst).filter(p=>p.endsWith('.json'))){const data=read(p);data.configId=newId;writeFileSync(p,JSON.stringify(data));}
  }
  for(const row of lines(join(input,'egress','requests.jsonl')))requests.push({...row,configId:kind+'-'+row.configId});
}
mkdirSync(join(combined,'egress'),{recursive:true});writeFileSync(join(combined,'egress','requests.jsonl'),requests.map(r=>JSON.stringify(r)).join('\n')+'\n');json(join(root,'all-cases.json'),cases,true);
const cross=await command(s.python,['-B','-X','utf8','scripts/compare.py','--new-run',combined,'--old-run',join(referenceRoot,'runs/multiturn-full800-001'),'--cases',join(root,'all-cases.json'),'--output',join(root,'cross-comparison')],join(root,'cross-process'));assert.equal(cross.code,0,cross.stdout+cross.stderr);
}
const blocks=[];
for(const job of plan.jobs){const units=[];for(const u of job.units){
  const a=attempts(containerRoot,job,u.configId)[0],dir=join(a.path,'output','configs',u.configId),exit=read(join(a.path,'collected.json')),resources=lines(join(dir,'resources.jsonl')),cgroup=resources.filter(r=>r.kind==='cgroup'),life=read(join(dir,'lifecycle.json'));
  assert.equal(life.processes.length,u.copies?Object.values(u.copies).reduce((a,b)=>a+b,0):0);assert(resources.every(r=>r.available===true),'strict resource samples must all be available');
  const paths=files(a.path),io=paths.filter(p=>/io-\d+\.json$/.test(p)).map(p=>read(p)),seconds=Number(BigInt(exit.summary.tasksEnded.ns)-BigInt(exit.summary.tasksStarted.ns))/1e9;
  const declared=read(join(a.path,'logs','create-command.json')),actual=declared.map((v:string)=>v==='/app/scripts/docker-entry.py'?'/unit/entry.py':v);
  units.push({configId:u.configId,imageId,startedAt:exit.startedAt,endedAt:exit.endedAt,copies:u.copies??null,workers:life.processes.length,activeSeconds:seconds,questionsPerSecond:4/seconds,cpuPeakCores:cgroup.length>1?Math.max(...cgroup.slice(1).map((r,i)=>(r.cpuUs-cgroup[i].cpuUs)/1000/(Date.parse(r.at.wall)-Date.parse(cgroup[i].at.wall)))):null,memoryPeakBytes:Math.max(...cgroup.map(r=>r.rssBytes)),processPeak:Math.max(...resources.filter(r=>r.kind==='processes').map(r=>r.rows?.length??0)),threadPeak:Math.max(...lines(join(a.path,'logs','pids.jsonl')).map(r=>r.peak)),writtenFileBytes:paths.reduce((n,p)=>n+statSync(p).size,0),jsonlBytes:paths.filter(p=>p.endsWith('.jsonl')).reduce((n,p)=>n+statSync(p).size,0),nodeSynchronousIO:io,maxNodeWriteFraction:Math.max(...io.map(r=>r.syncWriteMs/r.lifetimeMs)),declaredCreateCommand:declared,actualCreateCommand:actual,testEntryDifference:'The copied /unit/entry.py adds only the acceptance hook import for fault/IO observation; the unmodified production entry is separately exercised by t8c-release-smoke.ts'});
  assert(cgroup.length>=2,'the container sampler covers the task window');
  const real=resources.flatMap(r=>r.rows??[]);assert(real.some(r=>r.role==='python'&&typeof r.command==='string'&&r.command.includes('/unit/entry.py')));assert(real.some(r=>r.pid===1&&r.role==='main'));
}
const events=lines(join(containerRoot,'scheduler','events.jsonl')),start=events.find(e=>e.kind==='block-start'&&e.job===job.key),end=events.find(e=>e.kind==='block-end'&&e.job===job.key),host=lines(join(containerRoot,'scheduler','host.jsonl')).filter(r=>r.at>=start.at&&r.at<=end.at);
blocks.push({job:job.key,start:start.at,end:end.at,containers:18,overlapProven:true,hostPeak:{cpuPercent:Math.max(...host.map(r=>r.cpuPercent??0)),usedMemoryBytes:Math.max(...host.map(r=>r.usedMemoryBytes)),processCount:Math.max(...host.map(r=>r.processCount??0))},units});}
assert.equal((await docker(['ps','-aq','--filter','label=sec1.owner=ditto-sec1-bfcl','--filter','label=sec1.run='+s.runId])).stdout.trim(),'');
json(join(root,'matrix-verification.json'),{status:'PASS',imageId,resourceOnly,logicalPlansIdentical:resourceOnly?null:true,blocks,summaries,fourGatesAndCrossDeployment:resourceOnly?'Not repeated in resource-only resampling; use main-matrix-release.':'zero differences',ownerContainers:0,warning:'Offline engineering replay; timing is not real-model performance. Startup-barrier waiting is included in the recorded task windows; synchronous I/O instrumentation is acceptance-only.'},true);
console.log(JSON.stringify({status:'PASS',imageId,blocks:2,configurations:18,dockerTasks:144,localTasks:resourceOnly?0:144,resourceOnly,fourGatesAndCrossDeployment:resourceOnly?'not repeated':'zero differences'}));
