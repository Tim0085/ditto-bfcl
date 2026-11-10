import {exportRows,fileEqual} from '../src/ts/scheduler/export-stream.ts';
import assert from 'node:assert/strict';
import {join,resolve} from 'node:path';
import {readFileSync,existsSync,readdirSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {read,lines,files,json} from '../src/ts/scheduler/io.ts';
import {attempts,merged} from '../src/ts/scheduler/records.ts';
import {exportRun} from '../src/ts/scheduler/export.ts';
const root=resolve(process.argv[2]),mode=process.argv[3];
if(mode==='matrix'){
 const p=read(join(root,'plan.json')),e=exportRun(root,join(root,'audit-export')),hand:any[]=[];
 assert.equal(e.taskRows.length,72);
 for(const row of e.taskRows){
  assert.equal(row.state,'completed');assert.equal(row.scoreStatus,'scored');const job=p.jobs.find((j:any)=>j.blockId===row.blockId),a=attempts(root,job,row.configId).find((a:any)=>a.number===row.attempt),raw=lines(join(a.path,'output/configs',row.configId,'steps.jsonl')).filter((r:any)=>r.taskId===`${p.runId}/${row.configId}/r${row.round}/${row.caseId}`);
  const nodes=[...new Set(raw.map((r:any)=>r.pid))],py=[...new Set(raw.filter((r:any)=>r.node==='INTERACTION.ACT.TOOL').map((r:any)=>r.pythonPid).filter((p:any)=>p>0))];
  assert.equal(py.length,1);assert.equal(row.processCount,nodes.length+py.length);const samples=raw.filter((r:any)=>r.node==='INFER.REASONING.SAMPLE');assert.equal(row.connectRetries,samples.reduce((n:number,r:any)=>n+r.connectRetries,0));assert.equal(row.connectRetryWaitMs,samples.reduce((n:number,r:any)=>n+r.connectRetryWaitMs,0));
  hand.push({configId:row.configId,caseId:row.caseId,nodePids:nodes,pythonPids:py,processCount:row.processCount,connectRetries:row.connectRetries,connectRetryWaitMs:row.connectRetryWaitMs});
 }
 json(join(root,'process-count-handcheck.json'),hand,true);
 // Read-only old exporter comparison, never launch the old scheduler.
 if(process.argv[4]){
  const old=await import(pathToFileURL(join(resolve(process.argv[4]),'src/ts/scheduler/export.ts')).href);old.exportRun(root,join(root,'baseline-export'));
  const changes:Record<string,string[]>={};
  for(const name of ['summary','tasks','steps','blocks','workers','resources','requests','host','scheduleEvents']){
   const a=read(join(root,'baseline-export',name+'.json')),b=['summary','tasks','blocks'].includes(name)?read(join(root,'audit-export',name+'.json')):Array.from(exportRows(join(root,'audit-export'),name));assert.equal(a.length,b.length);const fields=new Set<string>();
   a.forEach((r:any,i:number)=>{for(const k of new Set([...Object.keys(r),...Object.keys(b[i])]))if(JSON.stringify(r[k])!==JSON.stringify(b[i][k]))fields.add(k);});changes[name]=[...fields];
   const allowed:Record<string,string[]>={tasks:['processCount','missing','connectRetries','connectRetryWaitMs'],blocks:['attempts','missing']};assert(changes[name].every(k=>(allowed[name]??[]).includes(k)),JSON.stringify({name,changes}));
  }
  const oldBlocks=read(join(root,'baseline-export/blocks.json')),newBlocks=read(join(root,'audit-export/blocks.json'));
  for(const [i,block] of oldBlocks.entries())for(const [j,attempt] of block.attempts.entries())for(const key of Object.keys(attempt))assert.deepEqual(newBlocks[i].attempts[j][key],attempt[key],`normal attempt field changed: ${key}`);
  for(const name of ['summary','steps','workers','resources','requests','host','scheduleEvents','metadata','steps-Direct','steps-Monolithic','steps-Uniform','steps-Targeted']){
   const oldValue=read(join(root,'baseline-export',name+'.json'));
   if(name==='metadata'){const current=read(join(root,'audit-export/metadata.json'));delete current.tableSchemaVersion;delete current.tables;delete current.tableReading;assert.deepEqual(current,oldValue);}
   else assert.deepEqual(name==='summary'?read(join(root,'audit-export/summary.json')):Array.from(exportRows(join(root,'audit-export'),name)),oldValue);
  }
  json(join(root,'export-baseline-changes.json'),changes,true);console.log(JSON.stringify({oldVsNew:changes,normalReconnectSummaryBytesIdentical:true}));
 }
 for(const f of files(join(root,'export-1')))assert(readFileSync(f).equals(readFileSync(f.replace('export-1','export-2'))));console.log(JSON.stringify({M2:'PASS',tasks:hand.length,processCounts:hand.map(r=>r.processCount),allScored:true,doubleExportByteIdentical:true}));
}else if(mode==='recoveries'){
 const results:any[]=[];
 for(const name of readdirSync(root).filter(n=>/^(reserve|partial|rate)-\d+$/.test(n))){
  const r=join(root,name),p=read(join(r,'plan.json'));assert.equal(read(join(r,'scheduler/stop-report.json')).status,'complete');
  const records=[...merged(r,p.jobs[0],'direct-c4').values()];assert.equal(records.length,p.jobs[0].caseIds.length);assert(records.every(r=>r.kind==='tasks'));assert(!existsSync(join(r,'resume-2-process.json')),'one resume only');
  const recovery=files(join(r,'egress/recovery')).find(p=>p.endsWith('authorization.json'))!,a=read(recovery),after=read(join(recovery,'../after.json'));assert.equal(a.before.spentMicroUsd,after.spentMicroUsd);assert.equal(a.before.reservedMicroUsd+a.before.retainedMicroUsd,after.reservedMicroUsd+after.retainedMicroUsd);assert(!existsSync(join(r,'egress/stopped.json')));
  const prefix=readFileSync(join(recovery,'../ledger.jsonl.original'));assert(readFileSync(join(r,'egress/ledger.jsonl')).subarray(0,prefix.length).equals(prefix));const exported=exportRun(r,join(r,'audit-export'));assert(exported.taskRows.every(r=>r.scoreStatus==='scored'));
  if(a.rate.action!=='unchanged'){assert(existsSync(join(recovery,'../rate.jsonl.original')));assert(lines(join(r,'egress/rate.jsonl')).some(s=>s.id===a.rate.id&&s.recovered));}
  results.push({name,tasks:records.length,firstResumeExit:read(join(r,'resume-1-process.json')).code,rateAction:a.rate.action,heldMicroUsd:after.retainedMicroUsd});
 }
 assert(results.filter(r=>r.name.startsWith('reserve')).length>=5);assert(results.filter(r=>r.name.startsWith('partial')).length>=3);assert(results.filter(r=>r.name.startsWith('rate')).length>=1);json(join(root,'recovery-audit.json'),results,true);console.log(JSON.stringify(results));
}else if(mode==='kill'){
 const p=read(join(root,'plan.json')),a=exportRun(root,join(root,'manual-export')),row=a.summary[0],timings=a.blockRows[0].attempts;assert(timings.length>=2);assert.equal(row.notStarted,0);assert.equal(row.interrupted,0);assert.equal(row.scoringMissing,0);assert.equal(row.scoringFailed,0);
 let seconds=0;
 for(const t of timings){const attempt=attempts(root,p.jobs[0],row.configId).find(a=>a.number===t.attempt),summaryFile=join(attempt.path,'output/configs',row.configId,'block-summary.json'),summary=existsSync(summaryFile)?read(summaryFile):{};
  const exit=read(join(attempt.path,'collected.json'));const hand=summary.tasksEnded?.ns?Number(BigInt(summary.tasksEnded.ns)-BigInt(summary.tasksStarted.ns))/1e9:(Date.parse(exit.endedAt)-Date.parse(summary.tasksStarted?.wall??exit.startedAt))/1000;
  assert.equal(t.activeSeconds,hand);seconds+=hand;
 }
 assert.equal(row.goodput,row.correct/seconds);assert.equal(row.completionRate,row.completed/seconds);assert(row.nonConcurrent);console.log(JSON.stringify({M7:'PASS',attemptSeconds:timings.map((t:any)=>t.activeSeconds),seconds,correct:row.correct,completed:row.completed,goodput:row.goodput,completionRate:row.completionRate,source:timings.map((t:any)=>t.activeTimeSource)}));
}else throw Error('matrix | recoveries | kill required');
