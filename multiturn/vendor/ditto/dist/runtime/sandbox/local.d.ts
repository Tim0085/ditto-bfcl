import type { SandboxExecutor } from "./index.js";
export interface LocalSandboxExecutorOptions {
    /** Exact executable names or absolute paths; no shell command strings. */
    readonly commands: readonly string[];
    readonly timeoutMs?: number;
    /** Combined stdout/stderr byte limit. */
    readonly maxOutputBytes?: number;
    /** Explicit environment additions; parent environment is not inherited. */
    readonly env?: Readonly<Record<string, string>>;
}
/** Explicit trusted host execution. Replace with an OS/container executor for isolation. */
export declare function createLocalSandboxExecutor(options: LocalSandboxExecutorOptions): SandboxExecutor;
//# sourceMappingURL=local.d.ts.map