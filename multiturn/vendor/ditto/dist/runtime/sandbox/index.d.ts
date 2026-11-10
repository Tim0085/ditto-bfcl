export type PermissionKind = "tools" | "mcp" | "skills" | "network";
export interface SandboxPolicy {
    readonly tools?: readonly string[];
    readonly mcp?: readonly string[];
    readonly skills?: readonly string[];
    /** Exact URL origins, e.g. https://api.openai.com. */
    readonly network?: readonly string[];
    readonly read?: boolean;
    readonly write?: boolean;
    readonly execute?: boolean;
}
export interface SandboxCommand {
    readonly command: string;
    readonly args: readonly string[];
}
/** Implement with a container/OS sandbox; never implicitly run a host shell. */
export interface SandboxExecutor {
    run(command: SandboxCommand, options: {
        workspace: string;
        signal?: AbortSignal;
    }): Promise<{
        stdout: string;
        stderr: string;
        exitCode: number;
    }>;
}
export declare class PermissionDeniedError extends Error {
    constructor(permission: string);
}
/** Cooperative capability guard, not an OS security boundary for arbitrary JS. */
export declare class Sandbox {
    #private;
    readonly executor?: SandboxExecutor | undefined;
    readonly policy: SandboxPolicy;
    readonly workspace: string;
    constructor(workspace: string, policy?: SandboxPolicy, executor?: SandboxExecutor | undefined);
    allows(kind: PermissionKind, name: string): boolean;
    assert(kind: PermissionKind, name: string): void;
    readText(path: string, signal?: AbortSignal): Promise<string>;
    writeText(path: string, content: string, signal?: AbortSignal): Promise<void>;
    run(command: SandboxCommand, signal?: AbortSignal): Promise<{
        stdout: string;
        stderr: string;
        exitCode: number;
    }>;
}
export { createLocalSandboxExecutor } from "./local.js";
export type { LocalSandboxExecutorOptions } from "./local.js";
//# sourceMappingURL=index.d.ts.map