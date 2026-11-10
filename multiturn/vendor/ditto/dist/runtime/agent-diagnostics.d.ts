export interface AgentDiagnostic {
    readonly code: string;
    /** RFC 6901 JSON Pointer into the configuration; empty string means the root. */
    readonly path: string;
    readonly message: string;
    readonly graphId?: string;
    readonly nodeId?: string;
}
export declare class AgentValidationError extends Error {
    readonly diagnostic: AgentDiagnostic;
    constructor(path: string, message: string, code?: string);
}
export interface AgentNodeSource {
    readonly graphId: string;
    readonly nodeId: string;
    readonly path: string;
    /** Expanded invocation path, including this leaf. Distinguishes reused Subgraphs. */
    readonly invocationPath: readonly string[];
}
export declare function pointer(base: string, key: string | number): string;
//# sourceMappingURL=agent-diagnostics.d.ts.map