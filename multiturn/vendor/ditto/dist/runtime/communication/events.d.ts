export interface RuntimeEvent<T = unknown> {
    readonly type: string;
    readonly payload: T;
}
export type EventHandler = (event: RuntimeEvent) => void | Promise<void>;
export interface EventFailure {
    readonly event: RuntimeEvent;
    readonly error: unknown;
}
/** Adapters may provide IPC or Pub/Sub; emit acknowledges acceptance only. */
export interface EventFabric {
    emit<T>(event: RuntimeEvent<T>): Promise<void>;
    subscribe(type: string, handler: EventHandler): () => boolean;
    drain(): Promise<readonly EventFailure[]>;
}
export declare class LocalEventFabric implements EventFabric {
    #private;
    emit<T>(event: RuntimeEvent<T>): Promise<void>;
    subscribe(type: string, handler: EventHandler): () => boolean;
    drain(): Promise<readonly EventFailure[]>;
}
//# sourceMappingURL=events.d.ts.map