/** Portable checkpoints contain explicit JSON state, never closures or live resources. */
export interface StateCheckpoint<T> {
    readonly format: 1;
    readonly scope: string;
    readonly version: string;
    readonly state: T;
    readonly digest: string;
}
export declare function stateDigest(value: unknown): string;
export declare function checkpointState<T>(scope: string, version: string, state: T): StateCheckpoint<T>;
export declare function restoreState<T>(checkpoint: StateCheckpoint<T>, scope: string, version: string): T;
export interface GraphCheckpointState {
    readonly graphHash: string;
    readonly inputHash: string;
    readonly outputs: Readonly<Record<string, unknown>>;
    /** Persisted before dispatch; unresolved operations may have effects and cannot replay. */
    readonly uncertain: readonly string[];
}
export type GraphCheckpoint = StateCheckpoint<GraphCheckpointState>;
export interface GraphCheckpointOptions {
    /** Include application configuration and resource snapshot versions in this value. */
    readonly version: string;
    readonly resume?: GraphCheckpoint;
    /** Awaited at a quiescent boundary, before more Nodes are admitted. */
    readonly save: (checkpoint: GraphCheckpoint) => void | Promise<void>;
}
export declare class UncertainGraphCheckpointError extends Error {
    readonly checkpoint: GraphCheckpoint;
    readonly code = "UNCERTAIN_GRAPH_OPERATIONS";
    constructor(checkpoint: GraphCheckpoint);
}
/** Host-only reconciliation after checking external effects. Never retries implicitly. */
export declare function reconcileGraphCheckpoint(checkpoint: GraphCheckpoint, resolutions: Readonly<Record<string, {
    readonly output: unknown;
} | {
    readonly retry: true;
}>>): GraphCheckpoint;
export interface LoopCheckpointState {
    readonly iteration: number;
    readonly state: unknown;
    readonly completed: boolean;
}
export interface LoopCheckpointOptions {
    readonly id: string;
    readonly version: string;
    readonly resume?: StateCheckpoint<LoopCheckpointState>;
    readonly save: (checkpoint: StateCheckpoint<LoopCheckpointState>) => void | Promise<void>;
}
//# sourceMappingURL=checkpoint.d.ts.map