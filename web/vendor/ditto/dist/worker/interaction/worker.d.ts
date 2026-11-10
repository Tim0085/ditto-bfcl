import { type WorkerDefinition, type WorkerNodes } from "../define-worker.js";
import { McpRegistry, type McpClient } from "./act/mcp.js";
import { ToolRegistry, type RegisteredTool } from "./act/tool/index.js";
import { type OutputSink } from "./output.js";
export interface InteractionNodeOptions {
    readonly tools?: ToolRegistry;
    readonly mcp?: McpRegistry;
    readonly output?: OutputSink;
}
/** Concrete TOOL/OBSERVE handlers plus resource-backed MCP and OUTPUT handlers. */
export declare function createInteractionNodes<R = undefined, C = undefined>(options?: InteractionNodeOptions): WorkerNodes<R, C>;
export interface InteractionOptions {
    readonly tools?: ToolRegistry | readonly RegisteredTool[];
    readonly mcp?: McpRegistry | Readonly<Record<string, McpClient>>;
    readonly output?: OutputSink;
    readonly concurrency?: number;
}
/** Configure capabilities inside the Worker; Graph and Loop remain independent of SDKs. */
export declare function createInteractionWorker(options?: InteractionOptions): WorkerDefinition;
//# sourceMappingURL=worker.d.ts.map