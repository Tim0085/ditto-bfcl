import { type RedisContextClient, type RedisContextOptions } from "./redis.js";
import { type WorkerDefinition } from "../define-worker.js";
import type { ContextInput, ContextNode, ContextOutput } from "./contracts.js";
import type { ContextPolicy, ContextServices, ContextCallOptions } from "./types.js";
export interface ContextOptions {
    readonly policy?: Partial<ContextPolicy>;
    /** Default cache adapter when a Redis SDK client is supplied. */
    readonly redis?: {
        readonly client: RedisContextClient;
    } & RedisContextOptions;
    readonly services?: ContextServices;
}
export interface ContextClient {
    execute<N extends ContextNode>(node: N, input: ContextInput<N>, call?: ContextCallOptions): Promise<ContextOutput<N>>;
    load(input: ContextInput<"CONTEXT.LOAD">, call?: ContextCallOptions): Promise<ContextOutput<"CONTEXT.LOAD">>;
    select(input: ContextInput<"CONTEXT.SELECT">, call?: ContextCallOptions): Promise<ContextOutput<"CONTEXT.SELECT">>;
    update(input: ContextInput<"CONTEXT.UPDATE">, call?: ContextCallOptions): Promise<ContextOutput<"CONTEXT.UPDATE">>;
    compress(input: ContextInput<"CONTEXT.COMPRESS">, call?: ContextCallOptions): Promise<ContextOutput<"CONTEXT.COMPRESS">>;
}
/** The direct SDK and Runtime Worker share the same validated leaf handlers. */
export declare function createContext(options?: ContextOptions): ContextClient;
export interface ContextWorkerOptions extends ContextOptions {
    /** Creates isolated resources for each local replica when supplied. */
    readonly servicesFactory?: () => ContextServices;
    readonly concurrency?: number;
}
export declare function createContextWorker(options?: ContextWorkerOptions): WorkerDefinition;
//# sourceMappingURL=worker.d.ts.map