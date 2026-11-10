import type { MemoryCallOptions } from "../types.js";
import type { MemoryResources } from "../providers/store.js";
import type { MemorySearchInput, MemorySearchOutput } from "./types.js";
export declare function searchNode(input: MemorySearchInput, resources: MemoryResources, options?: MemoryCallOptions): Promise<MemorySearchOutput>;
export declare const memorySearchNode: import("../../node-scaffold.js").NodeScaffold<"MEMORY.SEARCH">;
//# sourceMappingURL=node.d.ts.map