import assert from 'node:assert/strict';
import {resolve,join} from 'node:path';
import {read,lines,json} from '../src/ts/scheduler/io.ts';
const root=resolve(process.argv[2]),plan=read(join(root,'docker/plan.json')),summary=read(join(root,'docker/export-1/summary.json')),blocks=read(join(root,'docker/export-1/blocks.json'));
const hand:any[]=[],memory:any[]=[];
for(const job of plan.jobs){
  const streams:any[]=[];
  for(const unit of job.units){
    const dir=join(root,'docker/blocks',job.blockId,unit.configId,'r1/attempt-1/output/configs',unit.configId),s=read(join(dir,'block-summary.json')),samples=lines(join(dir,'resources.jsonl')).filter(r=>r.kind==='cgroup');
    const start=Date.parse(s.tasksStarted.wall),end=Date.parse(s.tasksEnded.wall);assert(samples.every(r=>r.available===true));assert(Date.parse(samples[0].at.wall)<=start);assert(Date.parse(samples.at(-1).at.wall)>=end);
    let cpu=0,gb=0;
    for(let i=1;i<samples.length;i++){
      const a=samples[i-1],b=samples[i],t=Date.parse(a.at.wall),span=Date.parse(b.at.wall)-t,lo=Math.max(0,start-t),hi=Math.min(span,end-t);if(span<=0||hi<=lo)continue;
      cpu+=(b.cpuUs-a.cpuUs)*(hi-lo)/span/1e6;
      gb+=(a.rssBytes*(hi-lo)+(b.rssBytes-a.rssBytes)*(hi*hi-lo*lo)/(2*span))/1e12;
    }
    const actual=summary.find((r:any)=>r.configId===unit.configId&&r.category===job.category),attempt=blocks.find((r:any)=>r.configId===unit.configId&&r.category===job.category).attempts[0];
    for(const [key,expected] of Object.entries({cpuSeconds:cpu,gbSeconds:gb,cpuPerComplete:cpu/actual.completed,cpuPerCorrect:cpu/actual.correct,gbPerComplete:gb/actual.completed,gbPerCorrect:gb/actual.correct})){
      assert.equal(typeof actual[key],'number',key+' cannot be null');assert(Math.abs(actual[key]-expected)<=1e-8*Math.max(1,Math.abs(expected)),JSON.stringify({key,actual:actual[key],expected}));
    }
    if(hand.length<3)hand.push({configId:unit.configId,category:job.category,start,end,samples:samples.length,cpuSeconds:cpu,gbSeconds:gb,summary:actual,attemptMissing:attempt.missing});
    streams.push(samples.map(r=>({at:Date.parse(r.at.wall),rss:r.rssBytes})));
  }
  // Last observed value only while a stream's measured lifetime is covered. Do
  // not sum individual peaks, which would pretend all peaks occurred together.
  let peak=0,atPeak=0;
  for(const at of [...new Set(streams.flatMap(s=>s.map((r:any)=>r.at)))].sort((a,b)=>Number(a)-Number(b)) as number[]){
    let total=0;for(const samples of streams){if(at<samples[0].at||at>samples.at(-1).at)continue;let last=samples[0];for(const r of samples){if(r.at>at)break;last=r;}total+=last.rss;}
    if(total>peak){peak=total;atPeak=at;}
  }
  memory.push({job:job.key,containers:18,totalPeakMeasuredRssBytes:peak,at:new Date(atPeak).toISOString(),rule:'Sum time-aligned last-observed cgroup RSS only within each measured stream; not the sum of unrelated individual peaks'});
}
assert.equal(summary.length,36);assert.equal(hand.length,3);json(join(root,'independent-resource-audit.json'),{status:'PASS',imageId:plan.stage.launcher.imageId,rows:36,handCalculations:hand,memory});
console.log(JSON.stringify({status:'PASS',rows:36,handCalculations:hand.map(r=>({configId:r.configId,category:r.category,cpuSeconds:r.cpuSeconds,gbSeconds:r.gbSeconds})),memory}));
