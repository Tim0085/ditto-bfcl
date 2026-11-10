import type { ContextOperationQueue, ContextStateStore } from "./types.js";
export interface InMemoryContextOptions {
    readonly ttlMs?: number;
    readonly maxEntries?: number;
    readonly now?: () => number;
}
/** Bounded, process-local LRU cache. CAS is atomic within this JavaScript isolate. */
export declare function createInMemoryContextStore(options?: InMemoryContextOptions): ContextStateStore;
/** Serialize one scope without blocking other scopes; failed jobs never poison the queue. */
export declare function createContextOperationQueue(options?: {
    readonly maxPending?: number;
}): ContextOperationQueue;
//# sourceMappingURL=local-state.d.ts.map