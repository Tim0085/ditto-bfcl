import { readFileSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { connectRetryScope } from "./model-client.ts";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { deploy, childEnvironment, layout, type Copies } from "./deploy.ts";
import { deployTimeouts, type TimeoutConfig } from "./deploy-timeouts.ts";
import { createDirectSteps } from "./direct-steps.ts";
import { runDirectTask, TaskRunError, type TaskOptions } from "./direct-task.ts";
import { runTask } from "./task-loop.ts";
import { STAGES, graphId, type Stage } from "./graphs.ts";
import { loadTask, categoryOf } from "./tool-actions.ts";
import { resourceSampler, type Sampling } from "./resource-sampler.ts";
import { log, jsonNew, lines, stamp, errorText, mergeSteps, scoringFields, recordingFailures, auxiliaryJson, milliseconds, recordingFailure, ScoringTrace, scoringScope, captureScoring } from "./step-log.ts";
import { inputLimitDetails, requestLimitDetails } from "./egress/retry.ts";
import { FailureTrace, failureScope, aggregateDiagnostics, cleanupScope, cleanupReplyProvenance, cleanupDiagnostics, errorMessages, type CleanupCapture, type CleanupProvenance, type FailureType } from "./step-log.ts";
export interface Block {
  runId:string; configId:string; group:"Direct"|"Monolithic"|"Uniform"|"Targeted"; c:number; round:number;
  copies?:Copies; caseIds:string[]; modelEndpoint:string; model:string; maxOutputTokens:number; perTaskRequests:number;
  mode:"offline-reference"|"live"; debug:boolean; python:string; outputRoot:string; sampling:Sampling;
  egress:TimeoutConfig; startupConcurrency?:number;
}
export function validateBlock(b:Block) {
  for(const key of ["runId","configId"] as const)if(!/^[A-Za-z0-9_-]+$/.test(b[key]??""))throw new Error(`Invalid ${key}`);
  for(const key of ["c","round","maxOutputTokens","perTaskRequests"] as const)if(!Number.isSafeInteger(b[key])||b[key]<1)throw new Error(`Invalid ${key}`);
  if(!["Direct","Monolithic","Uniform","Targeted"].includes(b.group)||!["offline-reference","live"].includes(b.mode)||typeof b.debug!=="boolean")throw new Error("Invalid group/mode/debug");
  if(b.group==="Direct"){if(b.copies!==undefined)throw new Error("Direct must not have copies");}else layout(b.group,b.copies!);
  if(!Array.isArray(b.caseIds)||!b.caseIds.length||new Set(b.caseIds).size!==b.caseIds.length)throw new Error("Invalid caseIds");
  b.caseIds.forEach(categoryOf);
  for(const key of ["modelEndpoint","model","python","outputRoot"] as const)if(typeof b[key]!=="string"||!b[key].trim())throw new Error(`Missing ${key}`);
  const url=new URL(b.modelEndpoint);if(!["http:","https:"].includes(url.protocol)||url.username||url.password)throw new Error("Invalid model endpoint");
  if(!b.sampling||typeof b.sampling.enabled!=="boolean"||typeof b.sampling.strict!=="boolean"||!["cpuMax","memoryMax","swapMax"].every(k=>typeof (b.sampling.expected as any)?.[k]==="string"))throw new Error("Missing sampling settings");
  for(const n of [b.sampling.intervalMs,b.sampling.processIntervalMs,b.sampling.clockTicks,b.sampling.pageBytes,b.startupConcurrency])if(n!==undefined&&(!Number.isSafeInteger(n)||n<1))throw new Error("Invalid sampling/startup interval");
  return deployTimeouts(b.egress);
}
export async function runBlock(b:Block) {
  const timeouts=validateBlock(b),directory=join(resolve(b.outputRoot),"configs",b.configId);
  // Entire block is exclusive. Reusing a config directory is never an implicit resume.
  mkdirSync(join(resolve(b.outputRoot),"configs"),{recursive:true});mkdirSync(directory);
  for(const name of ["tasks","failures","workers"])mkdirSync(join(directory,name));
  jsonNew(join(directory,"block.json"),{...b,timeouts});
  for(const name of ["graphs.jsonl","services.jsonl"])try{writeFileSync(join(directory,name),"",{flag:"wx"});}catch(error){recordingFailure(join(directory,name),error);}
  let pool:Awaited<ReturnType<typeof deploy>>|undefined,direct:ReturnType<typeof createDirectSteps>|undefined;
  let sampler:Awaited<ReturnType<typeof resourceSampler>>|undefined;
  let stopReason:string|undefined,stopCategory="运行失败",completed=0,failed=0,next=0,maxActive=0,active=0;
  let skipped=0,interrupted=0;
  let streak:{failureType:FailureType;caseIds:string[]}|null=null;
  let consecutiveFailure:{failureType:FailureType;caseIds:string[]}|null=null;
  const skippedByFailureType:Record<string,number>={},skippedByCategory:Record<string,number>={base:0,miss_func:0,miss_param:0,long_context:0};
  const stop=(reason:string,category="运行失败")=>{if(stopReason)return;stopReason=reason;stopCategory=category;pool?.stop(reason);};
  const sigterm=()=>stop("SIGTERM","被停止");process.on("SIGTERM",sigterm);
  const initial=stamp();let tasksStarted:any=null,tasksEnded:any=null;
  // Performance enrichment must never turn a reliable task result into a failure.
  function performanceSteps(persist=false) {
    try{return mergeSteps(directory,persist);}
    catch(error){recordingFailure(join(directory,"steps.jsonl"),error);return [];}
  }
  const directScope=new AsyncLocalStorage<{taskId:string;pending:any[];sequence:number}>();
  function pendingStage():Stage {
    const first=directScope.getStore()!.pending[0];
    return first?.node==="CONTEXT.SELECT"?"think":first?.node==="MEMORY.WRITE"?"save":
      first?.action==="init"?"open":first?.action==="turn"?"missingTurn":first?.action==="call"?"action":first?.action==="release"?"close":"turn";
  }
  function flush(stage?:Stage){
    const scope=directScope.getStore()!;
    const executionId=randomUUID();
    for(const [i,row] of scope.pending.entries()){
      const actual=stage??pendingStage();
      row.execution={graphId:graphId(actual),runId:executionId,nodeId:STAGES[actual][i]?.id??"unknown"};
      log(join(directory,"direct.steps.jsonl"),row);
    }scope.pending=[];
  }
  try{
    if(b.group==="Direct"){
      direct=createDirectSteps({python:b.python,memoryDirectory:join(directory,"memory","direct"),modelEndpoint:b.modelEndpoint,inferenceTimeoutMs:timeouts.inferenceTimeoutMs,
        onServiceCreated:capability=>log(join(directory,"services.jsonl"),{workerId:null,pid:process.pid,capability,at:stamp()})});
      const execute=direct.execute.bind(direct);
      direct.execute=(async(node:any,input:any)=>{
        if(stopReason)throw new Error(stopReason);
        const scope=directScope.getStore()!;
        const snapshot=input?.call?.arguments?.request?.action==="snapshot";
        // Controlled SAMPLE rejection skips onStage. Flush that failed stage before close/snapshot.
        if(scope.pending.length&&(snapshot||STAGES[pendingStage()][scope.pending.length]?.node!==node))flush();
        const row:any={invocationId:randomUUID(),taskId:scope.taskId,workerId:null,pid:process.pid,node,direct:true,match:"direct",sent:null,received:null,started:stamp(),returned:null};
        const cpu=process.cpuUsage();
        Object.assign(row,scoringFields(node,input,null));
        const work=()=>execute(node,input);
        const modelWork=()=>node==="INFER.REASONING.SAMPLE"
          ?connectRetryScope.run(Object.assign(row,{connectRetries:0,connectRetryWaitMs:0}),work):work();
        try{const result:any=await captureScoring(node,input,{invocationId:row.invocationId,workerId:null,nodePid:process.pid},modelWork);Object.assign(row,scoringFields(node,input,result));row.success=result?.status===undefined||result.status==="success";row.error=result?.error?.message??null;
          row.modelTiming=result?.output?.message?.metadata?.modelTiming??null;row.pythonPid=result?.structuredContent?.pythonPid??result?.metadata?.pythonPid??null;return result;}
        catch(error){row.success=false;row.error=errorText(error);throw error;}
        finally{row.ended=stamp();row.cpu=process.cpuUsage(cpu);row.rss=process.memoryUsage().rss;
          if(snapshot){row.execution={graphId:"diagnostic",runId:randomUUID(),nodeId:"snapshot"};log(join(directory,"direct.steps.jsonl"),row);}else scope.pending.push(row);}
      }) as typeof direct.execute;
    }else pool=await deploy({group:b.group,copies:b.copies!,python:b.python,modelEndpoint:b.modelEndpoint,directory,timeouts,startupConcurrency:b.startupConcurrency,
      onStop:reason=>stop(reason,"Worker 退出")});
    sampler=await resourceSampler(join(directory,"resources.jsonl"),b.sampling,()=>pool?.units.map(u=>({id:u.id,pid:u.child.pid!}))??[],e=>stop(errorText(e)));
    tasksStarted=stamp();
    async function lane(){
      while(!stopReason&&next<b.caseIds.length){
        const caseId=b.caseIds[next++],taskId=`${b.runId}/${b.configId}/r${b.round}/${caseId}`,started=stamp();
        active++;maxActive=Math.max(maxActive,active);
        let assignment:any=null;
        const failureTrace=new FailureTrace(taskId);
        const cleanupFailures:({error:unknown}&CleanupProvenance)[]=[];
        const cleanup=async(work:()=>Promise<unknown>)=>{
          const capture:CleanupCapture={};
          try{return await cleanupScope.run(capture,work);}catch(error){
            const provenance=cleanupReplyProvenance(error)??(capture.sources?{workerId:null,sources:capture.sources}:undefined);
            if(provenance)cleanupFailures.push({error,...provenance});
            failureTrace.record(error,"cleanup");throw error;
          }
        };
        const options:TaskOptions={taskId,configId:b.configId,model:b.model,maxOutputTokens:b.maxOutputTokens,perTaskRequests:b.perTaskRequests,mode:b.mode,debug:b.debug};
        try{
          const task=await loadTask(caseId),trace=new ScoringTrace(taskId);let result:any;
          await failureScope.run(failureTrace,()=>scoringScope.run(trace,async()=>{
          if(direct) result=await directScope.run({taskId,pending:[],sequence:0},async()=>{
            const directSteps=direct!;
            const steps={...directSteps,releaseTask:(id:string)=>cleanup(()=>directSteps.releaseTask(id)) as ReturnType<typeof directSteps.releaseTask>};
            try{return await runDirectTask(steps,task,{...options,onStage:stage=>flush(stage)});}finally{flush();}
          });
          else{
            const attached=pool!.attach(taskId);assignment=attached.assignment;
            const handles=new Map([...pool!.handles].map(([id,h])=>[id,{...h,releaseTask:(taskId:string)=>cleanup(()=>h.releaseTask(taskId)) as ReturnType<typeof h.releaseTask>}]));
            result=await runTask(pool!.runtime,task,{...options,bindings:attached.bindings,handles,
              onGraph:event=>log(join(directory,"graphs.jsonl"),{taskId,at:stamp(),event})});
          }
          }));
          if(stopReason)throw new Error(stopReason);
          const ended=stamp(),performance=new Map(performanceSteps().filter(row=>row.taskId===taskId).map(row=>[row.invocationId,row]));
          const allEvents=trace.events.map(event=>{
            const row=performance.get(event.invocationId),timing=row?.modelTiming;
            const metrics={queueMs:row?.queueMs??null,
              serviceMs:event.kind!=="infer"?row?.workMs??null:row?.workMs==null||!timing?null:Math.max(0,row.workMs-(timing.rateWaitMs??0)-(timing.retryRateWaitMs??0)-(timing.budgetWaitMs??0)),
              nodeCpuUs:row?.cpu?row.cpu.user+row.cpu.system:null,
              ...(event.kind==="infer"?{apiMs:timing?.apiMs??null,rateWaitMs:timing?.rateWaitMs??null,
                retryRateWaitMs:timing?.retryRateWaitMs??null,budgetWaitMs:timing?.budgetWaitMs??null,budgetReceipt:row?.budgetReceipt??null}:{})};
            return {...event,...metrics,performanceMissing:Object.entries(metrics).filter(([,v])=>v===null).map(([k])=>k)};
          });
          const requestLimitEvents=allEvents.filter(e=>e.kind==="infer"&&e.error&&requestLimitDetails(new Error(e.error)));
          const inputLimitEvents=allEvents.filter(e=>e.kind==="infer"&&e.error&&inputLimitDetails(new Error(e.error)));
          const workerEvents=allEvents.filter(e=>!requestLimitEvents.includes(e)&&!inputLimitEvents.includes(e));
          try{trace.validate(workerEvents,result);}catch(error){failureTrace.record(error,"scoring-trace");throw error;}
          jsonNew(join(directory,"tasks",`${caseId}.r${b.round}.json`),{...result,version:3,configId:b.configId,round:b.round,assignment,started,ended,
            status:result.executionOutcome==="completed"?"completed":"terminated",backend:b.group==="Direct"?"direct":"ditto",group:b.group.toLowerCase(),concurrency:b.c,
            arrivedAt:Date.parse(tasksStarted.wall),admittedAt:Date.parse(started.wall),finishedAt:Date.parse(ended.wall),elapsedSeconds:milliseconds(ended,started)!/1000,
            sojournSeconds:milliseconds(ended,tasksStarted)!/1000,timing:{clock:"process.hrtime.bigint",clockId:b.runId,arrivedAtNs:tasksStarted.ns,admittedAtNs:started.ns,finishedAtNs:ended.ns,window:"admission-through-worker-release"},
            workerEvents,requestLimitEvents,inputLimitEvents,realModelCalls:b.mode==="live"?(result.physicalModelRequests??result.usage.requests):0,usageSource:b.mode});completed++;streak=null;
        }catch(error){
          const errors=(error instanceof TaskRunError?error.errors:[error]).flatMap(e=>failureTrace.precedingErrors.get(e)??[e]);
          const message=errors.map(errorText).join("; ");
          const stopMessage=errorMessages(errors).join("; "),runStop=stopMessage.includes("BFCL_RUN_STOP:");
          // Stop admission synchronously; liveness evidence must not delay an explicit run stop.
          if(runStop)stop(stopMessage,"出口停止");
          // A reply rejection may arrive before exit/disconnect; require a fresh management pong.
          // Include dynamically routed Infer/Observe workers as well as fixed owners.
          const owners=new Set<string>([...Object.values(assignment??{}) as string[],...failureTrace.workers]);
          let workerLiveness:any[]=[];
          if(pool)try{workerLiveness=await pool.confirmAlive(owners);}
          catch(checkError){workerLiveness=[...owners].map(workerId=>({workerId,alive:false,method:"check-error",confirmedAt:stamp(),error:errorText(checkError)}));
            stop(`Worker 判活失败：${errorText(checkError)}`,"Worker 退出");}
          const dead=pool?.units.find(u=>owners.has(u.id)&&(u.dead||!u.child.connected||u.child.exitCode!==null||u.child.signalCode!==null));
          const unconfirmed=workerLiveness.find(row=>!row.alive);
          const category=runStop?"出口停止":dead||unconfirmed?"Worker 退出":stopReason?stopCategory:"运行失败";
          if(category==="出口停止"||dead||unconfirmed)stop(category==="Worker 退出"?`Worker 退出：${dead?.id??unconfirmed.workerId}`:message,category);
          const disposition=stopReason?"interrupted":"skipped";
          const failureSource=failureTrace.source(errors[0]),failureType=failureSource.type;
          const candidate=disposition==="skipped"?{failureType,caseIds:streak?.failureType===failureType?[...streak.caseIds,caseId]:[caseId]}:streak;
          const relevant=performanceSteps().filter(row=>row.taskId===taskId),bad=relevant.filter(row=>row.error);
          const failure={caseId,taskId,configId:b.configId,round:b.round,assignment,started,ended:stamp(),category,error:message,
            disposition,failureType,streak:candidate?.caseIds.length??0,streakFailureType:candidate?.failureType??null,
            workerLiveness,failureNode:failureSource.node,errors:errors.map(errorText),...aggregateDiagnostics(errors),...cleanupDiagnostics(errors,cleanupFailures),steps:bad,
            location:bad.at(-1)?.execution??relevant.at(-1)?.execution??null,realErrors:bad.map(row=>row.error)};
          // Synchronous atomic publication defines completion order, with no await before counting.
          try{jsonNew(join(directory,"failures",`${caseId}.r${b.round}.json`),failure);}
          catch(writeError){
            stop(`Failure result persistence: ${errorText(writeError)}`);recordingFailure(join(directory,"failures"),writeError);
            // Without a durable record T8 must not treat this task as permanently skipped.
            failed++;interrupted++;return;
          }
          failed++;
          if(disposition==="interrupted")interrupted++;
          else{
            skipped++;skippedByFailureType[failureType]=(skippedByFailureType[failureType]??0)+1;
            skippedByCategory[categoryOf(caseId).replace("multi_turn_","")]++;
            streak=candidate;
            if(streak!.caseIds.length===2){consecutiveFailure=streak;stop(`连续 2 道同类运行失败：${failureType}：${streak!.caseIds.join(", ")}`);}
          }
        }finally{pool?.detach(taskId);active--;}
      }
    }
    await Promise.all(Array.from({length:Math.min(b.c,b.caseIds.length)},lane));tasksEnded=stamp();
  }catch(error){stop(errorText(error));}
  finally{
    try{await sampler?.stop();await direct?.dispose();await pool?.close();}catch(error){stop(errorText(error));}
    process.off("SIGTERM",sigterm);
  }
  if(!pool&&b.group==="Direct")auxiliaryJson(join(directory,"lifecycle.json"),{started:initial,startupEnded:tasksStarted,shutdownEnded:stamp(),processes:[]});
  try{for(const name of readdirSync(join(directory,"workers")).filter(n=>n.endsWith(".services.jsonl")))for(const row of lines(join(directory,"workers",name)))log(join(directory,"services.jsonl"),row);}
  catch(error){recordingFailure(join(directory,"workers"),error);}
  performanceSteps(true);
  const summary={configId:b.configId,completed,failed,skipped,skippedByFailureType,skippedByCategory,interrupted,consecutiveFailure,
    notStarted:b.caseIds.length-next,stopReason:stopReason??null,stopCategory:stopReason?stopCategory:null,
    exitCode:stopReason?1:0,maxActive,tasksStarted,tasksEnded,recordingFailures:recordingFailures(),workerRecordingFailures:pool?.workerRecordingFailures??{}};
  jsonNew(join(directory,"block-summary.json"),summary);return summary;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    if(process.argv.length!==4||process.argv[2]!=="--block")throw new Error("Usage: config-main.ts --block block.json");
    const block=JSON.parse(readFileSync(process.argv[3],"utf8"));validateBlock(block);
    // This CLI owns its process. Direct's Python inherits only the same whitelist as Workers.
    const env=childEnvironment();for(const name of Object.keys(process.env))delete process.env[name];Object.assign(process.env,env);
    const summary=await runBlock(block);console.log(JSON.stringify(summary));process.exitCode=summary.exitCode;
  }catch(error){console.error(errorText(error));process.exitCode=2;}
}
