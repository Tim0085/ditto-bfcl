// T9 C1 (task book 5.3a): export time and memory on a synthetic main-experiment-size input WITH graphs.jsonl.
// Synthetic only: never a run, never a model result. 43,200 tasks (18 configurations x 800 x 3 rounds),
// 128 steps and 72 graph events per task (stage-2 live median: 85 steps, 71 graph events), 18 ledger
// reservations per task with one egress/model-records file each. Two exports run one after another in a child
// node with a 512 MiB heap (the T8c fix-1 harness setting); they must be byte-identical. A side bench times
// the pre-T9 graphTimes against the new one on the first Ditto units and checks they agree.
// Usage: node --import ./scripts/egress-offline-guard.mjs --experimental-transform-types tests/t9c1-scale.ts <out dir> [--live-root <runs/live>] [--phase <p>]
// At most two node processes at once (this one and one export child). Stops if the STOP file appears.
// T10: the Targeted split is read from the experiment package (an isolated copy has no runs/offline), and a missing
// file fails instead of being replaced. --phase generate|bench|export-1|export-2|verify runs one step on the same <out dir>
// (each later step reads what the earlier ones left), so the run can be cut into pieces of at most 40 minutes; default all.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdirSync,readdirSync,statSync,existsSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {freemem} from 'node:os';
import {stage} from './t8a-helpers.ts';
import {freeze,matrix} from '../src/ts/scheduler/plan.ts';
import {exportRun} from '../src/ts/scheduler/export.ts';
import {graphTimes} from '../src/ts/scheduler/export-graph.ts';
import {DetailTable,jsonRows,fileEqual,fileHash} from '../src/ts/scheduler/export-stream.ts';
import {read,json,env,ROOT} from '../src/ts/scheduler/io.ts';
const STOP='F:/Academic/Ditto/experiments/sec1/_tmp/coord/STOP';
const out=resolve(process.argv[2]);
const stopNow=(where:string)=>{if(existsSync(STOP)){console.log(JSON.stringify({stopped:'STOP file present',where}));process.exit(9);}if(freemem()<5*1024**3){console.log(JSON.stringify({stopped:'free memory below 5 GiB',where,freeBytes:freemem()}));process.exit(8);}};
function oldGraphTimes(directory:string,raw:any[]){const events=Array.from(jsonRows(join(directory,'graphs.jsonl'))).filter(e=>!e.malformed),times=new Map<string,number>();
 for(const start of events.filter(e=>e.event?.status==='started')){const end=events.find(e=>e.taskId===start.taskId&&e.event.iteration===start.event.iteration&&e.event.status!=='started');if(!end)continue;
  const ns=(p:any)=>p?.ns?BigInt(p.ns):null,begin=ns(start.at)!,finish=ns(end.at)!;
  const rows=raw.filter(r=>r.taskId===start.taskId&&r.graphId===start.event.graphId&&ns(r.sent)!>=begin&&ns(r.returned)!<=finish&&r.sent?.ns&&r.returned?.ns).sort((a,b)=>Number(ns(a.sent)!-ns(b.sent)!));
  if(rows.length!==start.event.nodes.length)continue;let cursor=begin;
  for(const [i,row] of rows.entries()){const before=ns(row.sent)!-cursor,tail=i===rows.length-1?finish-ns(row.returned)!:0n;if(before<0n||tail<0n)continue;times.set(row.invocationId,Number(before+tail)/1e6);cursor=ns(row.returned)!;}
 }return times;}
if(process.argv.includes('--export-child')){
 const begin=Date.now();const result=exportRun(join(out,'input'),resolve(process.argv[3]));
 const usage={peakRssBytes:process.resourceUsage().maxRSS*1024,endingMemory:process.memoryUsage(),elapsedMs:Date.now()-begin,tasks:result.taskRows.length,blocks:result.blockRows.length,summaryRows:result.summary.length,heapLimitMiB:512};
 assert.equal(usage.tasks,43200);json(resolve(process.argv[3])+'-memory.json',usage,true);console.log(JSON.stringify(usage));
}else if(process.argv.includes('--graph-bench')){
 const units=read(join(out,'input-proof.json')).benchUnits as string[],rows:any[]=[];let oldMs=0,newMs=0;
 for(const dir of units){const raw=Array.from(jsonRows(join(dir,'steps.jsonl')));let t=performance.now();const a=oldGraphTimes(dir,raw);oldMs+=performance.now()-t;t=performance.now();const b=graphTimes(dir,raw);newMs+=performance.now()-t;
  assert.equal(JSON.stringify([...a]),JSON.stringify([...b]),dir);rows.push({dir:dir.slice(out.length),matched:a.size});}
 const r={units:units.length,oldMs,newMs,matchedPerUnit:rows[0]?.matched,identical:true};json(join(out,'graph-bench.json'),r,true);console.log(JSON.stringify(r));
}else{
 const phase=process.argv.includes('--phase')?process.argv[process.argv.indexOf('--phase')+1]:'all',run=(p:string)=>phase==='all'||phase===p;
 assert(['all','generate','bench','export-1','export-2','verify'].includes(phase),'unknown --phase '+phase);
 mkdirSync(out,{recursive:true});const t0=Date.now();
 const liveRoot=process.argv.includes('--live-root')?resolve(process.argv[process.argv.indexOf('--live-root')+1]):null;
 const perTask=128,iterations=36,requestsPerTask=18;// 20 iterations of 4 nodes + 16 of 3 = 128 steps, 72 graph events
 const split='F:/Academic/Ditto/experiments/sec1/01_bfcl_multiturn/runs/offline/t8c-20261106/profile/targeted-split.json';
 assert(existsSync(split),'Targeted split not found in the experiment package: '+split);
 const s=stage('t9c1-scale-43200');s.configs=matrix();s.rounds=3;s.blockSize=50;s.targetedSplit=split;s.batches=[{id:'scale',configs:s.configs.map(c=>c.id),caseIds:'all'}];s.launcher={kind:'local-process'};
 if(run('generate')){
 const input=join(out,'input'),plan=freeze(s,input),stamp=(ms:number)=>({wall:new Date(1700000000000+ms).toISOString(),ns:String(1000000000000n+BigInt(Math.round(ms*1000))*1000n)});
 const ledger=new DetailTable(join(input,'egress','ledger.jsonl')),requests=new DetailTable(join(input,'egress','requests.jsonl')),host=new DetailTable(join(input,'scheduler','host.jsonl'));
 const records=join(input,'egress','model-records');mkdirSync(records,{recursive:true});
 ledger.push({kind:'header',version:1});let tasks=0,steps=0,events=0,requestCount=0;const benchUnits:string[]=[];
 for(const job of plan.jobs)for(const u of job.units){
  const cfg=s.configs.find(c=>c.id===u.configId)!,a=join(input,'blocks',job.blockId,u.configId,'r'+job.round,'attempt-1'),dir=join(a,'output','configs',u.configId);mkdirSync(dir,{recursive:true});
  json(join(a,'attempt.json'),{number:1,unitId:job.key+'-'+u.configId,caseIds:u.caseIds});json(join(dir,'block.json'),{sampling:{intervalMs:200}});
  const processIds=cfg.group==='Direct'?[]:['worker-1'];json(join(dir,'lifecycle.json'),{startupMs:1,shutdownMs:1,processes:processIds.map(id=>({id,exited:true}))});
  const span=u.caseIds.length*perTask*3+10;json(join(dir,'block-summary.json'),{tasksStarted:stamp(0),tasksEnded:stamp(span),recordingFailures:{},workerRecordingFailures:Object.fromEntries(processIds.map(id=>[id,{}]))});
  const resources=new DetailTable(join(dir,'resources.jsonl'));for(let ms=0;ms<=span;ms+=200)resources.push({kind:'cgroup',available:true,at:stamp(ms),cpuUs:ms*1000,rssBytes:128000000});resources.finish();
  const writer=new DetailTable(join(dir,'steps.jsonl')),graphs=new DetailTable(join(dir,'graphs.jsonl'));let clock=1;
  for(const caseId of u.caseIds){
   const taskId=s.runId+'/'+u.configId+'/r'+job.round+'/'+caseId;
   json(join(dir,'tasks',caseId+'.r'+job.round+'.json'),{caseId,configId:u.configId,round:job.round,taskId,status:'completed',executionOutcome:'completed',completedTurns:3,modelSteps:[],completed:[],assignment:null,elapsedSeconds:1,sojournSeconds:1.1});
   let i=0;for(let it=0;it<iterations;it++){const n=it<20?4:3,graphId='synthetic-'+(it%3),runId='graph-'+taskId+'-'+it;
    graphs.push({taskId,at:stamp(clock),event:{loopId:'loop-'+taskId,iteration:it,graphId,nodes:Array.from({length:n},(_,k)=>'n'+k),status:'started'}});events++;clock+=.1;
    for(let k=0;k<n;k++,i++){const node=['CONTEXT.SELECT','INFER.REASONING.SAMPLE','INTERACTION.ACT.TOOL','MEMORY.WRITE'][i%4];
     writer.push({taskId,pid:101,pythonPid:202,invocationId:taskId+'-i'+i,runId,step:i,node,graphId,workerId:cfg.group==='Direct'?'direct':'worker-1',started:stamp(clock+.2),ended:stamp(clock+.8),sent:stamp(clock),returned:stamp(clock+1),ipcMs:.2,queueMs:.05,workMs:.6,serviceMs:.6,modelTiming:node==='INFER.REASONING.SAMPLE'?{apiMs:.5,rateWaitMs:.01}:null,connectRetries:0,connectRetryWaitMs:0,cpu:{user:100,system:10},rss:128000000,selectedItemIds:['synthetic-a','synthetic-b'],kind:node==='INTERACTION.ACT.TOOL'?'tool':'node',action:node==='INTERACTION.ACT.TOOL'?'call':undefined});steps++;clock+=1.1;}
    graphs.push({taskId,at:stamp(clock),event:{loopId:'loop-'+taskId,iteration:it,graphId,nodes:Array.from({length:n},(_,k)=>'n'+k),status:'completed'}});events++;clock+=.1;}
   for(let r=0;r<requestsPerTask;r++){const id='request-'+String(requestCount++).padStart(7,'0'),startedAt=1700000000000+requestCount*3;
    ledger.push({kind:'reserve',id,configId:u.configId,caseId,taskId,microUsd:7,microCny:30,syntheticPadding:'x'.repeat(320)});ledger.push({kind:'settle',id,usage:{cachedInputTokens:1,inputTokens:2,outputTokens:3,reasoningTokens:1},microUsd:1,microCny:4});
    requests.push({configId:u.configId,taskId,turn:0,step:r,requestBody:{model:'offline-synthetic',messages:[{role:'user',content:'x'.repeat(1024)}]}});
    writeFileSync(join(records,id+'.json'),JSON.stringify({configId:u.configId,backend:'replay',reservationId:id,taskId,caseId,requestStartedAt:startedAt,responseReceivedAt:startedAt+2,apiMs:2,rateWaitMs:.1,logicalTurn:0,logicalStep:r,retryAttempt:0,status:'completed',ledgerSettled:true,ledgerRetained:false}));}
   tasks++;
  }
  writer.finish();graphs.finish();if(cfg.group!=='Direct'&&benchUnits.length<30)benchUnits.push(dir);
  if(tasks%2400===0){console.log(JSON.stringify({phase:'generated',tasks,steps,events,requests:requestCount,elapsedMs:Date.now()-t0,freeBytes:freemem()}));stopNow('generate');}
 }
 ledger.finish();requests.finish();for(let i=0;i<20000;i++)host.push({at:new Date(1700000000000+i*2000).toISOString(),cpuPercent:1,usedMemoryBytes:128000000,totalMemoryBytes:1024000000,processCount:1});host.finish();
 assert.equal(tasks,43200);
 const proof={syntheticOnly:true,notModelExecution:true,tasks,steps,graphEvents:events,stepsPerTask:perTask,graphEventsPerTask:iterations*2,requests:requestCount,modelRecordFiles:requestCount,
  reference:liveRoot?{source:liveRoot,note:'stage-2 live median 85 steps and 71 graph events per task (tools/live_counts.py)'}:null,jobs:plan.jobs.length,generateMs:Date.now()-t0,
  inputFileBytes:{ledger:statSync(ledger.path).size,requests:statSync(requests.path).size,host:statSync(host.path).size},benchUnits};
 json(join(out,'input-proof.json'),proof,true);console.log(JSON.stringify({phase:'input ready',generateMs:proof.generateMs}));
 }
 const proof=read(join(out,'input-proof.json')),{tasks,steps,graphEvents:events,requests:requestCount}=proof;
 const child=async(args:string[],label:string,timeoutMs:number)=>{stopNow(label);const c=spawn(process.execPath,args,{cwd:ROOT,env:{...env(join(out,'guards',label)),SEC1_PROBE_DEPTH:'1'},windowsHide:true,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';c.stdout.on('data',b=>stdout+=b);c.stderr.on('data',b=>stderr+=b);
  const timer=setTimeout(()=>c.kill(),timeoutMs);const code=await new Promise<number|null>((yes,no)=>{c.once('error',no);c.once('close',yes);});clearTimeout(timer);json(join(out,'process-'+label+'.json'),{command:['node',...args],code,stdout,stderr},true);assert.equal(code,0,stderr.slice(-2000));return stdout;};
 if(run('bench')){const bench=await child(['--experimental-transform-types','tests/t9c1-scale.ts',out,'--graph-bench'],'graph-bench',40*60*1000);console.log(bench.trim());}
 for(const n of [1,2])if(run('export-'+n)){const dest=join(out,'export-'+n);await child(['--max-old-space-size=512','--experimental-transform-types','tests/t9c1-scale.ts',out,dest,'--export-child'],'export-'+n,40*60*1000);console.log(JSON.stringify({phase:'exported',run:n,...read(dest+'-memory.json'),freeBytes:freemem()}));}
 if(run('verify')){
 const runs=[1,2].map(n=>read(join(out,'export-'+n)+'-memory.json'));
 const hashes=[];for(const name of readdirSync(join(out,'export-1')).sort()){const a=join(out,'export-1',name),b=join(out,'export-2',name);assert(fileEqual(a,b),'byte mismatch '+name);hashes.push({file:name,bytes:statSync(a).size,sha256:fileHash(a)});}
 const metadata=read(join(out,'export-1','metadata.json'));assert.equal(metadata.tables.steps.rows,steps);assert.equal(metadata.tables.modelRequests.rows,requestCount);
 let matched=0;for(const row of jsonRows(join(out,'export-1','steps.jsonl')))if(row.graphScheduleMs!==null)matched++;
 const ditto=s.configs.filter(c=>c.group!=='Direct').length*800*3*perTask;
 const result={status:'PASS',syntheticOnly:true,tasks,steps,graphEvents:events,requests:requestCount,graphScheduleMatchedSteps:matched,dittoSteps:ditto,runs,peakRssBytes:Math.max(...runs.map(r=>r.peakRssBytes)),maxElapsedMs:Math.max(...runs.map(r=>r.elapsedMs)),twoExportsByteIdentical:true,graphBench:read(join(out,'graph-bench.json')),hashes};
 json(join(out,'verification.json'),result,true);console.log(JSON.stringify({status:result.status,peakRssBytes:result.peakRssBytes,maxElapsedMs:result.maxElapsedMs,graphScheduleMatchedSteps:matched,dittoSteps:ditto}));
 }
}
