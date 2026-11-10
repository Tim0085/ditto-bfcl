import type { MemoryCallOptions } from "../types.js";
import type { MemoryResources } from "../providers/store.js";
import type { MemoryWriteInput, MemoryWriteOutput } from "./types.js";
export declare function writeNode(input: MemoryWriteInput, resources: MemoryResources, options?: MemoryCallOptions): Promise<MemoryWriteOutput>;
export declare const memoryWriteNode: import("../../node-scaffold.js").NodeScaffold<"MEMORY.WRITE">;
//# sourceMappingURL=node.d.ts.map