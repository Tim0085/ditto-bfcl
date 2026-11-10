import type { RegisteredTool } from "./registry.js";
export interface ReadOnlyCommandToolOptions {
    readonly maxEntries?: number;
    readonly maxOutputBytes?: number;
    readonly maxErrorBytes?: number;
}
/** Optional read-only command tools. Applications still provide the isolated SandboxExecutor. */
export declare function createReadOnlyCommandTools(options?: ReadOnlyCommandToolOptions): readonly RegisteredTool[];
//# sourceMappingURL=read-only-commands.d.ts.map