import { type InferSettings } from "../../runtime/settings.js";
import { type WorkerDefinition } from "../define-worker.js";
import type { InferCallOptions, InferStreamEvent, NodeResult } from "./types.js";
import type { InferNode, InferInput, InferOutput } from "./contracts.js";
import type { ModelProvider } from "./providers/types.js";
import { ProviderRegistry } from "./providers/registry.js";
import type { RuntimeServices } from "../../runtime/services.js";
import { type InferCacheProvider } from "./cache/provider.js";
import type { TrajectoryStrategy } from "./reasoning/trajectory/strategies/index.js";
export interface InferOptions {
    /** Explicit defaults replace Runtime infer defaults; snapshotted at creation. */
    defaults?: InferSettings;
    providers?: ProviderRegistry | Readonly<Record<string, ModelProvider>>;
    defaultProvider?: string;
    /** Omit for an isolated in-memory cache; supply a shared backend for multiple replicas. */
    cache?: InferCacheProvider;
    strategies?: Readonly<Record<string, TrajectoryStrategy>>;
    runtime?: {
        readonly services: RuntimeServices;
    };
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
/** Same leaf handlers power direct SDK calls, local Runtime dispatch, and remote Runtime dispatch. */
export declare function createInfer(options?: InferOptions): InferClient;
export interface InferWorkerOptions extends Omit<InferOptions, "runtime" | "cache"> {
    cache?: InferCacheProvider;
    cacheFactory?: () => InferCacheProvider;
    concurrency?: number;
}
export declare function createInferWorker(options?: InferWorkerOptions): WorkerDefinition;
//# sourceMappingURL=worker.d.ts.map