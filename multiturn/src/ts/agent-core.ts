import { randomUUID } from "node:crypto";
import { defineWorker, type WorkerContext, type WorkerExecutor } from "@codesoul-co/ditto/worker";
import { createContextWorker, createContextOperationQueue } from "@codesoul-co/ditto/worker/context";
import { createInferWorker, type ModelProvider } from "@codesoul-co/ditto/worker/infer";
import { createInteractionWorker } from "@codesoul-co/ditto/worker/interaction";
import { createMemoryWorker } from "@codesoul-co/ditto/worker/memory";
import { Sandbox } from "@codesoul-co/ditto/runtime/sandbox";
import { createContextStore, BFCL_CONTEXT_TTL_MS } from "./context-store.ts";
import { createMemoryStore } from "./memory-store.ts";
import { createModelClient } from "./model-client.ts";
import { createToolService } from "./tool-service.ts";
import { createBfclSampleExecutor } from "./bfcl-sample.ts";
import { cleanupScope } from "./step-log.ts";

export const CONTEXT_NODES = ["CONTEXT.LOAD", "CONTEXT.SELECT", "CONTEXT.UPDATE", "CONTEXT.COMPRESS"] as const;
export const INFER_NODES = ["INFER.REASONING.SAMPLE", "INFER.REASONING.TRAJECTORY", "INFER.REASONING.REFLECT", "INFER.REASONING.DELIBERATE", "INFER.CACHE.LOOKUP", "INFER.CACHE.WRITE", "INFER.CACHE.INVALIDATE"] as const;
export const INTERACTION_NODES = ["INTERACTION.ACT.TOOL", "INTERACTION.OBSERVE"] as const;
export const MEMORY_NODES = ["MEMORY.GET", "MEMORY.QUERY", "MEMORY.SEARCH", "MEMORY.WRITE", "MEMORY.UPDATE", "MEMORY.DELETE"] as const;
export const AGENT_CORE_NODES = [...CONTEXT_NODES, ...INFER_NODES, ...INTERACTION_NODES, ...MEMORY_NODES] as const;
export type AgentCoreNode = typeof AGENT_CORE_NODES[number];
export const CAPABILITIES = { Context: CONTEXT_NODES, Infer: INFER_NODES, Interaction: INTERACTION_NODES, Memory: MEMORY_NODES };
export type Capability = keyof typeof CAPABILITIES;
// T3 11-04 修订：使用 Ditto v0.1.5 原样允许的最大单条字节数。
export const CONTEXT_POLICY = { maxItems: 10_000, maxInlineBytes: 1_000_000 } as const;
// Ditto 0.1.5 不支持关闭 TTL；本地存储将可配置上限放宽到一年。
// c<=8、最少一份 Infer 时最多八批；即使每批用满 32 位节点时限，
// 也小于 199 天（当前配置约 35.1 天）。正常回收仍由 releaseTask 完成。
export interface AgentCoreInstanceHandle {
  /** 这一份实例自己的编号，每份不同。 */
  readonly instanceId: string;
  /** 只清理本实例的这一道题；不删除磁盘记忆。 */
  releaseTask(taskId: string): Promise<{ contextDeleted: boolean; pythonReleased: boolean }>;
}
export interface AgentCoreOptions {
  readonly modelEndpoint?: string;
  readonly providerFactory?: () => ModelProvider;
  /** 由部署层按出口总时长配置，不能隐式落回官方的 30 秒。 */
  readonly inferenceTimeoutMs: number;
  readonly memoryDirectory: string;
  readonly python: string;
  readonly onServiceCreated?: (capability: Capability) => void;
  readonly onInstance?: (handle: AgentCoreInstanceHandle) => void;
}

/** Worker 与 Direct 共用此调用表；每次建立它得到一份独立的惰性服务。 */
export function createAgentCoreSteps(options: AgentCoreOptions) {
  const executors = new Map<Capability, WorkerExecutor>();
  let contextStore: ReturnType<typeof createContextStore> | undefined;
  let contextQueue: ReturnType<typeof createContextOperationQueue> | undefined;
  let toolService: ReturnType<typeof createToolService> | undefined;
  let memoryStore: ReturnType<typeof createMemoryStore> | undefined;
  let sample: ReturnType<typeof createBfclSampleExecutor> | undefined;
  const modelCalls = new Map<string, Set<Promise<unknown>>>();
  async function drainModelCalls(taskId?: string) {
    const pending = taskId === undefined ? [...modelCalls.values()].flatMap(calls => [...calls]) : [...(modelCalls.get(taskId) ?? [])];
    const results = await Promise.allSettled(pending);
    const stopped = results.find(r => r.status === "rejected" && String(r.reason).includes("BFCL_RUN_STOP:"));
    if (stopped?.status === "rejected") throw stopped.reason;
  }
  let closed = false;
  function executor(capability: Capability) {
    const existing = executors.get(capability);
    if (existing) return existing;
    let value: WorkerExecutor;
    switch (capability) {
      case "Context":
        contextStore = createContextStore({ ttlMs: BFCL_CONTEXT_TTL_MS });
        contextQueue = createContextOperationQueue();
        value = createContextWorker({ policy: CONTEXT_POLICY, services: { stateStore: contextStore, operationQueue: contextQueue } }).instantiate(); break;
      case "Infer": {
        let provider = options.providerFactory?.();
        if (!provider && options.modelEndpoint) {
          const client = createModelClient(options.modelEndpoint, { taskCancellation: "drain" });
          provider = { invoke(input, callOptions) {
            const taskId = String(input.metadata?.taskId), pending = client.invoke(input, callOptions);
            const calls = modelCalls.get(taskId) ?? new Set<Promise<unknown>>();
            modelCalls.set(taskId, calls); calls.add(pending);
            const remove = () => { calls.delete(pending); if (!calls.size) modelCalls.delete(taskId); };
            void pending.then(remove, remove);
            return pending;
          } };
        }
        if (!provider) throw new Error("需要模型出口地址或显式 providerFactory");
        const infer = { providers: { configured: provider }, defaultProvider: "configured", timeoutMs: options.inferenceTimeoutMs };
        sample = createBfclSampleExecutor(infer);
        value = createInferWorker(infer).instantiate(); break;
      }
      case "Interaction":
        toolService = createToolService(options.python);
        value = createInteractionWorker({ tools: [toolService.tool] }).instantiate(); break;
      case "Memory":
        memoryStore = createMemoryStore(options.memoryDirectory, { restartOnFirstWrite: true });
        value = createMemoryWorker({ store: memoryStore }).instantiate(); break;
    }
    executors.set(capability,value);
    options.onServiceCreated?.(capability);
    return value;
  }
  return {
    async execute(node: AgentCoreNode, input: unknown, ctx: WorkerContext): Promise<unknown> {
      if (closed) throw new Error("agent-core 已关闭");
      const capability = (Object.keys(CAPABILITIES) as Capability[]).find(key => (CAPABILITIES[key] as readonly string[]).includes(node));
      if (!capability) throw new Error(`未知 agent-core 节点：${node}`);
      const target = executor(capability);
      if (node === "INFER.REASONING.SAMPLE") {
        // The SDK races provider work against abort. Keep this task's service
        // alive until its HTTP request settles, even if that race finishes first.
        try { return await sample!(node,input,ctx.signal ? { signal:ctx.signal } : {},undefined,ctx.services); }
        finally {
          const taskId = (input as { metadata?: { taskId?: string } } | null)?.metadata?.taskId;
          if (typeof taskId === "string") await drainModelCalls(taskId);
        }
      }
      // 本服务只放行 bfcl_bridge，与宿主其他工具权限无关。
      if (capability === "Interaction") ctx = { ...ctx, services: { ...ctx.services, sandbox: new Sandbox(ctx.services.config.workspace, { tools: ["bfcl_bridge"] }) } };
      return target.execute(node,input,ctx);
    },
    async deleteContext(taskId: string) { return contextStore?.delete({sessionId:taskId}) ?? false; },
    async releaseTask(taskId: string) {
      if (closed) return { contextDeleted:false, pythonReleased:false };
      const scope = { sessionId:taskId };
      // 与节点共用同一队列；即使一项清理失败，也等另一项清理结束再报错。
      const results = await Promise.allSettled([
        contextQueue?.enqueue(scope, () => contextStore!.delete(scope)) ?? false,
        toolService?.releaseTask(taskId) ?? false,
        memoryStore?.releaseTask(taskId),
        drainModelCalls(taskId),
      ]);
      const sources = ["context", "python", "memory", "model-drain"] as const;
      const cleanupSources: (typeof sources)[number][] = [];
      const errors = results.filter((r,index): r is PromiseRejectedResult => {
        if (r.status !== "rejected") return false;
        cleanupSources.push(sources[index]);return true;
      }).map(r => r.reason);
      // Per-release diagnostics live outside the rejected object, including frozen/primitive errors.
      const capture = cleanupScope.getStore();
      if (capture && errors.length) capture.sources = cleanupSources;
      if (errors.length === 1) throw errors[0];
      if (errors.length > 1) {
        // Keep provenance on the aggregate, never mutate or wrap the original errors.
        throw Object.assign(new AggregateError(errors, "按题清理失败"), { cleanupSources });
      }
      return { contextDeleted:results[0].status === "fulfilled" && results[0].value,
        pythonReleased:results[1].status === "fulfilled" && results[1].value };
    },
    async dispose() {
      if (closed) return; closed = true;
      const results = await Promise.allSettled([drainModelCalls(), toolService?.dispose(), ...[...executors.values()].map(e => e.dispose?.())]);
      const failed = results.find(r => r.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    },
  };
}

export function createAgentCoreWorker(options: AgentCoreOptions) {
  return defineWorker({ type: "agent-core", resources: () => {
    const steps = createAgentCoreSteps(options);
    options.onInstance?.(Object.freeze({ instanceId:randomUUID(), releaseTask:steps.releaseTask }));
    return steps;
  }, dispose: r => r.dispose(),
    nodes: Object.fromEntries(AGENT_CORE_NODES.map(node => [node, (input: unknown, ctx: WorkerContext<ReturnType<typeof createAgentCoreSteps>>) =>
      ctx.resources.execute(node,input,{ ...ctx, resources:undefined, config:undefined })])),
  });
}
