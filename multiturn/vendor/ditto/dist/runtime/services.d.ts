/**
 * Explicit host config wins; otherwise load ./ditto.yaml with process.env once
 * per Runtime. A missing default file uses env + built-ins; invalid files fail.
 * Importing the package does not read files. .env loading stays with the application.
 * Host providers/sandbox options override the corresponding config-derived services.
 */
import { ProviderRegistry } from "../worker/infer/providers/index.js";
import { Sandbox, type SandboxExecutor, type SandboxPolicy } from "./sandbox/index.js";
import { type RuntimeConfig } from "./config.js";
export interface RuntimeServiceOptions {
    /** Overrides automatic ./ditto.yaml + process.env loading completely. */
    readonly config?: RuntimeConfig;
    readonly providers?: ProviderRegistry;
    readonly sandbox?: SandboxPolicy;
    readonly sandboxExecutor?: SandboxExecutor;
}
export interface RuntimeServices {
    readonly config: RuntimeConfig;
    readonly providers: ProviderRegistry;
    readonly sandbox: Sandbox;
}
export declare function createRuntimeServices(options: RuntimeServiceOptions): RuntimeServices;
//# sourceMappingURL=services.d.ts.map