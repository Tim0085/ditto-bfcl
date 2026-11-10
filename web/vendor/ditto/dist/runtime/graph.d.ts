import type { ExecutionScope } from "./communication/transport.js";
import type { InputOf, NodeType, OutputOf } from "../contracts/index.js";
import type { Context, ContextSource, JsonObject, Observation, MessageContent, Reference, ToolCall } from "../contracts/common.js";
import type { RuntimeClient } from "../worker/execution-context.js";
import type { ContextSelection } from "../worker/context/contracts.js";
import type { InteractionMcpInput, InteractionMcpOutput, InteractionToolOutput } from "../worker/interaction/contracts.js";
import { type GraphCheckpointOptions } from "./checkpoint.js";
export interface GraphTask {
    readonly id: string;
    readonly node: NodeType;
    readonly dependencies: readonly string[];
    readonly bind: (input: unknown, outputs: Readonly<Record<string, unknown>>) => unknown;
    readonly validateOutput?: (output: unknown) => void;
}
/** Immutable logical DAG. No Worker IDs, model configuration or host addresses. */
export declare class ExecutionGraph<I, O extends object = Record<never, never>> {
    readonly id: string;
    readonly tasks: readonly GraphTask[];
    private constructor();
    static create<I>(id: string): ExecutionGraph<I>;
    /** Linear-time construction for validated dynamic compilers; handlers still validate payloads. */
    static fromTasks<I>(id: string, tasks: readonly GraphTask[]): ExecutionGraph<I, Record<string, unknown>>;
    node<const ID extends string, N extends NodeType, const D extends readonly (keyof O & string)[]>(id: ID, node: N, dependencies: D, bind: (input: I, outputs: Pick<O, D[number]>) => InputOf<NoInfer<N>>, validateOutput?: (output: OutputOf<N>) => void): ExecutionGraph<I, O & Record<ID, OutputOf<N>>>;
}
export declare function graph<I>(id?: string): ExecutionGraph<I>;
export interface GraphRunOptions {
    /** Maximum simultaneously running graph nodes. No hidden invocation queue. */
    readonly concurrency?: number;
    readonly signal?: AbortSignal;
    readonly checkpoint?: GraphCheckpointOptions;
}
export declare function runGraph<I, O extends object>(graph: ExecutionGraph<I, O>, input: I, invoke: (node: NodeType, input: unknown, scope: ExecutionScope) => Promise<unknown>, options?: GraphRunOptions): Promise<O>;
export interface RuntimeFlowResult<Output> {
    readonly output: Output;
    readonly context: Context;
}
export interface RagFlowInput {
    readonly context: Context;
    readonly query?: MessageContent;
    readonly corpus?: Reference;
    readonly limit?: number;
    readonly maxTokens?: number;
    readonly options?: JsonObject;
}
export interface SkillFlowInput {
    readonly context?: Context;
    /** Skill instructions/resources have already been resolved by the application or Runtime. */
    readonly sources: readonly ContextSource[];
}
export interface McpFlowInput {
    readonly context: Context;
    readonly request: InteractionMcpInput;
}
export interface InteractionFlowResult<Output> extends RuntimeFlowResult<Output> {
    readonly observation: Observation;
}
export interface ToolCallFlowInput {
    readonly context: Context;
    readonly call: ToolCall;
}
/** RAG is an internal CONTEXT.SELECT strategy, not a public Node namespace. */
export declare function runRagFlow(runtime: RuntimeClient, input: RagFlowInput): Promise<RuntimeFlowResult<ContextSelection>>;
export declare function runSkillFlow(runtime: RuntimeClient, input: SkillFlowInput): Promise<RuntimeFlowResult<Context>>;
export declare function runMcpFlow(runtime: RuntimeClient, input: McpFlowInput & {
    request: Extract<InteractionMcpInput, {
        operation: "discover";
    }>;
}): Promise<RuntimeFlowResult<Extract<InteractionMcpOutput, {
    operation: "discover";
}>>>;
export declare function runMcpFlow(runtime: RuntimeClient, input: McpFlowInput & {
    request: Extract<InteractionMcpInput, {
        operation: "invoke";
    }>;
}): Promise<InteractionFlowResult<Extract<InteractionMcpOutput, {
    operation: "invoke";
}>>>;
export declare function runMcpFlow(runtime: RuntimeClient, input: McpFlowInput): Promise<RuntimeFlowResult<InteractionMcpOutput> | InteractionFlowResult<InteractionMcpOutput>>;
export declare function runToolCallFlow(runtime: RuntimeClient, input: ToolCallFlowInput): Promise<InteractionFlowResult<InteractionToolOutput>>;
//# sourceMappingURL=graph.d.ts.map