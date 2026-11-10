import assert from 'node:assert/strict';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {existsSync} from 'node:fs';
import {exportRun,legacyResourceSampler} from '../src/ts/scheduler/export.ts';
import {read,lines,json} from '../src/ts/scheduler/io.ts';
const root=resolve(process.argv[2]),output=resolve(process.argv[3]);
const plan=read(join(root,'plan.json'));assert.equal(plan.fingerprints['src/ts/resource-sampler.ts'],legacyResourceSampler);
if(existsSync('before/src/ts/scheduler/export.ts')){
  const old=await import(pathToFileURL(resolve('before/src/ts/scheduler/export.ts')).href),before=old.exportRun(root,join(output,'before'));
  assert.equal(before.summary.length,36);assert(before.summary.every((r:any)=>r.cpuSeconds===null&&r.gbSeconds===null));
}
const after=exportRun(root,join(output,'after'));assert.equal(after.summary.length,36);const hand=[];
for(const row of after.summary){
  for(const key of ['cpuSeconds','gbSeconds','cpuPerComplete','cpuPerCorrect','gbPerComplete','gbPerCorrect'])assert.equal(typeof row[key],'number',row.configId+'/'+key);
  const b=after.blockRows.find(r=>r.configId===row.configId&&r.category===row.category),a=b.attempts[0];assert(a.resourceTailMs<=1000);assert(a.legacyResourceSampler);assert(a.missing.some((m:string)=>m.includes('legacy limit')));assert(row.missing.some((m:string)=>m.includes('tail gap')));assert(b.missing.some((m:string)=>m.includes('tail gap')));
  if(hand.length<3){
    const job=plan.jobs.find((j:any)=>j.category===row.category),dir=join(root,'blocks',job.blockId,row.configId,'r1/attempt-1/output/configs',row.configId),s=read(join(dir,'block-summary.json')),cg=lines(join(dir,'resources.jsonl')).filter(r=>r.kind==='cgroup');
    const start=Date.parse(s.tasksStarted.wall),end=Date.parse(s.tasksEnded.wall);let cpu=0,gb=0;
    for(let i=1;i<cg.length;i++){const a=cg[i-1],b=cg[i],t=Date.parse(a.at.wall),span=Date.parse(b.at.wall)-t,lo=Math.max(0,start-t),hi=Math.min(span,end-t);if(span<=0||hi<=lo)continue;cpu+=(b.cpuUs-a.cpuUs)*(hi-lo)/span/1e6;gb+=(a.rssBytes*(hi-lo)+(b.rssBytes-a.rssBytes)*(hi*hi-lo*lo)/(2*span))/1e12;}
    assert(Math.abs(row.cpuSeconds-cpu)<1e-8);assert(Math.abs(row.gbSeconds-gb)<1e-8);hand.push({configId:row.configId,category:row.category,cpuSeconds:cpu,gbSeconds:gb,tailGapMs:end-Date.parse(cg.at(-1).at.wall),samplingIntervalMs:read(join(dir,'block.json')).sampling.intervalMs});
  }
}
json(join(output,'verification.json'),{status:'PASS',sourceRoot:root,samplerHash:legacyResourceSampler,rows:36,beforeAllNull:true,afterSixResourceColumnsPresent:true,allowanceMs:1000,noExtrapolation:true,hand});console.log(JSON.stringify({status:'PASS',rows:36,hand}));
