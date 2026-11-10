import type { createDirectSteps } from "./direct-steps.ts";
import type { Task } from "./tool-actions.ts";
import { loadActions, questionForTurn } from "./tool-actions.ts";
import { modelSystem } from "./egress/model.ts";
import { inputLimitDetails, requestLimitDetails, modelOutputFailureDetails } from "./egress/retry.ts";
import { STAGES, MessageCursor, legacyMessages, type Stage, type StageInput } from "./graphs.ts";

export interface TaskOptions {
  taskId: string; configId: string; model: string; maxOutputTokens: number;
  perTaskRequests: number; mode: string; debug?: boolean; previousFailedRequests?: number;
  signal?: AbortSignal;
  /** Diagnostic only, same optional snapshot attempt as legacy executeTask. */
  snapshot?: (taskId:string) => Promise<Record<string,unknown>>;
  onStage?: (stage:Stage, outputs:Record<string,any>) => void;
}
export interface StageRequest { stage: Stage; input: StageInput; }
export class TaskRunError extends Error {
  readonly executionOutcome = "runtime_failure";
  constructor(readonly taskId: string, readonly errors: readonly unknown[]) {
    super(`题目运行失败：${taskId}：${errors.map(e=>e instanceof Error?e.message:String(e)).join("; ")}`,{cause:errors[0]});
  }
}
export async function withTaskCleanup<T>(taskId:string, work:()=>Promise<T>, cleanups:readonly (()=>Promise<unknown>)[]):Promise<T> {
  let result!:T; const errors:unknown[]=[];
  try { result=await work(); } catch(error) {errors.push(error);}
  const cleaned=await Promise.allSettled(cleanups.map(async clean=>clean()));
  errors.push(...cleaned.flatMap(r=>r.status==="rejected"?[r.reason]:[]));
  if(errors.length)throw new TaskRunError(taskId,errors);
  return result;
}
/** Shared conversation script; stages are plain records, never Runtime calls.
 * Source: legacy conversation.ts executeTask. The two drivers only change dispatch.
 */
export async function* taskPlan(task:Task, options:TaskOptions):AsyncGenerator<StageRequest,any,Record<string,any>> {
  const previous=options.previousFailedRequests??0;
  if(!Number.isSafeInteger(previous)||previous<0)throw new Error("历史失败请求次数无效");
  if(!Number.isSafeInteger(options.perTaskRequests)||options.perTaskRequests<1)throw new Error("单题请求上限无效");
  const cursor=new MessageCursor();
  let actions=await loadActions(task.id);
  const base=():StageInput=>({taskId:options.taskId,caseId:task.id,configId:options.configId,cursor,model:options.model,maxTokens:options.maxOutputTokens,step:0});
  let messages:any[]=[structuredClone(modelSystem)];
  const modelSteps:any[]=[],completed:any[]=[],failedModelAttempts:any[]=[];
  const usage={source:options.mode,requests:0,inputTokens:0,outputTokens:0,totalTokens:0};
  let completedTurns=0, executionOutcome="completed", termination:any;
  let result=yield {stage:"open",input:{...base(),messages}};
  messages=legacyMessages(result.load.items);
  turns: for(let turn=1;turn<=task.question.length;turn++) {
    cursor.nextTurn();
    actions=await loadActions(task.id,turn);
    result=yield {stage:task.missed_function?"missingTurn":"turn",input:{...base(),messages:questionForTurn(task,turn)}};
    messages=legacyMessages(result.user.items);
    for(let step=1;;step++) {
      if(usage.requests+previous+failedModelAttempts.length>=options.perTaskRequests) {
        executionOutcome="request_limit";termination={reason:executionOutcome,turn,step,perTaskRequests:options.perTaskRequests};break turns;
      }
      try {result=yield {stage:"think",input:{...base(),actions,step}};}
      catch(error) {
        const inputLimit=inputLimitDetails(error);
        if(inputLimit){executionOutcome="input_limit";termination={reason:executionOutcome,turn,step,...inputLimit};break turns;}
        const details=requestLimitDetails(error);
        if(!details||details.physicalModelRequests!==options.perTaskRequests)throw error;
        failedModelAttempts.push(...details.failedModelAttempts);
        executionOutcome="request_limit";termination={reason:executionOutcome,turn,step,perTaskRequests:options.perTaskRequests};break turns;
      }
      const output=result.sample.output;
      failedModelAttempts.push(...(output.message.metadata?.failedModelAttempts??[]));
      usage.requests++;
      for(const key of ["inputTokens","outputTokens","totalTokens"] as const)usage[key]+=output.usage[key];
      modelSteps.push({turn,step,output});
      const failedOutput=modelOutputFailureDetails(output);
      if(failedOutput){executionOutcome="model_output";termination={reason:executionOutcome,turn,step,code:failedOutput.code};break turns;}
      messages=legacyMessages(result.note.items);
      if(output.finishReason==="stop") {completedTurns++;break;}
      if(output.finishReason==="length") {executionOutcome="output_limit";termination={reason:executionOutcome,turn,step,maxOutputTokens:options.maxOutputTokens};break turns;}
      if(output.finishReason!=="action_request")throw new Error("模型输出没有正常结束或调用工具");
      const group=result.note.items.at(-1).metadata.callId;
      for(const call of output.actionRequests) {
        if(completed.some(c=>c.id===call.id))throw new Error("模型重复使用工具调用ID");
        result=yield {stage:"action",input:{...base(),step,call,group}};
        const observation=result.observe.message.content;
        if(typeof observation!=="string")throw new Error("工具观察必须是字符串");
        completed.push({id:call.id,turn,step,tool:call.name,arguments:call.arguments,result:{observation}});
        messages=legacyMessages(result.note.items);
      }
    }
    yield {stage:"save",input:{...base(),messages,completedTurns}};
  }
  let snapshot:Record<string,unknown>|undefined;
  const recordingWarnings:string[]=[];
  if(options.debug) {
    try {if(!options.snapshot)throw new Error("snapshot unavailable");snapshot=await options.snapshot(options.taskId);}
    catch {recordingWarnings.push("final environment snapshot unavailable; model/tool results preserved");}
  }
  yield {stage:"close",input:base()};
  return {caseId:task.id,taskId:options.taskId,involvedClasses:task.involved_classes,completedTurns,executionOutcome,
    ...(termination?{termination}:{}),usage,modelSteps,completed,recordingWarnings,
    messages:options.debug?messages:messages.filter(m=>m.role==="system"||m.role==="user"),
    ...(failedModelAttempts.length?{failedModelAttempts,physicalModelRequests:usage.requests+failedModelAttempts.length+previous}:{}),
    ...(snapshot?{snapshot}:{}),transcriptFormat:options.debug?"full":"inputs-plus-modelSteps-and-completed"};
}
export async function runDirectTask(steps:ReturnType<typeof createDirectSteps>,task:Task,options:TaskOptions) {
  // Legacy debug-only diagnostic; not a model/tool decision or an extra graph.
  options={...options,snapshot:options.snapshot??(async taskId=>{
    const result=await steps.execute("INTERACTION.ACT.TOOL",{call:{id:`${taskId}/snapshot`,name:"bfcl_bridge",arguments:{taskId,request:{action:"snapshot"}}}},options.signal);
    if(result.status!=="success")throw new Error(result.error?.message??"snapshot failed");
    return (result.structuredContent as any).data;
  })};
  return withTaskCleanup(options.taskId,async()=>{
    const iterator=taskPlan(task,options);
    try {
      let next=await iterator.next();
      while(!next.done) {
        options.signal?.throwIfAborted();
        const {stage,input}=next.value;
        let outputs:Record<string,any>={};
        try {
          for(const step of STAGES[stage]) {
            options.signal?.throwIfAborted();
            const deps=Object.fromEntries(step.dependencies.map(id=>[id,outputs[id]]));
            const output=await steps.execute(step.node,step.bind(input,deps),options.signal);
            step.validateOutput(output);outputs[step.id]=output;
          }
        } catch(error) {
          // A cancelled task may still discover an egress/settlement failure.
          // Preserve that global stop instead of replacing it with local abort.
          if (!String(error).includes("BFCL_RUN_STOP:")) options.signal?.throwIfAborted();
          next=await iterator.throw(error);continue;
        }
        options.onStage?.(stage,outputs);
        next=await iterator.next(outputs);
      }
      options.signal?.throwIfAborted();return next.value;
    } finally {await iterator.return(undefined);}
  },[()=>steps.releaseTask(options.taskId)]);
}
