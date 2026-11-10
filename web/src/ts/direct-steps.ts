import { loadRuntimeConfig } from "@codesoul-co/ditto/runtime";
import { ProviderRegistry } from "@codesoul-co/ditto/worker/infer/providers";
import { Sandbox } from "@codesoul-co/ditto/runtime/sandbox";
import type { WorkerContext } from "@codesoul-co/ditto/worker";
import type { InputOf, OutputOf } from "@codesoul-co/ditto/contracts";
import { createAgentCoreSteps, type AgentCoreNode, type AgentCoreOptions } from "./agent-core.ts";

/** 普通函数调用。仅创建官方处理函数所需的服务参数，不创建 Runtime、路由、图或 IPC。 */
export function createDirectSteps(options: AgentCoreOptions) {
  const steps = createAgentCoreSteps(options), config = loadRuntimeConfig({});
  const unavailable = async (): Promise<never> => { throw new Error("Direct 不提供图或路由调用"); };
  const context: WorkerContext = { resources:undefined, config:undefined, artifacts:undefined, execution:undefined,
    worker: { workerId:"direct", workerType:"agent-core", hostId:"direct", processId:String(process.pid) },
    services:{ config, providers:new ProviderRegistry(), sandbox:new Sandbox(config.workspace,{tools:["bfcl_bridge"]}) },
    invoke:unavailable, run:unavailable, emit:unavailable,
  };
  return {
    execute<N extends AgentCoreNode>(node: N, input: InputOf<N>, signal?: AbortSignal): Promise<OutputOf<N>> {
      return steps.execute(node,input,{...context,...(signal ? {signal} : {})}) as Promise<OutputOf<N>>;
    },
    deleteContext: steps.deleteContext,
    releaseTask: steps.releaseTask,
    dispose: steps.dispose,
  };
}
