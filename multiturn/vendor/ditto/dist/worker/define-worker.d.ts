import type { NodeDefinition, NodeHandler, WorkerContext, WorkerType } from "./node.js";
import type { NodeType } from "../contracts/index.js";
export type WorkerNodes<R = undefined, C = undefined> = {
    readonly [N in NodeType]?: NodeHandler<N, R, C> | NodeDefinition<N, R, C>;
};
/** Short operation names for a single semantic namespace, including augmentation. */
type OperationOf<N extends string, T extends string> = N extends `${T}.${infer Op}` ? Op : never;
export type ScopedWorkerNodes<T extends string, R = undefined, C = undefined> = {
    readonly [Op in OperationOf<NodeType, T>]?: NodeHandler<Extract<NodeType, `${T}.${Op}`>, R, C> | NodeDefinition<Extract<NodeType, `${T}.${Op}`>, R, C>;
};
export type ScopedWorkerOptions<T extends string, R = undefined, C = undefined> = Omit<WorkerOptions<R, C>, "type" | "nodes"> & {
    readonly nodes: ScopedWorkerNodes<T, R, C>;
};
/** Add operations in a namespace; existing Worker definitions are not mutated. */
export declare function extendWorker<const T extends string, R = undefined, C = undefined>(type: T, options: ScopedWorkerOptions<T, R, C>): WorkerDefinition;
export type WorkerOptions<R = undefined, C = undefined> = {
    readonly type: WorkerType;
    /** Called once per local registration, so replicas need not share resources. */
    readonly resources?: () => R;
    readonly config?: C;
    /** Maximum concurrent top-level invocations per replica (default: unlimited). */
    readonly concurrency?: number;
    readonly dispose?: (resources: R) => void | Promise<void>;
    /** Public entry Nodes. Omit to expose all; internal Graphs can use every Node. */
    readonly expose?: readonly NodeType[];
    readonly nodes: WorkerNodes<R, C>;
} & ([R] extends [undefined] ? unknown : {
    readonly resources: () => R;
}) & ([C] extends [undefined] ? unknown : {
    readonly config: C;
});
/** Internal host dispatch boundary. Public callers use typed Runtime.invoke. */
export interface WorkerExecutor {
    execute(node: NodeType, input: unknown, services: WorkerContext): Promise<unknown>;
    dispose?(): void | Promise<void>;
}
export interface WorkerDefinition {
    readonly type: WorkerType;
    readonly capabilities: readonly NodeType[];
    readonly nodeTypes?: readonly NodeType[];
    readonly concurrency?: number;
    instantiate(): WorkerExecutor;
}
export declare function defineWorker<R = undefined, C = undefined>(options: WorkerOptions<R, C>): WorkerDefinition;
export {};
//# sourceMappingURL=define-worker.d.ts.map