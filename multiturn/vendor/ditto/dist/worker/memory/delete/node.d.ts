import type { MemoryCallOptions } from "../types.js";
import type { MemoryResources } from "../providers/store.js";
import type { MemoryDeleteInput, MemoryDeleteOutput } from "./types.js";
export declare function deleteNode(input: MemoryDeleteInput, resources: MemoryResources, options?: MemoryCallOptions): Promise<MemoryDeleteOutput>;
export declare const memoryDeleteNode: import("../../node-scaffold.js").NodeScaffold<"MEMORY.DELETE">;
//# sourceMappingURL=node.d.ts.map