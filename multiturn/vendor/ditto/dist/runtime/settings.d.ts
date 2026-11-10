import type { ContextPolicy } from "../worker/context/types.js";
import type { MemoryDefaults } from "../worker/memory/types.js";
import type { GenerationConfig } from "../worker/infer/types.js";
import type { DeliberationMode } from "../worker/infer/reasoning/deliberate/types.js";
import type { TrajectoryInput } from "../worker/infer/reasoning/trajectory/types.js";
export interface InferSettings {
    readonly generation?: GenerationConfig;
    readonly deliberate?: {
        readonly mode?: DeliberationMode;
        readonly selectCount?: number;
        readonly generation?: GenerationConfig;
    };
    readonly constraints?: TrajectoryInput["constraints"];
    readonly strategies?: {
        readonly cot?: {
            readonly rounds?: number;
        };
        readonly "long-cot"?: {
            readonly rounds?: number;
        };
        readonly tot?: {
            readonly breadth?: number;
            readonly depth?: number;
            readonly beamWidth?: number;
        };
        readonly got?: {
            readonly breadth?: number;
            readonly depth?: number;
        };
        readonly "self-consistency"?: {
            readonly candidates?: number;
        };
    };
}
/** Non-secret application defaults. Credentials and deployment bindings belong in env. */
export interface RuntimeSettings {
    readonly runtime?: {
        readonly sandbox?: {
            readonly timeoutMs?: number;
            readonly maxOutputBytes?: number;
        };
        readonly timeoutMs?: number;
        readonly maxTurns?: number;
        readonly graphConcurrency?: number;
        readonly loopMaxIterations?: number;
        readonly react?: {
            readonly maxActionCalls?: number;
            readonly maxTotalTokens?: number;
        };
    };
    readonly workers?: {
        readonly infer?: InferSettings;
        readonly context?: {
            readonly policy?: Partial<ContextPolicy>;
            readonly cache?: {
                readonly ttlMs?: number;
                readonly keyPrefix?: string;
            };
            readonly localCache?: {
                readonly ttlMs?: number;
                readonly maxEntries?: number;
            };
            readonly queue?: {
                readonly maxPending?: number;
            };
        };
        readonly interaction?: {
            readonly commands?: {
                readonly maxEntries?: number;
                readonly maxOutputBytes?: number;
                readonly maxErrorBytes?: number;
            };
            readonly webSearch?: {
                readonly timeoutMs?: number;
                readonly maxResponseBytes?: number;
            };
        };
        readonly memory?: MemoryDefaults;
        readonly retrieval?: {
            readonly searchLimit?: number;
            readonly embedding?: {
                readonly batchSize?: number;
                readonly dimensions?: number;
            };
            readonly hybrid?: {
                readonly candidateLimit?: number;
                readonly rrfK?: number;
            };
            readonly rerank?: {
                readonly candidateLimit?: number;
            };
        };
    };
    readonly shared?: {
        readonly providers?: Readonly<Record<string, {
            readonly maxTokensField?: "max_tokens" | "max_completion_tokens";
            readonly options?: Readonly<Record<string, unknown>>;
        }>>;
    };
}
/** Snapshot once at startup; callers cannot mutate nested defaults during concurrent requests. */
export declare function validateRuntimeSettings(value: unknown): RuntimeSettings;
//# sourceMappingURL=settings.d.ts.map