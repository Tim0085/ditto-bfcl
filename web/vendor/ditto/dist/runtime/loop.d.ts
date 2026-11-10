import type { LoopPlanDefinition } from "./graph-plan.js";
import type { ExecutionGraph } from "./graph.js";
import { type LoopCheckpointOptions } from "./checkpoint.js";
/** Each iteration executes one selected DAG; the application owns state and termination. */
export interface LoopDefinition<S, I, O extends object> {
    /** A fixed Graph, or a selector choosing one candidate Graph from current state. */
    readonly graph: ExecutionGraph<I, O> | ((state: S) => ExecutionGraph<I, O>);
    readonly maxIterations?: number;
    readonly bind: (state: S) => I;
    readonly update: (state: S, output: O) => S;
    readonly done: (state: S, output: O) => boolean;
}
export declare function loop<I, R>(definition: LoopPlanDefinition<I, R>): LoopPlanDefinition<I, R>;
export declare function loop<S, I, O extends object>(definition: LoopDefinition<S, I, O>): LoopDefinition<S, I, O>;
export declare function runLoop<S, I, O extends object>(definition: LoopDefinition<S, I, O>, initialState: NoInfer<S>, run: (graph: ExecutionGraph<I, O>, input: I) => Promise<O>, signal?: AbortSignal, checkpoint?: LoopCheckpointOptions): Promise<S>;
//# sourceMappingURL=loop.d.ts.map