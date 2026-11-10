import assert from 'node:assert/strict';
import {join,resolve} from 'node:path';
import {readFileSync,statSync} from 'node:fs';
import {read,json,lines,files} from '../src/ts/scheduler/io.ts';
import {checkPlan,type Plan} from '../src/ts/scheduler/plan.ts';
import {attempts,merged} from '../src/ts/scheduler/records.ts';
import {docker} from '../src/ts/docker/common.ts';
const root=resolve(process.argv[2]),output=resolve(process.argv[3]??join(root,'independent-audit-'+process.pid)),containerRoot=join(root,'docker'),localRoot=join(root,'local'),plan=read<Plan>(join(containerRoot,'plan.json')),local=read<Plan>(join(localRoot,'plan.json'));
checkPlan(plan);checkPlan(local);assert.deepEqual(local.jobs,plan.jobs);assert.equal(plan.jobs.length,2);assert.equal(plan.stage.configs.length,18);
const imageId=(plan.stage.launcher as any).imageId,overlap=read(join(root,'container-overlap.json')),summaries=[];
for(const job of plan.jobs)assert(overlap.some((r:any)=>r.job===job.key&&r.count===18&&r.ids.length===18));
for(const [kind,runRoot] of [['docker',containerRoot],['local',localRoot]]){
  assert.equal(read(join(runRoot,'scheduler','stop-report.json')).status,'complete');
  const tasks=read(join(runRoot,'export-1','tasks.json'));assert.equal(tasks.length,144);assert(tasks.every((r:any)=>r.state==='completed'&&r.scoreStatus==='scored'));
  for(const path of files(join(runRoot,'export-1')))assert(readFileSync(path).equals(readFileSync(path.replace('export-1','export-2'))));
  for(const job of plan.jobs)for(const unit of job.units){const a=attempts(runRoot,job,unit.configId)[0],raw=lines(join(a.path,'output','configs',unit.configId,'steps.jsonl')),records=merged(runRoot,job,unit.configId);assert.equal(records.size,4);
    for(const record of records.values()){const expected=raw.filter(r=>r.taskId===record.data.taskId&&r.node==='CONTEXT.SELECT').map(r=>r.selectedItemIds.length),exported=tasks.find((r:any)=>r.configId===unit.configId&&r.blockId===job.blockId&&r.caseId===record.data.caseId);assert(expected.length>0);assert.deepEqual(exported.selectedItemCounts,expected);}
  }
  const comparison=read(join(runRoot,'comparison','summary.json'));assert.equal(comparison.status,'通过');assert(Object.values(comparison.differenceCounts).every(n=>n===0));
  assert.equal(read(join(runRoot,'comparison-process.json')).code,0);
  summaries.push({kind,tasks:144,scored:144,selectedCountsRecomputed:144,exportByteIdentical:true,fourGateDifferences:comparison.differenceCounts});
}
const cross=read(join(root,'cross-comparison','summary.json'));assert.equal(cross.status,'通过');assert.equal(cross.configs.length,36);assert(Object.values(cross.differenceCounts).every(n=>n===0));assert.equal(read(join(root,'cross-process.json')).code,0);
const blocks=[],roleEvidence=[];
for(const job of plan.jobs){const units=[];
  for(const unit of job.units){const a=attempts(containerRoot,job,unit.configId)[0],dir=join(a.path,'output','configs',unit.configId),exit=read(join(a.path,'collected.json')),inspect=read(join(a.path,'logs','inspect.json')),saved=read(join(a.path,'logs','unit.json')),resources=lines(join(dir,'resources.jsonl')),cgroup=resources.filter(r=>r.kind==='cgroup'),life=read(join(dir,'lifecycle.json')),expected=unit.copies?Object.values(unit.copies).reduce((a,b)=>a+b,0):0;
    assert.equal(exit.exitCode,0);assert.equal(exit.oomKilled,false);assert.equal(exit.summary.completed,4);assert.equal(exit.summary.failed,0);assert.equal(saved.imageId,imageId);assert.equal(inspect.Image,imageId);assert.equal(life.processes.length,expected);
    assert.equal(inspect.HostConfig.NanoCpus,2e9);assert.equal(inspect.HostConfig.Memory,4*1024**3);assert.equal(inspect.HostConfig.MemorySwap,4*1024**3);assert.equal(inspect.HostConfig.PidsLimit,1024);assert.equal(inspect.Config.User,'1000:1000');assert.equal(inspect.HostConfig.Init,true);assert.equal(inspect.HostConfig.AutoRemove,false);assert.equal(inspect.HostConfig.RestartPolicy.Name,'no');
    assert(cgroup.length>=2);assert(resources.every(r=>r.available===true));
    const processes=resources.flatMap(r=>r.rows??[]),commands=processes.filter(r=>typeof r.command==='string');
    const supervisor=commands.find(r=>r.role==='python'&&r.command.includes('/unit/entry.py')),init=commands.find(r=>r.pid===1&&r.role==='main');assert(supervisor);assert(init);
    roleEvidence.push({configId:unit.configId,job:job.key,init,supervisor,bridge:commands.find(r=>r.command.includes('/src/python/bridge.py'))??null});
    const paths=files(a.path),io=paths.filter(p=>/io-\d+\.json$/.test(p)).map(p=>read(p));assert.equal(io.length,1+expected);
    const declared=read(join(a.path,'logs','create-command.json')),actual=declared.map((v:string)=>v==='/app/scripts/docker-entry.py'?'/unit/entry.py':v);
    const seconds=Number(BigInt(exit.summary.tasksEnded.ns)-BigInt(exit.summary.tasksStarted.ns))/1e9;
    units.push({configId:unit.configId,imageId,startedAt:exit.startedAt,endedAt:exit.endedAt,copies:unit.copies??null,workers:expected,activeSeconds:seconds,questionsPerSecond:4/seconds,cpuPeakCores:Math.max(...cgroup.slice(1).map((r,i)=>(r.cpuUs-cgroup[i].cpuUs)/1000/(Date.parse(r.at.wall)-Date.parse(cgroup[i].at.wall)))),memoryPeakBytes:Math.max(...cgroup.map(r=>r.rssBytes)),processPeak:Math.max(...resources.filter(r=>r.kind==='processes').map(r=>r.rows?.length??0)),threadPeak:Math.max(...lines(join(a.path,'logs','pids.jsonl')).map(r=>r.peak)),retainedFileBytes:paths.reduce((n,p)=>n+statSync(p).size,0),jsonlBytes:paths.filter(p=>p.endsWith('.jsonl')).reduce((n,p)=>n+statSync(p).size,0),nodeSynchronousIO:io.map(r=>({...r,command:commands.find(p=>p.pid===r.pid)?.command??null})),maxNodeWriteFraction:Math.max(...io.map(r=>r.syncWriteMs/r.lifetimeMs)),declaredCreateCommand:declared,actualCreateCommand:actual,testEntryDifference:'The copied /unit/entry.py adds only the acceptance hook import; t8c-release-smoke.ts exercises the unmodified image entry.'});
  }
  const events=lines(join(containerRoot,'scheduler','events.jsonl')),start=events.find(e=>e.kind==='block-start'&&e.job===job.key),end=events.find(e=>e.kind==='block-end'&&e.job===job.key),host=lines(join(containerRoot,'scheduler','host.jsonl')).filter(r=>r.at>=start.at&&r.at<=end.at);
  blocks.push({job:job.key,start:start.at,end:end.at,containers:18,overlapProven:true,hostPeak:{cpuPercent:Math.max(...host.map(r=>r.cpuPercent??0)),usedMemoryBytes:Math.max(...host.map(r=>r.usedMemoryBytes)),processCount:Math.max(...host.map(r=>r.processCount??0))},units});
}
assert.equal((await docker(['ps','-aq','--filter','label=sec1.owner=ditto-sec1-bfcl','--filter','label=sec1.run='+plan.runId])).stdout.trim(),'');
json(join(output,'process-role-evidence.json'),roleEvidence,true);
json(join(output,'matrix-verification.json'),{status:'PASS',imageId,logicalPlansIdentical:true,blocks,summaries,fourGatesAndCrossDeployment:cross.differenceCounts,ownerContainersForRun:0,notes:['This audit reconstructs all assertions from retained raw data; the fixture supervisor is /unit/entry.py.','Startup-barrier waiting is included in recorded task windows. Offline replay throughput is not model performance.','retainedFileBytes is final retained volume; nodeSynchronousIO bytes/time are cumulative outermost synchronous writes/appends/flushes, excluding async I/O.']},true);
console.log(JSON.stringify({status:'PASS',imageId,auditRoot:output,blocks:2,configurations:18,dockerTasks:144,localTasks:144,workersPerBlock:blocks[0].units.reduce((n,u)=>n+u.workers,0),fourGatesAndCrossDeployment:cross.differenceCounts}));
