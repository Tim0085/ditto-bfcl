import type { InputOf, NodeType, OutputOf } from "../contracts/index.js";
import type { RuntimeClient } from "../worker/node.js";
import type { WorkerDefinition } from "../worker/define-worker.js";
import { type ArtifactStore } from "./artifact.js";
import { type EventFabric, type EventHandler, type RuntimeEvent } from "./communication/events.js";
import { type ExecutionGraph, type GraphRunOptions } from "./graph.js";
import { type LoopPlanDefinition, type AsyncLoopPlanDefinition, type LoopGraphEvent } from "./graph-plan.js";
import { type LoopDefinition } from "./loop.js";
import type { LoopCheckpointOptions } from "./checkpoint.js";
import { type RuntimeServices, type RuntimeServiceOptions } from "./services.js";
import type { InvocationEnvelope, InvocationResult, InvokeOptions, InvokeTransport, RemoteWorker, WorkerAddress } from "./communication/transport.js";
export interface DittoOptions extends RuntimeServiceOptions {
    readonly workers?: readonly WorkerDefinition[];
    readonly hostId?: string;
    readonly processId?: string;
    readonly transports?: readonly InvokeTransport[];
    readonly events?: EventFabric;
    readonly artifacts?: ArtifactStore;
    readonly inlineLimitBytes?: number;
}
/** Deployment choices belong to execution, not to a reusable graph. */
export interface RunOptions extends GraphRunOptions {
    readonly workers?: Readonly<Record<string, string>>;
}
export interface LoopRunOptions extends GraphRunOptions {
    readonly stateCheckpoint?: LoopCheckpointOptions;
    readonly onGraph?: (event: LoopGraphEvent) => void;
    readonly workers?: Readonly<Record<string, Readonly<Record<string, string>>>>;
}
export interface WorkerRegistrationOptions {
    readonly id?: string;
    /** Omit to share Runtime services; inject a separate instance for isolation. */
    readonly services?: RuntimeServices;
}
export interface WorkerHandle {
    readonly address: WorkerAddress;
    setAvailable(available: boolean): void;
    unregister(): boolean;
    /** Stop routing, drain accepted invocations, then dispose resources once. */
    close(): Promise<void>;
}
export declare class DittoRuntime implements RuntimeClient {
    #private;
    readonly hostId: string;
    readonly processId: string;
    readonly services: RuntimeServices;
    constructor(options?: DittoOptions);
    register(worker: WorkerDefinition, options?: string | WorkerRegistrationOptions): WorkerHandle;
    registerRemote(worker: RemoteWorker): WorkerHandle;
    workers(): readonly {
        address: WorkerAddress;
        capabilities: readonly NodeType[];
        available: boolean;
        active: number;
        concurrency: number;
    }[];
    invoke<N extends NodeType>(node: N, input: InputOf<NoInfer<N>>, options?: InvokeOptions): Promise<OutputOf<N>>;
    emit<T>(event: RuntimeEvent<T>): Promise<void>;
    subscribe(type: string, handler: EventHandler): () => boolean;
    /** Wait for accepted events, returning consumer failures separately from emit. */
    drainEvents(): ReturnType<EventFabric["drain"]>;
    graph<I>(id?: string): ExecutionGraph<I>;
    run<I, O extends object>(plan: ExecutionGraph<I, O>, input: NoInfer<I>, options?: RunOptions): Promise<O>;
    loop<I, R>(definition: LoopPlanDefinition<I, R> | AsyncLoopPlanDefinition<I, R>, input: NoInfer<I>, options?: LoopRunOptions): Promise<R>;
    loop<S, I, O extends object>(definition: LoopDefinition<S, I, O>, initialState: NoInfer<S>, options?: LoopRunOptions): Promise<S>;
    /** Adapter-facing receiver. This is not an unauthenticated network server. */
    receive(envelope: InvocationEnvelope): Promise<InvocationResult>;
    close(): Promise<void>;
}
export declare function createDitto(options?: DittoOptions): DittoRuntime;
//# sourceMappingURL=runtime.d.ts.map