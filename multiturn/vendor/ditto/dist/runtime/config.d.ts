import { type RuntimeSettings, type InferSettings } from "./settings.js";
export type { RuntimeSettings, InferSettings } from "./settings.js";
import type { SandboxPolicy } from "./sandbox/index.js";
export interface ModelSelection {
    readonly provider: string;
    readonly model: string;
}
export interface ProviderConfig {
    readonly kind: "openai-compatible" | "anthropic" | "gemini";
    readonly baseUrl: string;
    readonly apiKey?: string;
    /** Optional per-provider model selection for application/Worker configuration. */
    readonly model?: string;
    readonly maxTokensField?: "max_tokens" | "max_completion_tokens";
    readonly providerOptions?: Readonly<Record<string, unknown>>;
}
export interface RuntimeConfig {
    readonly environment: "development" | "test" | "production";
    readonly workspace: string;
    readonly model: ModelSelection | undefined;
    readonly providers: Readonly<Record<string, ProviderConfig>>;
    readonly timeoutMs: number;
    readonly maxTurns: number;
    readonly graphConcurrency: number;
    readonly loopMaxIterations: number;
    readonly infer: InferSettings;
    readonly context: NonNullable<NonNullable<RuntimeSettings["workers"]>["context"]>;
    readonly interaction: NonNullable<NonNullable<RuntimeSettings["workers"]>["interaction"]>;
    readonly memory: NonNullable<NonNullable<RuntimeSettings["workers"]>["memory"]>;
    readonly retrieval: NonNullable<NonNullable<RuntimeSettings["workers"]>["retrieval"]>;
    readonly react: NonNullable<NonNullable<RuntimeSettings["runtime"]>["react"]>;
    readonly sandbox: SandboxPolicy;
    readonly sandboxExecution: NonNullable<NonNullable<RuntimeSettings["runtime"]>["sandbox"]>;
}
/** Explicit env parsing: importing the library never loads files or changes process.env. */
export declare function loadRuntimeConfig(env?: NodeJS.ProcessEnv, settings?: RuntimeSettings): RuntimeConfig;
/** Explicit file loading; .env is loaded by the application/Node --env-file, never by this function. */
export declare function loadRuntimeConfigFile(path?: string, env?: NodeJS.ProcessEnv): RuntimeConfig;
//# sourceMappingURL=config.d.ts.map