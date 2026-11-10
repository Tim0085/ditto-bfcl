import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {constants as bufferConstants} from 'node:buffer';
import {mkdirSync,readdirSync,statSync,existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {stage} from './t8a-helpers.ts';
import {freeze,matrix} from '../src/ts/scheduler/plan.ts';
import {exportRun} from '../src/ts/scheduler/export.ts';
import {DetailTable,jsonRows,fileEqual,fileHash} from '../src/ts/scheduler/export-stream.ts';
import {read,json,env,ROOT} from '../src/ts/scheduler/io.ts';
const out=resolve(process.argv[2]);
if(process.argv.includes('--export-child')){
 const begin=Date.now();const result=exportRun(join(out,'input'),resolve(process.argv[3]));
 const usage={peakRssBytes:process.resourceUsage().maxRSS*1024,endingMemory:process.memoryUsage(),elapsedMs:Date.now()-begin,tasks:result.taskRows.length,blocks:result.blockRows.length,summaryRows:result.summary.length,heapLimitMiB:512};
 assert.equal(usage.tasks,43200);json(resolve(process.argv[3])+'-memory.json',usage,true);console.log(JSON.stringify(usage));
}else{
 mkdirSync(out,{recursive:true});const sourceRoot=resolve(process.argv[3]),sourceExport=resolve(process.argv[4]),counts=new Map<string,number>();
 const oldSteps=read(join(sourceExport,'steps.json'));
 for(const row of oldSteps)if(row.taskId)counts.set(row.taskId,(counts.get(row.taskId)??0)+1);
 const sorted=[...counts.values()].sort((a,b)=>a-b);assert.equal(sorted.length,144);const median=(sorted[71]+sorted[72])/2,perTask=Math.max(128,Math.ceil(median));
 const oldPlan=read(join(sourceRoot,'plan.json')),s=stage('t8cf1-scale-43200');s.configs=matrix();s.rounds=3;s.blockSize=50;s.targetedSplit=oldPlan.stage.targetedSplit;s.batches=[{id:'scale',configs:s.configs.map(c=>c.id),caseIds:'all'}];s.launcher={kind:'local-process'};
 // This is a synthetic export input, never a run or a model-performance result.
 const input=join(out,'input'),plan=freeze(s,input),stamp=(ms:number)=>({wall:new Date(1700000000000+ms).toISOString(),ns:String(1000000000000n+BigInt(ms)*1000000n)});
 const ledger=new DetailTable(join(input,'egress','ledger.jsonl')),requests=new DetailTable(join(input,'egress','requests.jsonl')),host=new DetailTable(join(input,'scheduler','host.jsonl'));
 ledger.push({kind:'header',version:1});let tasks=0,steps=0,requestCount=0;
 for(const job of plan.jobs)for(const u of job.units){
  const cfg=s.configs.find(c=>c.id===u.configId)!,a=join(input,'blocks',job.blockId,u.configId,'r'+job.round,'attempt-1'),dir=join(a,'output','configs',u.configId);mkdirSync(dir,{recursive:true});
  json(join(a,'attempt.json'),{number:1,unitId:job.key+'-'+u.configId,caseIds:u.caseIds});json(join(dir,'block.json'),{sampling:{intervalMs:200}});
  const processIds=cfg.group==='Direct'?[]:['worker-1'];json(join(dir,'lifecycle.json'),{startupMs:1,shutdownMs:1,processes:processIds.map(id=>({id,exited:true}))});
  json(join(dir,'block-summary.json'),{tasksStarted:stamp(0),tasksEnded:stamp(1000),recordingFailures:{},workerRecordingFailures:Object.fromEntries(processIds.map(id=>[id,{}]))});
  const resources=new DetailTable(join(dir,'resources.jsonl'));for(const ms of [0,1000])resources.push({kind:'cgroup',available:true,at:stamp(ms),cpuUs:ms*1000,rssBytes:128000000});resources.finish();
  const writer=new DetailTable(join(dir,'steps.jsonl'));
  for(const caseId of u.caseIds){
   const taskId=s.runId+'/'+u.configId+'/r'+job.round+'/'+caseId;
   json(join(dir,'tasks',caseId+'.r'+job.round+'.json'),{caseId,configId:u.configId,round:job.round,taskId,status:'completed',modelSteps:[],completed:[],assignment:null,elapsedSeconds:1});
   for(let i=0;i<perTask;i++){const node=['CONTEXT.SELECT','INFER.REASONING.SAMPLE','INTERACTION.ACT.TOOL','MEMORY.WRITE'][i%4];writer.push({taskId,pid:101,pythonPid:202,invocationId:taskId+'-i'+i,runId:'graph-'+taskId,step:i,node,graphId:'synthetic',workerId:cfg.group==='Direct'?'direct':'worker-1',started:stamp(i),ended:stamp(i+1),sent:stamp(i),returned:stamp(i+1),ipcMs:0,queueMs:0,workMs:1,serviceMs:1,modelTiming:{apiMs:1},connectRetries:0,connectRetryWaitMs:0,cpu:{user:100,system:10},rss:128000000,selectedItemIds:['synthetic-a','synthetic-b'],kind:node==='INTERACTION.ACT.TOOL'?'tool':'node',action:node==='INTERACTION.ACT.TOOL'?'call':undefined});steps++;}
   // Enough settled records and request rows to exceed a Node string independently.
   for(let i=0;i<18;i++){const id='request-'+requestCount++;ledger.push({kind:'reserve',id,configId:u.configId,caseId,taskId,microUsd:7,syntheticPadding:'x'.repeat(320)});ledger.push({kind:'settle',id,usage:{cachedInputTokens:1,inputTokens:2,outputTokens:3}});requests.push({configId:u.configId,taskId,turn:0,step:i,requestBody:{model:'offline-synthetic',messages:[{role:'user',content:'x'.repeat(1024)}]}});}
   tasks++;
  }
  writer.finish();if(tasks%2400===0)console.log(JSON.stringify({phase:'generated',tasks,steps}));
 }
 ledger.finish();requests.finish();
 for(let i=0;i<Math.ceil(bufferConstants.MAX_STRING_LENGTH/4096)+1;i++)host.push({at:new Date(1700000000000+i).toISOString(),cpuPercent:1,usedMemoryBytes:128000000,totalMemoryBytes:1024000000,processCount:1,syntheticPadding:'x'.repeat(4096)});host.finish();
 assert.equal(tasks,43200);json(join(out,'input-proof.json'),{syntheticOnly:true,notModelExecution:true,tasks,steps,stepsPerTask:perTask,referenceMedianSteps:median,referenceTasks:counts.size,referenceSteps:oldSteps.length,referenceStepsFileSha256:fileHash(join(sourceExport,'steps.json')),jobs:plan.jobs.length,attempts:plan.jobs.length*s.configs.length,requests:requestCount,defaultNodeStringLimit:bufferConstants.MAX_STRING_LENGTH,inputFileBytes:{ledger:statSync(ledger.path).size,requests:statSync(requests.path).size,host:statSync(host.path).size}},true);
 const runs=[];
 for(const n of [1,2]){
  const dest=join(out,'export-'+n),args=['--max-old-space-size=512','--experimental-transform-types','tests/t8c-fix1-scale.ts',out,dest,'--export-child'];
  const child=spawn(process.execPath,args,{cwd:ROOT,env:env(join(out,'guards','export-'+n)),windowsHide:true,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
  const code=await new Promise<number|null>((yes,no)=>{child.once('error',no);child.once('close',yes);});json(join(out,'process-'+n+'.json'),{command:['node',...args],code,stdout,stderr},true);assert.equal(code,0,stderr);const usage=read(dest+'-memory.json');assert(usage.peakRssBytes<1024**3,'export RSS must stay below 1 GiB with 512 MiB heap');runs.push(usage);console.log(JSON.stringify({phase:'exported',run:n,...usage}));
 }
 const hashes=[];for(const name of readdirSync(join(out,'export-1')).sort()){
  const a=join(out,'export-1',name),b=join(out,'export-2',name);assert(fileEqual(a,b),'byte mismatch '+name);hashes.push({file:name,bytes:statSync(a).size,sha256:fileHash(a)});
 }
 const metadata=read(join(out,'export-1','metadata.json'));assert.equal(metadata.tables.steps.rows,steps);assert(metadata.tables.steps.utf16CodeUnits>bufferConstants.MAX_STRING_LENGTH);assert(metadata.tables.host.utf16CodeUnits>bufferConstants.MAX_STRING_LENGTH);
 for(const writer of [requests,host])assert(statSync(writer.path).size>bufferConstants.MAX_STRING_LENGTH);
 const proof={status:'PASS',syntheticOnly:true,tasks,steps,stepsPerTask:perTask,referenceMedianSteps:median,runs,peakRssBytes:Math.max(...runs.map(r=>r.peakRssBytes)),twoExportsByteIdentical:true,hashes,metadata,retentionBound:'Detail writes retain a 1 MiB chunk plus one record; inputs are streamed except one bounded attempt. Summary/tasks/blocks and numeric request-size/pending-liability indexes remain in memory. This is not a constant-memory guarantee for unlimited task counts.'};json(join(out,'verification.json'),proof,true);console.log(JSON.stringify({status:proof.status,tasks,steps,stepsPerTask:perTask,referenceMedianSteps:median,peakRssBytes:proof.peakRssBytes,twoExportsByteIdentical:true}));
}
