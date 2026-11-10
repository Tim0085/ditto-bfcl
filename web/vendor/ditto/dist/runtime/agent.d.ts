/**
 * agent.json defines structure and application parameters. createAgent() defaults
 * to ./ditto.yaml + process.env through Runtime; explicit options.config wins.
 * compileAgent() stays pure and does not read configuration files.
 * definition.config is only expression data, separate from Runtime config.
 * With loop, maxIterations is required and overrides the Runtime fallback;
 * without loop, main runs once. run(input, { concurrency }) overrides the Runtime default.
 * Node inputs override supported Worker defaults, never host permission grants.
 */
import type { JsonValue } from "../contracts/index.js";
import type { WorkerDefinition } from "../worker/define-worker.js";
import { ExecutionGraph } from "./graph.js";
import type { LoopPlanDefinition } from "./graph-plan.js";
import { type DittoOptions, type DittoRuntime, type RunOptions, type WorkerRegistrationOptions } from "./runtime.js";
import { type AgentDiagnostic, type AgentNodeSource } from "./agent-diagnostics.js";
import { type AgentRunOptions } from "./agent-execution.js";
/** JSON expressions: literals, {$ref, default?}, {$op, args}, {$map:{items,value}}, {$literal}. */
export type AgentExpression = JsonValue;
export interface AgentNode {
    readonly id: string;
    readonly kind?: "node";
    readonly type: string;
    readonly dependsOn?: readonly string[];
    readonly input: AgentExpression;
    readonly require?: {
        readonly path: string;
        readonly equals: JsonValue;
    };
}
export interface AgentSubgraph {
    readonly id: string;
    readonly kind: "subgraph";
    readonly graph: string;
    readonly dependsOn?: readonly string[];
    readonly input: AgentExpression;
}
export interface AgentGraph {
    readonly nodes: readonly (AgentNode | AgentSubgraph)[];
    readonly output?: AgentExpression;
}
export interface AgentTransition {
    readonly when?: AgentExpression;
    readonly next?: string;
    readonly end?: string;
}
export interface AgentLoopStep {
    readonly graph: string;
    readonly input: AgentExpression;
    readonly assign?: Readonly<Record<string, AgentExpression>>;
    readonly transitions: readonly AgentTransition[];
}
export interface AgentLoop {
    readonly entry: string;
    readonly maxIterations: number;
    readonly state: AgentExpression;
    /** Checked before each Graph. False permits zero iterations. */
    readonly while?: AgentExpression;
    readonly steps: Readonly<Record<string, AgentLoopStep>>;
    readonly output?: AgentExpression;
}
export interface AgentDefinition {
    readonly $schema?: string;
    readonly version: 1;
    readonly id: string;
    readonly graphs: Readonly<Record<string, AgentGraph>>;
    /** Without a Loop, execute main once. */
    readonly entry?: "main";
    readonly loop?: AgentLoop;
    /** Non-secret values available to expressions as config.*. */
    readonly config?: JsonValue;
    readonly deployment?: AgentDeployment;
}
export interface AgentDeployment {
    /** Aliases into a trusted host registry, not import paths or factories. */
    readonly workers?: readonly {
        readonly id: string;
        readonly use: string;
        readonly services?: string;
    }[];
    /** Graph ID -> expanded leaf ID (e.g. research/search) -> Worker instance ID. */
    readonly bindings?: Readonly<Record<string, Readonly<Record<string, string>>>>;
}
export interface AgentWorker {
    readonly definition: WorkerDefinition;
    readonly services?: WorkerRegistrationOptions["services"];
}
export interface CreateAgentOptions extends Omit<DittoOptions, "workers"> {
    readonly workers: Readonly<Record<string, WorkerDefinition | AgentWorker>>;
    /** Only these host-authorized resource/permission profiles can be selected by JSON. */
    readonly serviceProfiles?: Readonly<Record<string, NonNullable<WorkerRegistrationOptions["services"]>>>;
}
export interface CompiledAgent {
    readonly definition: AgentDefinition;
    readonly graphs: Readonly<Record<string, ExecutionGraph<unknown, Record<string, unknown>>>>;
    readonly sourceMap: Readonly<Record<string, Readonly<Record<string, AgentNodeSource>>>>;
    readonly plan: LoopPlanDefinition<unknown, unknown>;
    runGraph(name: string, runtime: DittoRuntime, input: unknown, options?: RunOptions): Promise<unknown>;
    /** Preflight every graph and binding before starting any work. Runtime remains host-owned. */
    run(runtime: DittoRuntime, input: unknown, options?: AgentRunOptions): Promise<unknown>;
}
export interface ConfiguredAgent {
    readonly compiled: CompiledAgent;
    readonly runtime: DittoRuntime;
    run(input: unknown, options?: Omit<AgentRunOptions, "workers">): Promise<unknown>;
    close(): Promise<void>;
}
/** Compile JSON into the existing DAG scheduler and one outer Loop, without eval or SDK calls. */
export declare function compileAgent(source: unknown): CompiledAgent;
/** Pure compiler validation; returns the first actionable error. Worker preflight happens at execution. */
export declare function validateAgent(source: unknown): readonly AgentDiagnostic[];
/** Register trusted definitions separately from JSON structure. Owns and closes its Runtime. */
export declare function createAgent(source: unknown, options: CreateAgentOptions): Promise<ConfiguredAgent>;
//# sourceMappingURL=agent.d.ts.map