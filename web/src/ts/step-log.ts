import { appendFileSync, readFileSync, readdirSync, writeFileSync, openSync, closeSync, fsyncSync, linkSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
export const stamp = () => ({ ns: process.hrtime.bigint().toString(), wall: new Date().toISOString() });
export const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);
export type CleanupSource = "context"|"python"|"memory"|"model-drain";
export interface CleanupCapture { sources?:CleanupSource[]; }
/** Each release gets its own capture, so concurrent tasks may reject with the same object safely. */
export const cleanupScope = new AsyncLocalStorage<CleanupCapture>();
export interface CleanupProvenance { workerId:string|null; sources:CleanupSource[]; }
const cleanupReplies = new WeakMap<object,CleanupProvenance>();
export function cleanupReplyProvenance(error:unknown) {
  return error instanceof Error ? cleanupReplies.get(error) : undefined;
}
export function cleanupDiagnostics(errors:unknown[],failures:({error:unknown}&CleanupProvenance)[]) {
  const remaining=errors.map((error,errorIndex)=>({error,errorIndex})),cleanupErrors=[];
  // A preceding business error can be rethrown by cleanup: annotate its cleanup occurrence only.
  for(const failure of [...failures].reverse()) {
    let index=remaining.length-1;
    while(index>=0&&!Object.is(remaining[index].error,failure.error))index--;
    if(index<0)continue;
    const [{errorIndex}]=remaining.splice(index,1);
    cleanupErrors.push({errorIndex,message:errorText(failure.error),workerId:failure.workerId,sources:failure.sources});
  }
  cleanupErrors.sort((a,b)=>a.errorIndex-b.errorIndex);
  return cleanupErrors.length?{cleanupErrors}:{};
}
/** Classification view only: do not flatten recorded errors, change their order, or follow causes. */
export function errorMessages(errors:unknown[]):string[] {
  const messages:string[]=[],seen=new Set<AggregateError>(),pending=[...errors].reverse();
  while(pending.length) {
    const error=pending.pop();messages.push(errorText(error));
    if(error instanceof AggregateError&&!seen.has(error)) {
      seen.add(error);
      for(let index=error.errors.length-1;index>=0;index--)pending.push(error.errors[index]);
    }
  }
  return messages;
}
interface ErrorDetail { message:string; source?:CleanupSource; }
export interface AggregateDetails { message:string; children:(ErrorDetail&{children?:ErrorDetail[]})[]; }
function cleanupSource(error:AggregateError,index:number):{source?:CleanupSource} {
  const source=(error as AggregateError&{cleanupSources?:CleanupSource[]}).cleanupSources?.[index];
  return source&&["context","python","memory","model-drain"].includes(source)?{source}:{};
}
/** Diagnostic only: preserve direct children and one nested aggregate level, never follow causes. */
export function aggregateDetails(error:unknown):AggregateDetails|undefined {
  if(!(error instanceof AggregateError))return;
  return {message:error.message,children:Array.from(error.errors,(child,index)=>({message:errorText(child),...cleanupSource(error,index),
    ...(child instanceof AggregateError?{children:Array.from(child.errors,(nested,index)=>({message:errorText(nested),...cleanupSource(child,index)}))}:{})}))};
}
export function aggregateDiagnostics(errors:unknown[]) {
  const aggregateErrors=errors.flatMap((error,errorIndex)=>{
    const details=aggregateDetails(error);return details?[{errorIndex,...details}]:[];
  });
  return aggregateErrors.length?{aggregateErrors}:{};
}
/** Restore only the bounded diagnostic tree carried by a Worker cleanup reply. */
export function cleanupReplyError(message:string,details?:AggregateDetails,provenance?:CleanupProvenance):Error {
  const restore=(message:string,children:ErrorDetail[],errors:Error[])=>Object.assign(new AggregateError(errors,message),{
    cleanupSources:children.map(child=>child.source),
  });
  const error=details?restore(message,details.children,details.children.map(child=>child.children
    ?restore(child.message,child.children,child.children.map(nested=>new Error(nested.message)))
    :new Error(child.message))):new Error(message);
  if(provenance?.sources.length)cleanupReplies.set(error,provenance);
  return error;
}
const lost = new Map<string, { count:number; droppedRecords:number|null; reason:string }>();
const malformedLines = new Map<string, Set<number>>();
export function recordingFailure(path:string,error:unknown,droppedRecords?:number) {
  const previous=lost.get(path);
  lost.set(path,{count:(previous?.count??0)+1,droppedRecords:droppedRecords===undefined||previous?.droppedRecords===null?null:(previous?.droppedRecords??0)+droppedRecords,reason:errorText(error)});
}
export function recordingFailures() { return Object.fromEntries(lost); }
export function log(path: string, row: unknown) { try { appendFileSync(path, JSON.stringify(row) + "\n"); } catch(error) { recordingFailure(path,error,1); } }
export function auxiliaryJson(path:string,row:unknown) { try{jsonNew(path,row);}catch(error){recordingFailure(path,error);} }
/** Publish only a complete JSON. link is atomic and refuses an existing destination on both platforms. */
export function jsonNew(path: string, row: unknown) {
  const encoded=JSON.stringify(row,null,2)+"\n",temporary=path+".pending-"+randomUUID();
  const fd=openSync(temporary,"wx");let closed=false;
  try{writeFileSync(fd,encoded);fsyncSync(fd);closeSync(fd);closed=true;linkSync(temporary,path);}
  finally{
    if(!closed)closeSync(fd);
    try{unlinkSync(temporary);}catch(error){recordingFailure(temporary,error);}
  }
}
export function lines(path: string): any[] {
  try { return readFileSync(path, "utf8").split(/\r?\n/).flatMap((s,index) => {
    if(!s)return [];
    try{const row=JSON.parse(s);if(!row||typeof row!=="object"||Array.isArray(row))throw new Error("JSONL record must be an object");return [row];}
    catch(error){
      const key=resolve(path),seen=malformedLines.get(key)??new Set<number>();
      recordingFailure(key,error,seen.has(index+1)?0:1);
      seen.add(index+1);malformedLines.set(key,seen);
      return [{malformed:true,sourceFile:path,line:index+1,raw:s}];
    }
  }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") recordingFailure(path,error); return []; }
}
export function taskFrom(input: any): string | null {
  return input?.scope?.sessionId ?? input?.call?.arguments?.taskId ?? input?.memories?.[0]?.metadata?.taskId ?? input?.metadata?.taskId ?? null;
}
export const milliseconds = (end: any, start: any): number | null => end?.ns && start?.ns ? Number(BigInt(end.ns) - BigInt(start.ns)) / 1e6 : null;
/** Preserve both unmatched sides. Invocation IDs also cover debug snapshots outside graphs. */
export function mergeSteps(directory: string, persist=true) {
  const parent = lines(join(directory, "parent.steps.jsonl"));
  let children:any[]=[];
  try{children = readdirSync(join(directory, "workers")).filter(n => n.endsWith(".steps.jsonl")).flatMap(n => lines(join(directory, "workers", n)));}
  catch(error){recordingFailure(join(directory,"workers"),error);}
  const invalid=children.filter(row=>typeof row.invocationId!=="string"||!row.invocationId);
  const received = new Map<string,any[]>();
  for(const row of children.filter(row=>typeof row.invocationId==="string"&&row.invocationId)){
    const bucket=received.get(row.invocationId)??[];bucket.push(row);received.set(row.invocationId,bucket);
  }
  const taskByRun = new Map<string, string>();
  for (const row of [...parent, ...children]) if (row.execution?.runId && row.taskId) taskByRun.set(row.execution.runId, row.taskId);
  const combined = parent.map(row => {
    const child = typeof row.invocationId==="string"?received.get(row.invocationId)?.shift():undefined;
    return { ...row, ...child, sent: row.sent, returned: row.returned, match: child ? "matched" : "missing-worker" };
  });
  for(const bucket of received.values())for(const row of bucket)combined.push({ ...row, sent: null, returned: null, match: "missing-parent" });
  for(const row of invalid)combined.push({ ...row, sent: null, returned: null, match: "missing-parent" });
  for(const row of lines(join(directory, "direct.steps.jsonl")))combined.push(row);
  const result = combined.map(row => {
    const taskId = row.taskId ?? taskByRun.get(row.execution?.runId) ?? null;
    const ipcOut = milliseconds(row.received, row.sent), ipcBack = milliseconds(row.returned, row.ended);
    return { ...row, taskId, graphId: row.execution?.graphId ?? null, runId: row.execution?.runId ?? null,
      step: row.execution?.nodeId ?? null, ipcMs: row.direct || ipcOut === null || ipcBack === null ? null : ipcOut + ipcBack,
      queueMs: row.direct ? null : milliseconds(row.started, row.received), workMs: milliseconds(row.ended, row.started),
      missing: row.direct ? ["IPC and queue not applicable"] : [!row.sent && "sent", !row.received && "received", !row.started && "started", !row.ended && "ended", !row.returned && "returned", !taskId && "taskId"].filter(Boolean) };
  });
  if(persist)try { writeFileSync(join(directory, "steps.jsonl"), result.map(row => JSON.stringify(row)).join("\n") + (result.length ? "\n" : ""), { flag: "wx" }); }
  catch(error){recordingFailure(join(directory,"steps.jsonl"),error);}
  return result;
}
export function scoringFields(node:string,input:any,result:any) {
  if(node==="CONTEXT.SELECT")return {selectedItemIds:Array.isArray(result?.selectedItemIds)?result.selectedItemIds:null};
  if(node!=="INFER.REASONING.SAMPLE"&&node!=="INTERACTION.ACT.TOOL")return {};
  return {kind:node==="INFER.REASONING.SAMPLE"?"infer":"tool",
    action:node==="INFER.REASONING.SAMPLE"?"sample":input?.call?.arguments?.release?"release":input?.call?.arguments?.request?.action,
    status:result?.status??"failed",toolCallId:input?.call?.id,
    ...(node==="INFER.REASONING.SAMPLE"?{actionRequestIds:(result?.output?.actionRequests??[]).map((c:any)=>c.id),budgetReceipt:result?.output?.message?.metadata?.budgetReceipt??null}:{})};
}
/** Per-task authoritative trace. Never reconstructed from best-effort disk records. */
export class ScoringTrace {
  readonly events:any[]=[];
  private failure:unknown;
  constructor(readonly taskId:string, readonly webReplay=false) {}
  add(node:string,input:any,result:any,identity:any,error?:unknown) {
    const {budgetReceipt:_,...fields}=scoringFields(node,input,result) as any;
    if(!fields.kind)return;
    if(taskFrom(input)!==this.taskId||!fields.action||
      (!error&&typeof result?.status!=="string")||
      (fields.kind==="tool"&&typeof fields.toolCallId!=="string")||
      (fields.kind==="infer"&&result?.status==="success"&&(!result.output||fields.actionRequestIds.some((id:any)=>typeof id!=="string"))))
      throw new Error("Required scoring event unavailable or invalid");
    const request = input?.call?.arguments?.request;
    const webReplayCall = this.webReplay && fields.kind === "tool" && fields.action === "call"
      ? {name:request.tool_name, arguments:request.arguments} : undefined;
    this.events.push({...identity,...fields,taskId:this.taskId,
      ...(webReplayCall ? {webReplayCall} : {}),error:error?errorText(error):result?.error?.message??undefined});
  }
  fail(error:unknown){this.failure??=error;}
  validate(events:any[],result:any) {
    if(this.failure)throw this.failure;
    const calls=events.filter(e=>e.kind==="tool"&&e.action==="call"),inferences=events.filter(e=>e.kind==="infer");
    if(calls.length!==result.completed.length||inferences.length!==result.modelSteps.length||
      [...calls,...inferences].some(e=>e.status!=="success"||e.error)||
      calls.some((e,i)=>e.toolCallId!==result.completed[i].id)||
      inferences.some((e,i)=>JSON.stringify(e.actionRequestIds)!==JSON.stringify((result.modelSteps[i].output.actionRequests??[]).map((c:any)=>c.id))))
      throw new Error("Required scoring events do not match task steps");
  }
}
export const scoringScope=new AsyncLocalStorage<ScoringTrace>();
export type FailureType = "sample-not-success"|"memory-not-success"|"context-error"|"tool-channel"|"cleanup"|"scoring-trace"|"other";
export interface FailureNode { node:string;status?:string;workerId?:string|null;execution?:unknown; }
export interface FailureSource { type:FailureType;node:FailureNode|null; }
const origins=new WeakMap<object,FailureSource>();
const outputNodes=new WeakMap<object,FailureNode>();
const objectKey=(value:unknown):value is object=>value!==null&&(typeof value==="object"||typeof value==="function");
function originOf(error:unknown):FailureSource|undefined { return objectKey(error)?origins.get(error):undefined; }
export function failureOrigin(error:unknown):FailureType|undefined {
  return originOf(error)?.type;
}
/** Mark at the source. Keep the original object/message and the earliest explicit origin. */
export function markFailure(error:unknown,type:FailureType,node:FailureNode|null=null):unknown {
  const value=error!==null&&(typeof error==="object"||typeof error==="function")?error:new Error(errorText(error),{cause:error});
  if(!origins.has(value))origins.set(value,{type,node:node?{...node}:null});
  return value;
}
export function checkedFailure<T>(type:FailureType,check:()=>T,output?:unknown,node?:string):T {
  try{return check();}catch(error){
    const at=objectKey(output)?outputNodes.get(output):undefined;
    throw markFailure(error,type,at??(node?{node}:null));
  }
}
function rememberOutput(value:any,node:FailureNode) {
  // Side tables only: model/context values and scoring payloads stay unchanged.
  for(const part of [value,value?.items,value?.context,value?.context?.items])
    if(objectKey(part))outputNodes.set(part,{...node});
}
export function isFailureType(value:unknown):value is FailureType {
  return ["sample-not-success","memory-not-success","context-error","tool-channel","cleanup","scoring-trace","other"].includes(value as string);
}
function nodeFailure(node:string):FailureType {
  if(node.startsWith("CONTEXT."))return "context-error";
  if(node==="INFER.REASONING.SAMPLE")return "sample-not-success";
  if(node==="MEMORY.WRITE")return "memory-not-success";
  if(node==="INTERACTION.ACT.TOOL")return "tool-channel";
  return "other";
}
function recordNodeFailure(failure:FailureTrace,error:unknown,node:FailureNode) {
  failure.record(error,nodeFailure(node.node),node);
}
/** Failure metadata is independent of best-effort performance logs and scoring events. */
export class FailureTrace {
  last?: FailureNode;
  readonly workers=new Set<string>();
  readonly causes=new Map<unknown,FailureType>();
  readonly nodes=new Map<unknown,FailureNode|null>();
  readonly precedingErrors=new Map<unknown,unknown[]>();
  constructor(readonly taskId:string) {}
  /** Keep the first classification and its node together, including explicit origins. */
  record(error:unknown,type:FailureType,node:FailureNode|null=null):void {
    if(this.causes.has(error))return;
    const source=originOf(error)??{type,node};
    this.causes.set(error,source.type);this.nodes.set(error,source.node?{...source.node}:null);
  }
  classify(error:unknown):FailureType {
    return this.source(error).type;
  }
  source(error:unknown):FailureSource {
    if(this.causes.has(error))return {type:this.causes.get(error)!,node:this.nodes.get(error)??null};
    return originOf(error)??{type:"other",node:null};
  }
}
export const failureScope=new AsyncLocalStorage<FailureTrace>();
/** Record before handing the return value back to the task driver; recorder errors are fatal. */
export async function captureScoring<T>(node:string,input:any,identity:any,work:()=>Promise<T>,decode:(value:T)=>any=value=>value):Promise<T> {
  const failure=failureScope.getStore();
  // A diagnostic snapshot may fail harmlessly and must never replace the task's failure.
  if(!failure||input?.call?.arguments?.request?.action==="snapshot")return recordScoring(node,input,identity,work,decode);
  if(identity.workerId)failure.workers.add(identity.workerId);
  const current={node,status:undefined as string|undefined,workerId:identity.workerId};failure.last=current;
  try {
    const result=await recordScoring(node,input,identity,work,decode,current),decoded=decode(result);
    current.status=decoded?.status;
    rememberOutput(decoded,current);
    return result;
  }catch(error){
    recordNodeFailure(failure,error,current);
    throw error;
  }
}
async function recordScoring<T>(node:string,input:any,identity:any,work:()=>Promise<T>,decode:(value:T)=>any,current:FailureNode={node,workerId:identity.workerId}):Promise<T> {
  const trace=scoringScope.getStore();
  if(!trace||(node!=="INFER.REASONING.SAMPLE"&&node!=="INTERACTION.ACT.TOOL"))return work();
  let value:T;
  try{value=await work();}
  catch(error){
    try{trace.add(node,input,null,identity,error);}catch(recordError){
      const failure=failureScope.getStore();
      if(failure){
        recordNodeFailure(failure,error,current);
        failure.record(recordError,"scoring-trace",current);
        failure.precedingErrors.set(recordError,[error,recordError]);
      }
      trace.fail(recordError);throw recordError;
    }
    throw error;
  }
  let decoded:any;
  try{decoded=decode(value);trace.add(node,input,decoded,identity);}catch(error){
    const failure=failureScope.getStore();
    failure?.record(error,"scoring-trace",current);
    if(failure&&typeof decoded?.status==="string"&&decoded.status!=="success"){
      const first=new Error(decoded.error?.message??`${node} returned ${decoded.status}`);
      current.status=decoded.status;
      recordNodeFailure(failure,first,current);failure.precedingErrors.set(error,[first,error]);
    }
    trace.fail(error);throw error;
  }
  return value;
}
