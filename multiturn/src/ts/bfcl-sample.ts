// 来源：Ditto v0.1.5 d95ded5；复制官方处理代码，差异见交付说明。
import { validateRuntimeSettings, type InferSettings } from "../../vendor/ditto/dist/runtime/settings.js";
import { randomUUID } from "node:crypto";
import type { WorkerContext } from "../../vendor/ditto/dist/worker/execution-context.js";
import { defineWorker, type WorkerDefinition } from "../../vendor/ditto/dist/worker/define-worker.js";
import type { InferCallOptions, InferStreamEvent, NodeResult } from "../../vendor/ditto/dist/worker/infer/types.js";
import type { InferNode, InferInput, InferOutput } from "../../vendor/ditto/dist/worker/infer/contracts.js";
import type { InferExecution } from "../../vendor/ditto/dist/worker/infer/execution.js";
import type { ModelProvider } from "../../vendor/ditto/dist/worker/infer/providers/types.js";
import { ProviderRegistry } from "../../vendor/ditto/dist/worker/infer/providers/registry.js";
import type { RuntimeServices } from "../../vendor/ditto/dist/runtime/services.js";
import { InMemoryInferCache, type InferCacheProvider } from "../../vendor/ditto/dist/worker/infer/cache/provider.js";
import type { TrajectoryStrategy } from "../../vendor/ditto/dist/worker/infer/reasoning/trajectory/strategies/index.js";
import { sampleNode } from "./bfcl-sample-node.ts";
import { trajectoryNode, TrajectoryFailure } from "../../vendor/ditto/dist/worker/infer/reasoning/trajectory/node.js";
import { reflectNode } from "../../vendor/ditto/dist/worker/infer/reasoning/reflect/node.js";
import { deliberateNode } from "../../vendor/ditto/dist/worker/infer/reasoning/deliberate/node.js";
import { lookupNode } from "../../vendor/ditto/dist/worker/infer/cache/lookup/node.js";
import { writeNode } from "../../vendor/ditto/dist/worker/infer/cache/write/node.js";
import { invalidateNode } from "../../vendor/ditto/dist/worker/infer/cache/invalidate/node.js";
import { errorInfo, InferError, number } from "../../vendor/ditto/dist/worker/infer/validation.js";

export interface InferOptions {
  /** Explicit defaults replace Runtime infer defaults; snapshotted at creation. */
  defaults?: InferSettings;
  providers?: ProviderRegistry | Readonly<Record<string, ModelProvider>>;
  defaultProvider?: string;
  /** Omit for an isolated in-memory cache; supply a shared backend for multiple replicas. */
  cache?: InferCacheProvider;
  strategies?: Readonly<Record<string, TrajectoryStrategy>>;
  runtime?: { readonly services: RuntimeServices };
  /** Default per-call deadline, including provider work. Defaults to Runtime configuration, or 30 seconds without a Runtime. */
  timeoutMs?: number;
}
export interface InferMethod<N extends InferNode> {
  (input: InferInput<N>, options?: InferCallOptions): Promise<NodeResult<InferOutput<N>>>;
  stream(input: InferInput<N>, options?: InferCallOptions): AsyncIterable<InferStreamEvent<InferOutput<N>>>;
}
export interface InferClient {
  execute<N extends InferNode>(node: N, input: InferInput<N>, options?: InferCallOptions): Promise<NodeResult<InferOutput<N>>>;
  execute<I, O>(node: string, input: I, options?: InferCallOptions): Promise<NodeResult<O>>;
  reasoning: {
    sample: InferMethod<"INFER.REASONING.SAMPLE">;
    trajectory: InferMethod<"INFER.REASONING.TRAJECTORY">;
    reflect: InferMethod<"INFER.REASONING.REFLECT">;
    deliberate: InferMethod<"INFER.REASONING.DELIBERATE">;
  };
  cache: {
    lookup(input: InferInput<"INFER.CACHE.LOOKUP">, options?: InferCallOptions): Promise<NodeResult<InferOutput<"INFER.CACHE.LOOKUP">>>;
    write(input: InferInput<"INFER.CACHE.WRITE">, options?: InferCallOptions): Promise<NodeResult<InferOutput<"INFER.CACHE.WRITE">>>;
    invalidate(input: InferInput<"INFER.CACHE.INVALIDATE">, options?: InferCallOptions): Promise<NodeResult<InferOutput<"INFER.CACHE.INVALIDATE">>>;
  };
}
const handlers: { [N in InferNode]: (input: InferInput<N>, ctx: InferExecution) => Promise<InferOutput<N>> } = {
  "INFER.REASONING.SAMPLE": sampleNode,
  "INFER.REASONING.TRAJECTORY": trajectoryNode,
  "INFER.REASONING.REFLECT": reflectNode,
  "INFER.REASONING.DELIBERATE": deliberateNode,
  "INFER.CACHE.LOOKUP": lookupNode,
  "INFER.CACHE.WRITE": writeNode,
  "INFER.CACHE.INVALIDATE": invalidateNode,
};
/** One executor per SDK/replica; invocation context is always passed per call. */
export function createBfclSampleExecutor(options: InferOptions) {
  const defaults = options.defaults === undefined ? undefined : validateRuntimeSettings({ workers: { infer: options.defaults } }).workers!.infer;
  const providers = options.providers instanceof ProviderRegistry ? options.providers : options.providers ? new ProviderRegistry(options.providers) : undefined;
  const fallbackProviders = new ProviderRegistry();
  const strategies = Object.freeze({ ...options.strategies });
  const cache = options.cache ?? new InMemoryInferCache();
  const timeoutMs = options.timeoutMs ?? options.runtime?.services.config.timeoutMs ?? 30_000; number(timeoutMs, "timeoutMs", 1, 2 ** 31 - 1, true);
  return async (node: string, input: unknown, call: InferCallOptions = {}, emit?: (event: InferStreamEvent<unknown>) => void, services = options.runtime?.services): Promise<NodeResult<unknown>> => {
    const executionId = randomUUID(); let timer: ReturnType<typeof setTimeout> | undefined;
    let signal: AbortSignal | undefined;
    const base = { executionId, node };
    try {
      emit?.({ type: "start", ...base });
      const inferDefaults = defaults ?? services?.config.infer;
      let deadline = call.timeoutMs ?? options.timeoutMs ?? services?.config.timeoutMs ?? timeoutMs; number(deadline, "timeoutMs", 1, 2 ** 31 - 1, true);
      if (node === "INFER.REASONING.TRAJECTORY") {
        const constraints = input && typeof input === "object" && "constraints" in input ? input.constraints : undefined;
        const requested = constraints && typeof constraints === "object" && "timeoutMs" in constraints ? constraints.timeoutMs : undefined;
        const limit = requested ?? inferDefaults?.constraints?.timeoutMs;
        if (limit !== undefined) { number(limit, "constraints.timeoutMs", 1, 2 ** 31 - 1, true); deadline = Math.min(deadline, limit); }
      }
      const controller = new AbortController(); timer = setTimeout(() => controller.abort(new DOMException("INFER deadline exceeded", "TimeoutError")), deadline);
      signal = call.signal ? AbortSignal.any([call.signal, controller.signal]) : controller.signal;
      signal.throwIfAborted();
      const defaultProvider = options.defaultProvider ?? services?.config.model?.provider;
      const ctx: InferExecution = {
        ...(inferDefaults ? { defaults: inferDefaults } : {}),
        signal, providers: providers ?? services?.providers ?? fallbackProviders, strategies, cache, streaming: Boolean(emit),
        ...(defaultProvider !== undefined ? { defaultProvider } : {}),
        emitDelta: delta => { if (!signal!.aborted) emit?.({ type: "text_delta", ...base, delta }); },
        emitStep: step => { if (!signal!.aborted) emit?.({ type: "step", ...base, step }); },
        sample: value => sampleNode(value, ctx),
      };
      if (!Object.hasOwn(handlers, node)) throw new InferError("UNKNOWN_NODE", `Unknown INFER node: ${node}`);
      const handler = handlers[node as InferNode] as (value: unknown, context: InferExecution) => Promise<unknown>;
      const output = await handler(input, ctx);
      return { ...base, status: "success", output };
    } catch (error) {
      const info = signal?.aborted ? { code: signal.reason instanceof Error && signal.reason.name === "TimeoutError" ? "TIMEOUT" : "CANCELLED", message: signal.reason instanceof Error ? signal.reason.message : "Execution cancelled" } : errorInfo(error);
      return { ...base, status: info.code === "TIMEOUT" ? "timeout" : info.code === "CANCELLED" ? "cancelled" : "failed", error: info,
        ...(error instanceof TrajectoryFailure ? { output: error.output } : {}) };
    } finally { clearTimeout(timer); }
  };
}
