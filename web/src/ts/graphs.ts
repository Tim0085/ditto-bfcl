import { createHash } from "node:crypto";
import { graph } from "@codesoul-co/ditto";
import type { ContextItem, Observation } from "@codesoul-co/ditto/contracts";
import { toContextItems, observationToIngress, toModelMessages, assertWireSafe, type ModelMessage } from "./context-messages.ts";
import { assistantMessage } from "./egress/offline.ts";
import { modelOutputFailureDetails } from "./egress/retry.ts";
import type { AgentCoreNode } from "./agent-core.ts";
import { checkedFailure } from "./step-log.ts";

/** One cursor per task. Neither sequence nor turn can be assigned by a caller. */
export class MessageCursor {
  #sequence = 0;
  #turn = 0;
  constructor() { Object.freeze(this); }
  nextTurn() { return ++this.#turn; }
  get turn() { return this.#turn; }
  get count() { return this.#sequence; }
  messages(messages: readonly ModelMessage[]) {
    const items = toContextItems(messages, { turn: this.#turn, startStep: this.#sequence });
    return items.map(item => ({ ...item, metadata: { ...item.metadata, sequence: this.#sequence++ } }));
  }
  observation(observation: Observation, group: string) {
    const item = observationToIngress(observation, group);
    return { ...item, metadata: { ...item.metadata, sequence: this.#sequence++ } };
  }
}

export function checkContext(value: any,node?:string,source:unknown=value): void {
  return checkedFailure("context-error",()=>{
  if (!Array.isArray(value?.items)) throw new Error("记录本缺少 items");
  const ids = new Set(), numbers = new Set();
  for (const item of value.items) {
    const seq = item.metadata?.sequence;
    if (typeof item.id !== "string" || ids.has(item.id) || !Number.isSafeInteger(seq) || seq < 0 || numbers.has(seq))
      throw new Error("记录本编号或写入序号重复/无效");
    ids.add(item.id); numbers.add(seq);
  }
  },source??value?.items,node);
}
export function legacyMessages(items: readonly ContextItem[]): ModelMessage[] {
  return checkedFailure("context-error",()=>{
  checkContext({ items },undefined,items);
  const sorted = [...items].sort((a,b) => Number(a.metadata!.sequence) - Number(b.metadata!.sequence));
  return toModelMessages(sorted).map(message => message.role === "tool" ? {
    role: "tool", content: message.content,
    metadata: { actionRequestId: message.metadata!.actionRequestId, name: message.metadata!.name },
  } : message);
  },items);
}
export function selectedMessages(selection: any, count: number): ModelMessage[] {
  return checkedFailure("context-error",()=>{
  checkContext(selection?.context,"CONTEXT.SELECT",selection);
  const items: ContextItem[] = selection.context.items;
  if (items.length !== count || selection.selectedItemIds?.length !== count ||
      new Set(selection.selectedItemIds).size !== count || items.some(item => !selection.selectedItemIds.includes(item.id)))
    throw new Error("记录本挑选丢失条目");
  if ([...items].sort((a,b) => Number(a.metadata!.sequence)-Number(b.metadata!.sequence))
      .some((item,index) => item.metadata!.sequence !== index)) throw new Error("记录本写入序号不连续");
  const messages = legacyMessages(items); assertWireSafe(messages); return messages;
  },selection,"CONTEXT.SELECT");
}
export function checkSuccess(result: any): void {
  if (result?.status !== "success") throw new Error(result?.error?.message ?? `节点未成功：${result?.status}`);
}
function checkTool(result: any): void {
  return checkedFailure("tool-channel",()=>{
  // BFCL domain errors are successful observation strings; transport errors must stop.
  checkSuccess(result);
  if (!result.callId) throw new Error("工具结果缺少调用编号");
  },result,"INTERACTION.ACT.TOOL");
}
function checkObservation(result: any): void {
  return checkedFailure("other",()=>{
  if (result?.message?.role !== "tool" || typeof result.message.content !== "string") throw new Error("工具观察必须是字符串");
  },result,"INTERACTION.OBSERVE");
}
function checkSelection(result: any): void { checkContext(result?.context,"CONTEXT.SELECT",result); }

export interface StageInput {
  taskId: string; caseId: string; configId: string;
  cursor: MessageCursor; messages?: ModelMessage[]; actions?: any[];
  model: string; maxTokens: number; step: number;
  call?: any; group?: string; completedTurns?: number;
}
export interface StageStep {
  readonly id: string; readonly node: AgentCoreNode; readonly dependencies: readonly string[];
  readonly bind: (input: StageInput, outputs: Readonly<Record<string, any>>) => any;
  readonly validateOutput: (output: any) => void;
}
function tool(input: StageInput, request: any, id: string) {
  return { call: { id, name: "bfcl_bridge", arguments: { taskId: input.taskId, ...request } } };
}
const scope = (input: StageInput) => ({ sessionId: input.taskId });
export const STAGES = {
  open: [
    { id:"init",node:"INTERACTION.ACT.TOOL",dependencies:[],bind:(i) => tool(i,{request:{action:"init",case_id:i.caseId}},`${i.taskId}/init`),validateOutput:checkTool },
    { id:"load",node:"CONTEXT.LOAD",dependencies:["init"],bind:(i) => ({scope:scope(i),sources:i.cursor.messages(i.messages!)}),validateOutput:result=>checkContext(result,"CONTEXT.LOAD") },
  ],
  turn: [
    { id:"user",node:"CONTEXT.UPDATE",dependencies:[],bind:(i) => ({scope:scope(i),add:i.cursor.messages(i.messages!)}),validateOutput:result=>checkContext(result,"CONTEXT.UPDATE") },
  ],
  missingTurn: [
    { id:"turn",node:"INTERACTION.ACT.TOOL",dependencies:[],bind:(i) => tool(i,{request:{action:"turn",turn:i.cursor.turn}},`${i.taskId}/turn-${i.cursor.turn}`),validateOutput:checkTool },
    { id:"user",node:"CONTEXT.UPDATE",dependencies:["turn"],bind:(i) => ({scope:scope(i),add:i.cursor.messages(i.messages!)}),validateOutput:result=>checkContext(result,"CONTEXT.UPDATE") },
  ],
  think: [
    { id:"select",node:"CONTEXT.SELECT",dependencies:[],bind:(i) => ({scope:scope(i),purpose:"infer"}),validateOutput:checkSelection },
    { id:"sample",node:"INFER.REASONING.SAMPLE",dependencies:["select"],bind:(i,o) => ({messages:selectedMessages(o.select,i.cursor.count),actions:i.actions,
      model:{provider:"configured",model:i.model},generation:{maxTokens:i.maxTokens},metadata:{turn:i.cursor.turn,step:i.step,taskId:i.taskId,caseId:i.caseId,configId:i.configId}}),validateOutput:result=>checkedFailure("sample-not-success",()=>checkSuccess(result),result,"INFER.REASONING.SAMPLE") },
    { id:"note",node:"CONTEXT.UPDATE",dependencies:["sample"],bind:(i,o) => ({scope:scope(i),add:i.cursor.messages(modelOutputFailureDetails(o.sample.output)?[]:[assistantMessage(o.sample.output) as ModelMessage])}),validateOutput:result=>checkContext(result,"CONTEXT.UPDATE") },
  ],
  action: [
    { id:"act",node:"INTERACTION.ACT.TOOL",dependencies:[],bind:(i) => tool(i,{request:{action:"call",tool_name:i.call.name,arguments:i.call.arguments}},i.call.id),validateOutput:checkTool },
    { id:"observe",node:"INTERACTION.OBSERVE",dependencies:["act"],bind:(i,o) => ({result:{...o.act,source:i.call.name,metadata:{}}}),validateOutput:checkObservation },
    { id:"note",node:"CONTEXT.UPDATE",dependencies:["observe"],bind:(i,o) => ({scope:scope(i),ingress:[i.cursor.observation(o.observe,i.group!)]}),validateOutput:result=>checkContext(result,"CONTEXT.UPDATE") },
  ],
  save: [
    { id:"save",node:"MEMORY.WRITE",dependencies:[],bind:(i) => ({memories:[{key:`${i.taskId}/turn-${i.cursor.turn}`,content:{messages:i.messages,completedTurns:i.completedTurns},metadata:{taskId:i.taskId,turn:i.cursor.turn}}]}),validateOutput:result=>checkedFailure("memory-not-success",()=>checkSuccess(result),result,"MEMORY.WRITE") },
  ],
  close: [
    { id:"release",node:"INTERACTION.ACT.TOOL",dependencies:[],bind:(i) => tool(i,{release:true},`${i.taskId}/release`),validateOutput:checkTool },
  ],
} satisfies Record<string, readonly StageStep[]>;
export type Stage = keyof typeof STAGES;
export const graphId = (stage: Stage) => `bfcl-${stage}`;
// Direct imports the shared bind/check functions but never calls this constructor.
export function createGraphs() {
  return Object.fromEntries(Object.entries(STAGES).map(([id,steps]) => {
    let plan: any = graph<StageInput>(graphId(id as Stage));
    for (const step of steps) plan = plan.node(step.id,step.node,step.dependencies,step.bind,step.validateOutput);
    return [id,plan];
  })) as Record<Stage, ReturnType<typeof graph<StageInput>>>;
}
export function graphManifest(stages: Record<string, readonly StageStep[]> = STAGES) {
  return Object.entries(stages).map(([id,steps]) => ({id:graphId(id as Stage),steps:steps.map(s => ({id:s.id,node:s.node,dependencies:s.dependencies,
    bind:s.bind.toString(),validateOutput:s.validateOutput.toString()}))}));
}
export function graphFingerprint(stages: Record<string, readonly StageStep[]> = STAGES) {
  return createHash("sha256").update(JSON.stringify({graphs:graphManifest(stages),helpers:[MessageCursor,legacyMessages,selectedMessages,checkContext,checkSuccess,checkTool,checkObservation,scope,tool].map(String)})).digest("hex");
}
