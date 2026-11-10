import type { ExecutionGraph, GraphRunOptions } from "./graph.js";
/** A Loop plan can only yield Graph invocations; it cannot execute a Worker itself. */
export interface GraphInvocation {
    readonly kind: "graph";
    readonly graph: ExecutionGraph<unknown, object>;
    readonly input: unknown;
    readonly options: GraphRunOptions;
}
export type GraphPlan<R> = Generator<GraphInvocation, R, unknown>;
export type AsyncGraphPlan<R> = AsyncGenerator<GraphInvocation, R, unknown>;
export interface LoopPlanDefinition<I, R> {
    readonly id: string;
    readonly plan: (input: I) => GraphPlan<R>;
    /** Bounds Graph executions, including failed Graphs and repetitions. */
    readonly maxIterations?: number;
}
export interface AsyncLoopPlanDefinition<I, R> extends Omit<LoopPlanDefinition<I, R>, "plan"> {
    readonly plan: (input: I) => AsyncGraphPlan<R>;
}
export interface LoopGraphEvent {
    readonly loopId: string;
    readonly iteration: number;
    readonly graphId: string;
    readonly nodes: readonly string[];
    readonly status: "started" | "completed" | "failed";
}
/** Yield a typed Graph to its owning Loop; returned values resume the plan. */
export declare function graphStep<I, O extends object>(plan: ExecutionGraph<I, O>, input: NoInfer<I>, options?: GraphRunOptions): GraphPlan<O>;
export declare function runGraphPlan<I, R>(definition: LoopPlanDefinition<I, R> | AsyncLoopPlanDefinition<I, R>, input: I, run: (graph: ExecutionGraph<unknown, object>, input: unknown, options: GraphRunOptions) => Promise<object>, signal?: AbortSignal, onGraph?: (event: LoopGraphEvent) => void): Promise<R>;
//# sourceMappingURL=graph-plan.d.ts.map