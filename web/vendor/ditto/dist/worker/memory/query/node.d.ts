import type { MemoryCallOptions } from "../types.js";
import type { MemoryResources } from "../providers/store.js";
import type { MemoryQueryInput, MemoryQueryOutput } from "./types.js";
export declare function queryNode(input: MemoryQueryInput, resources: MemoryResources, options?: MemoryCallOptions): Promise<MemoryQueryOutput>;
export declare const memoryQueryNode: import("../../node-scaffold.js").NodeScaffold<"MEMORY.QUERY">;
//# sourceMappingURL=node.d.ts.map