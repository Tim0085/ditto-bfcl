import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { after } from "node:test";
import { tmpdir } from "node:os";
import { join, dirname, basename, resolve } from "node:path";
import { createHash } from "node:crypto";
import { loadRuntimeConfig } from "@codesoul-co/ditto/runtime";
import { ProviderRegistry } from "@codesoul-co/ditto/worker/infer/providers";
import { Sandbox } from "@codesoul-co/ditto/runtime/sandbox";
import type { WorkerContext } from "@codesoul-co/ditto/worker";
import type { ModelProvider, SampleInput, SampleOutput } from "@codesoul-co/ditto/worker/infer";
import type { AgentCoreOptions, AgentCoreNode } from "../src/ts/agent-core.ts";
export const input: SampleInput = { model:{provider:"configured",model:"offline"},messages:[{role:"user",content:"hi"}],metadata:{configId:"test",taskId:"task",caseId:"multi_turn_base_0",turn:1,step:1} };
export const output: SampleOutput = {message:{role:"assistant",content:"ok"},finishReason:"stop"};
export const provider: ModelProvider = { async invoke(i) {
  const system = i.messages[0].content;
  if (typeof system === "string" && system.includes("Compare the supplied candidates")) return {...output,message:{role:"assistant",content:JSON.stringify({result:output.message,selectedCandidateIds:["a"]})}};
  if (typeof system === "string" && system.includes("assessment")) return {...output,message:{role:"assistant",content:JSON.stringify({assessment:{passed:true,summary:"ok"},issues:[]})}};
  return structuredClone(output);
} };
const temporaryDirectories: string[] = [];
after(async () => { for (const directory of temporaryDirectories) {
  if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith("t3-memory-")) throw new Error("Unexpected test directory");
  await rm(directory,{recursive:true,force:true});
} });
export async function options(extra: Partial<AgentCoreOptions> = {}): Promise<AgentCoreOptions> {
  const directory = await mkdtemp(join(tmpdir(),"t3-memory-")); temporaryDirectories.push(directory);
  return {inferenceTimeoutMs:1000,python:process.env.T3_PYTHON ?? "python",memoryDirectory:directory,providerFactory:()=>provider,...extra};
}
export function context(signal?: AbortSignal): WorkerContext {
  const config=loadRuntimeConfig({}), unavailable=async ():Promise<never>=>{throw new Error("unexpected routing");};
  return {resources:undefined,config:undefined,artifacts:undefined,execution:undefined,worker:{workerId:"test",workerType:"agent-core",hostId:"test",processId:"test"},services:{config,providers:new ProviderRegistry(),sandbox:new Sandbox(config.workspace,{tools:["bfcl_bridge"]})},invoke:unavailable,run:unavailable,emit:unavailable,...(signal?{signal}:{})};
}
// 仅规范化执行结果顶层的 executionId、轨迹步骤 UUID（保留引用关系）、Memory 生成的 UUID 后缀。
export function normalize(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const result = structuredClone(value) as any;
  if (typeof result.node !== "string") return result;
  delete result.executionId;
  if (result.node === "INFER.REASONING.TRAJECTORY" && result.output?.steps) {
    const ids = new Map(result.output.steps.map((step: any, i: number) => [step.id,`step-${i}`]));
    for (const step of result.output.steps) {
      step.id = ids.get(step.id);
      if (step.parentIds) step.parentIds = step.parentIds.map((id: string) => ids.get(id) ?? id);
    }
  }
  if (result.node.startsWith("MEMORY.")) {
    const items = Array.isArray(result.output) ? result.output : result.output?.items;
    for (const item of items ?? []) if (typeof item.id === "string") item.id = item.id.replace(/\.[0-9a-f-]{36}$/, ".UUID");
    if (result.output?.deleted) result.output.deleted = result.output.deleted.map((id: string) => id.replace(/\.[0-9a-f-]{36}$/, ".UUID"));
  }
  return result;
}
export async function outcome(job:()=>Promise<unknown>) {try {return normalize(await job());} catch(e) {return {thrown:{name:(e as Error).name,message:(e as Error).message,code:(e as {code?:string}).code}};} }

export const seedId=Buffer.from("seed").toString("base64url")+".00000000-0000-4000-8000-000000000001";
export async function seedMemory(o:AgentCoreOptions) {
  await writeFile(join(o.memoryDirectory,createHash("sha256").update("seed").digest("hex")+".json"),JSON.stringify({taskId:"seed",memories:[{id:seedId,key:"seed/turn-1",content:{messages:input.messages,completedTurns:1},metadata:{taskId:"seed",turn:1}}]}));
}
const ctx={items:[{id:"one",content:"hello"}]}, key={scope:"sample",key:"test"};
export const valid: Record<AgentCoreNode,unknown> = {
  "CONTEXT.LOAD":{sources:ctx.items}, "CONTEXT.SELECT":{context:ctx,purpose:"infer"}, "CONTEXT.UPDATE":{context:ctx,add:[{id:"two",content:"next"}]}, "CONTEXT.COMPRESS":{context:ctx,maxItems:1},
  "INFER.REASONING.SAMPLE":input,"INFER.REASONING.TRAJECTORY":{...input,strategy:{name:"cot",options:{rounds:1}}},
  "INFER.REASONING.REFLECT":{model:input.model,target:{result:{role:"assistant",content:"ok"}},mode:"verify"},
  "INFER.REASONING.DELIBERATE":{model:input.model,candidates:[{id:"a",result:{role:"assistant",content:"ok"}}]},
  "INFER.CACHE.LOOKUP":{key},"INFER.CACHE.WRITE":{key,value:{answer:1}},"INFER.CACHE.INVALIDATE":{selector:{type:"key",key}},
  "INTERACTION.ACT.TOOL":{call:{id:"release",name:"bfcl_bridge",arguments:{taskId:"absent",release:true}}},
  "INTERACTION.OBSERVE":{result:{callId:"c",source:"bfcl_bridge",status:"success",content:"hello"}},
  "MEMORY.GET":{ids:[seedId]},"MEMORY.QUERY":{filter:{"metadata.taskId":"seed"}},"MEMORY.SEARCH":{query:"hi"},
  "MEMORY.WRITE":{memories:[{key:"task/turn-1",content:{messages:input.messages,completedTurns:1},metadata:{taskId:"task",turn:1}}]},
  "MEMORY.UPDATE":{memories:[{id:seedId,content:{messages:input.messages,completedTurns:2}}]},"MEMORY.DELETE":{ids:[seedId]},
};
