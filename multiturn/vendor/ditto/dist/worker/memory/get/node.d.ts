import type { MemoryCallOptions } from "../types.js";
import type { MemoryResources } from "../providers/store.js";
import type { MemoryGetInput, MemoryGetOutput } from "./types.js";
export declare function getNode(input: MemoryGetInput, resources: MemoryResources, options?: MemoryCallOptions): Promise<MemoryGetOutput>;
export declare const memoryGetNode: import("../../node-scaffold.js").NodeScaffold<"MEMORY.GET">;
//# sourceMappingURL=node.d.ts.map