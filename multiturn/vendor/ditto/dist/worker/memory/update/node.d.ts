import type { MemoryCallOptions } from "../types.js";
import type { MemoryResources } from "../providers/store.js";
import type { MemoryUpdateInput, MemoryUpdateOutput } from "./types.js";
export declare function updateNode(input: MemoryUpdateInput, resources: MemoryResources, options?: MemoryCallOptions): Promise<MemoryUpdateOutput>;
export declare const memoryUpdateNode: import("../../node-scaffold.js").NodeScaffold<"MEMORY.UPDATE">;
//# sourceMappingURL=node.d.ts.map