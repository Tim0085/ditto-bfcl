import { type WorkerDefinition } from "../define-worker.js";
import type { NodeResult } from "../../contracts/node-result.js";
import type { MemoryResources } from "./providers/store.js";
import type { MemoryNode, MemoryInput, MemoryOutput } from "./contracts.js";
import type { MemoryDefaults, MemoryCallOptions } from "./types.js";
export interface MemoryOptions extends MemoryResources {
    readonly defaults?: MemoryDefaults;
    readonly concurrency?: number;
}
/** Application-owned plugins; no implicit backend or workflow construction. */
export declare function createMemory(options: MemoryOptions): {
    execute: <N extends MemoryNode>(node: N, input: MemoryInput<N>, defaults?: MemoryDefaults & MemoryCallOptions) => Promise<NodeResult<MemoryOutput<N>>>;
    get: (input: MemoryInput<"MEMORY.GET">, options?: MemoryCallOptions) => Promise<NodeResult<import("./contracts.js").MemoryGetOutput>>;
    query: (input: MemoryInput<"MEMORY.QUERY">, options?: MemoryCallOptions) => Promise<NodeResult<import("./contracts.js").MemoryQueryOutput>>;
    search: (input: MemoryInput<"MEMORY.SEARCH">, options?: MemoryCallOptions) => Promise<NodeResult<import("./contracts.js").MemorySearchOutput>>;
    write: (input: MemoryInput<"MEMORY.WRITE">, options?: MemoryCallOptions) => Promise<NodeResult<import("./contracts.js").MemoryWriteOutput>>;
    update: (input: MemoryInput<"MEMORY.UPDATE">, options?: MemoryCallOptions) => Promise<NodeResult<import("./contracts.js").MemoryUpdateOutput>>;
    delete: (input: MemoryInput<"MEMORY.DELETE">, options?: MemoryCallOptions) => Promise<NodeResult<import("./contracts.js").MemoryDeleteOutput>>;
};
export declare function createMemoryWorker(options: MemoryOptions): WorkerDefinition;
//# sourceMappingURL=worker.d.ts.map