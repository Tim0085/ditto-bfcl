import type { NodeType } from "../contracts/index.js";
import { type NodeDefinition, type NodeHandler, type WorkerType } from "./node.js";
/** Lightweight leaf scaffold: fixes identity and typing, but supplies no business behavior. */
export interface NodeScaffold<N extends NodeType> {
    readonly type: N;
    define<R = undefined, C = undefined>(workerType: WorkerType, execute: NodeHandler<N, R, C>): NodeDefinition<N, R, C>;
}
export declare function createNodeScaffold<const N extends NodeType>(type: N): NodeScaffold<N>;
//# sourceMappingURL=node-scaffold.d.ts.map