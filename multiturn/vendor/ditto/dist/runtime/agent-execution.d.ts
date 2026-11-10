import type { JsonValue } from "../contracts/common.js";
import type { LoopRunOptions } from "./runtime.js";
import { type AsyncGraphPlan, type GraphPlan } from "./graph-plan.js";
import type { ExecutionGraph } from "./graph.js";
import { type GraphCheckpoint, type StateCheckpoint } from "./checkpoint.js";
export interface AgentCheckpointState {
    readonly definitionHash: string;
    readonly inputHash: string;
    /** Number of completed Graph steps; never reset by resume. */
    readonly iteration: number;
    readonly step: string;
    readonly state: Readonly<Record<string, unknown>>;
    readonly result: unknown;
    readonly phase: "ready" | "running" | "boundary" | "completed";
    readonly termination?: string;
    readonly graphCheckpoint?: GraphCheckpoint;
}
export type AgentCheckpoint = StateCheckpoint<AgentCheckpointState>;
export interface AgentCheckpointOptions {
    /** Stable execution ID. The host must enforce one writer (lease or CAS). */
    readonly id: string;
    /** Worker implementations and resource versions not represented in agent.json. */
    readonly version: string;
    readonly resume?: AgentCheckpoint;
    /** Must durably replace the latest checkpoint before resolving. Failure stops execution. */
    readonly save: (checkpoint: AgentCheckpoint) => void | Promise<void>;
}
export interface AgentBoundary {
    /** Stable across retries of this boundary; use for idempotent inbox decisions. */
    readonly id: string;
    readonly iteration: number;
    readonly step: string;
    readonly state: Readonly<Record<string, JsonValue>>;
    readonly result: JsonValue;
}
export interface AgentBoundaryDecision {
    /** Shallow state patch, applied after assign and before transition selection. */
    readonly update?: Readonly<Record<string, JsonValue>>;
    readonly pause?: boolean;
}
export interface AgentRunOptions extends Omit<LoopRunOptions, "checkpoint" | "stateCheckpoint"> {
    readonly stateCheckpoint?: AgentCheckpointOptions;
    /** Awaited after each Graph and assign. A failed hook is retried on resume with the same ID. */
    readonly onBoundary?: (boundary: AgentBoundary) => void | AgentBoundaryDecision | Promise<void | AgentBoundaryDecision>;
}
export declare class AgentPausedError extends Error {
    readonly checkpoint: AgentCheckpoint;
    readonly code = "AGENT_PAUSED";
    constructor(checkpoint: AgentCheckpoint);
}
/** Compiler-owned pure operations, shared by the public plan and durable executor. */
export interface AgentProgram {
    readonly entry: string;
    readonly maxIterations: number;
    initial(input: unknown): Readonly<Record<string, unknown>>;
    done(input: unknown, state: Readonly<Record<string, unknown>>): boolean;
    graph(step: string): string;
    input(step: string, input: unknown, state: Readonly<Record<string, unknown>>): unknown;
    assign(step: string, input: unknown, state: Readonly<Record<string, unknown>>, result: unknown): Readonly<Record<string, unknown>>;
    next(step: string, input: unknown, state: Readonly<Record<string, unknown>>, result: unknown): {
        next?: string;
        end?: string;
    };
    output(input: unknown, frame: AgentCheckpointState): unknown;
}
type Graphs = Readonly<Record<string, ExecutionGraph<unknown, Record<string, unknown>>>>;
type Project = (graph: string, input: unknown, output: unknown) => unknown;
export declare function agentPlan(program: AgentProgram, graphs: Graphs, project: Project, input: unknown): GraphPlan<unknown>;
export declare function executeAgent(program: AgentProgram, graphs: Graphs, project: Project, definitionHash: string, input: unknown, options: AgentRunOptions): AsyncGraphPlan<unknown>;
export {};
//# sourceMappingURL=agent-execution.d.ts.map