import type { InputOf, NodeType, OutputOf } from "../contracts/index.js";
import type { WorkerContext } from "./execution-context.js";
export type { RuntimeClient, WorkerContext } from "./execution-context.js";
/** Deployment/resource boundary; intentionally independent from Node namespace. */
export type WorkerType = string;
export type NodeHandler<N extends NodeType, R = undefined, C = undefined> = (input: InputOf<N>, context: WorkerContext<R, C>) => Promise<OutputOf<N>>;
export interface NodeDefinition<N extends NodeType, R = undefined, C = undefined> {
    readonly workerType: WorkerType;
    readonly type: N;
    readonly execute: NodeHandler<N, R, C>;
}
export declare function defineNode<N extends NodeType, R = undefined, C = undefined>(workerType: WorkerType, type: N, execute: NodeHandler<NoInfer<N>, R, C>): NodeDefinition<N, R, C>;
//# sourceMappingURL=node.d.ts.map