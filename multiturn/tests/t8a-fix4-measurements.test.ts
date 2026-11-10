import {exportRows} from '../src/ts/scheduler/export-stream.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {mkdirSync,writeFileSync,readFileSync} from 'node:fs';
import {freeze,matrix,categories} from '../src/ts/scheduler/plan.ts';
import {exportRun} from '../src/ts/scheduler/export.ts';
import {profile} from '../src/ts/scheduler/profile.ts';
import {reconnect} from '../src/ts/scheduler/reconnect.ts';
import {json,read,lines,files,ROOT} from '../src/ts/scheduler/io.ts';
import {stage,scratch} from './t8a-helpers.ts';
import {block,launchBlock,sampleOutput} from './t7-helpers.ts';
const persist=(p:string,rows:any[])=>writeFileSync(p,rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
function sameExports(root:string,label:string){const a=join(root,label+'-1'),b=join(root,label+'-2');exportRun(root,a);exportRun(root,b);for(const p of files(a))assert(readFileSync(p).equals(readFileSync(p.replace(a,b))));return a;}

test('actual SAMPLE retry 0/1/2/3: Direct and Monolithic exports preserve raw times; old logs unknown',async()=>{
 for(const group of ['Direct','Monolithic'] as const)for(const retries of [0,1,2,3]){
  const root=scratch(),s=stage('fix4-sample',['multi_turn_base_0']);s.configs=[matrix().find(c=>c.group===group&&c.c===1)!];s.batches[0].configs=s.configs.map(c=>c.id);
  const plan=freeze(s,root),job=plan.jobs[0],cid=s.configs[0].id,a=join(root,'blocks',job.blockId,cid,'r1/attempt-1'),trace=join(root,'sockets.jsonl');
  json(join(a,'attempt.json'),{number:1,unitId:'test',caseIds:job.caseIds});
  const server=createServer(async(req,res)=>{for await(const _ of req){};res.end(JSON.stringify({ok:true,output:{...sampleOutput,message:{...sampleOutput.message,metadata:{modelTiming:{apiMs:17,rateWaitMs:0,retryRateWaitMs:0,budgetWaitMs:0}}}}}));});
  server.listen(0,'127.0.0.1');await once(server,'listening');const port=(server.address() as any).port;
  if(retries)await new Promise<void>(r=>server.close(()=>r()));
  const hook=pathToFileURL(join(ROOT,'tests/t7-fix4-network-hook.mjs'));hook.searchParams.set('port',String(port));hook.searchParams.set('file',trace);
  const old=process.env.NODE_OPTIONS;process.env.NODE_OPTIONS=`${old??''} --import=${hook.href}`;
  let timer:ReturnType<typeof setInterval>|undefined;
  try{
   if(retries)timer=setInterval(()=>{if(lines(trace).filter(r=>r.event==='close').length>=retries){clearInterval(timer);server.listen(port,'127.0.0.1');}},10);
   const b=await block(join(a,'output'),`http://127.0.0.1:${port}`,group,cid);b.runId=s.runId;
   const run=await launchBlock(b),result=await run.done;assert.equal(result.code,0,JSON.stringify(result));
   const raw=lines(join(run.directory,'steps.jsonl')),samples=raw.filter(r=>r.node==='INFER.REASONING.SAMPLE');assert.equal(samples[0].connectRetries,retries);
   const out=sameExports(root,'export'),steps=Array.from(exportRows(out,'steps')),tasks=read(join(out,'tasks.json')),original=read(files(join(run.directory,'tasks'))[0]);
   for(const r of raw){const e=steps.find((e:any)=>e.invocationId===r.invocationId);assert.equal(e.workMs,r.workMs);assert.equal(e.connectRetries,r.connectRetries??null);assert.equal(e.connectRetryWaitMs,r.connectRetryWaitMs??null);assert.equal(e.workExcludingConnectRetryMs,r.node==='INFER.REASONING.SAMPLE'?r.workMs-r.connectRetryWaitMs:r.workMs);assert.equal(e.apiMs,r.modelTiming?.apiMs??null);const event=original.workerEvents.find((v:any)=>v.invocationId===r.invocationId);if(event)assert.equal(e.serviceMs,event.serviceMs);}
   assert(steps.filter((r:any)=>r.node==='INFER.REASONING.SAMPLE').every((r:any)=>r.apiMs===17&&r.serviceMs===r.workMs));
   assert.equal(tasks[0].elapsedSeconds,original.elapsedSeconds);assert.equal(read(join(out,'blocks.json'))[0].activeSeconds,Number(BigInt(read(join(run.directory,'block-summary.json')).tasksEnded.ns)-BigInt(read(join(run.directory,'block-summary.json')).tasksStarted.ns))/1e9);
   const summary=read(join(out,'summary.json'))[0];assert.equal(summary.connectRetries,retries);assert.equal(summary.connectRetryWaitMs,samples.reduce((n,r)=>n+r.connectRetryWaitMs,0));
   console.log(JSON.stringify({root,group,retries,summary,net:samples.map(r=>reconnect(r)),byteIdentical:true}));
   if(retries===0){persist(join(run.directory,'steps.jsonl'),raw.map(({connectRetries,connectRetryWaitMs,...row})=>row));const legacy=sameExports(root,'legacy'),missing=read(join(legacy,'metadata.json')).missing;for(const k of ['connectRetries','connectRetryWaitMs','workExcludingConnectRetryMs']){assert(Array.from(exportRows(legacy,'steps')).filter((r:any)=>r.node==='INFER.REASONING.SAMPLE').every((r:any)=>r[k]===null));assert(missing.some((m:string)=>m.startsWith(k+':')));}assert.equal(read(join(legacy,'summary.json'))[0].connectRetries,null);assert.equal(read(join(legacy,'summary.json'))[0].connectRetryWaitMs,null);persist(join(run.directory,'steps.jsonl'),raw);}
  }finally{clearInterval(timer);if(old===undefined)delete process.env.NODE_OPTIONS;else process.env.NODE_OPTIONS=old;server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
 }
});

function syntheticProfile(wait:number){
 const root=scratch(),s=read(join(ROOT,'config/stages/profile.json'));s.runId='synthetic-profile';const p=freeze(s,root),paths:string[]=[];
 for(const job of p.jobs){const cid=job.units[0].configId,a=join(root,'blocks',job.blockId,cid,'r1/attempt-1'),dir=join(a,'output','configs',cid);json(join(a,'attempt.json'),{number:1,caseIds:job.caseIds,unitId:'synthetic'});json(join(dir,'block-summary.json'),{exitCode:0,failed:0,notStarted:0});const rows:any[]=[];
  for(const caseId of job.caseIds){const taskId=caseId;json(join(dir,'tasks',caseId+'.json'),{caseId,taskId,configId:cid,round:1,status:'completed',modelSteps:[],completed:[]});for(const [node,workMs] of [['CONTEXT.SELECT',80],['INFER.REASONING.SAMPLE',20],['INTERACTION.ACT.TOOL',1],['MEMORY.STORE',1]] as const)rows.push({taskId,node,graphId:'real',workMs:workMs+(node.includes('SAMPLE')?wait:0),...(node.includes('SAMPLE')?{connectRetries:wait?3:0,connectRetryWaitMs:wait}:{})});}
  const path=join(dir,'steps.jsonl');persist(path,rows);paths.push(path);
 }return {root,paths};
}
test('profiling ignores reconnect waits; reports deductions; rejects missing and invalid measurements',()=>{
 const a=syntheticProfile(0),b=syntheticProfile(7000),pa=profile(a.root,join(a.root,'split.json')),pb=profile(b.root,join(b.root,'split.json'));
 for(const c of categories){assert.deepEqual(pa.byCategory[c].copies,pb.byCategory[c].copies);assert.deepEqual(pa.byCategory[c].A,pb.byCategory[c].A);assert.equal(pb.byCategory[c].connectRetryWaitMs,56000);assert.equal(pb.byCategory[c].connectRetries,24);}
 for(const key of ['connectRetries','connectRetryWaitMs']){const old=readFileSync(b.paths[0],'utf8');persist(b.paths[0],lines(b.paths[0]).map(r=>{delete r[key];return r;}));assert.throws(()=>profile(b.root,join(b.root,'invalid.json')),/Missing or invalid profiling connectRetries\/connectRetryWaitMs/);writeFileSync(b.paths[0],old);}
 for(const bad of [{connectRetries:-1},{connectRetryWaitMs:-1},{connectRetryWaitMs:9000}]){const old=readFileSync(b.paths[0],'utf8');persist(b.paths[0],lines(b.paths[0]).map(r=>r.node.includes('SAMPLE')?{...r,...bad}:r));assert.throws(()=>profile(b.root,join(b.root,'invalid.json')),/Missing or invalid profiling/);writeFileSync(b.paths[0],old);}
 console.log(JSON.stringify({without:a.root,with:b.root,pa,pb}));
});
