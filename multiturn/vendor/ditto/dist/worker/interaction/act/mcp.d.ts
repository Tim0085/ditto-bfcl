import type { InteractionError, JsonObject, MessageContent, Reference, JsonValue } from "../../../contracts/common.js";
import type { Sandbox } from "../../../runtime/sandbox/index.js";
import type { InteractionMcpInput, InteractionMcpOutput } from "../contracts.js";
export declare const interactionMcpNode: import("../../node-scaffold.js").NodeScaffold<"INTERACTION.ACT.MCP">;
/** Structural boundary for an optional MCP SDK client. */
export interface McpCallOptions {
    readonly signal?: AbortSignal;
}
export interface McpClient {
    listTools(params?: {
        cursor?: string;
    }, options?: McpCallOptions): Promise<{
        tools: readonly {
            name: string;
            description?: string;
            inputSchema: JsonObject;
            outputSchema?: JsonObject;
        }[];
        nextCursor?: string;
    }>;
    callTool(params: {
        name: string;
        arguments: JsonObject;
    }, options?: McpCallOptions): Promise<McpToolResult>;
}
export interface McpToolResult {
    content?: MessageContent;
    structuredContent?: JsonValue;
    references?: readonly Reference[];
    isError?: boolean;
    error?: InteractionError;
}
export interface McpRegistryOptions {
    maxDiscoveryPages?: number;
    maxCapabilities?: number;
}
export declare class McpRegistry {
    #private;
    readonly options: McpRegistryOptions;
    constructor(options?: McpRegistryOptions);
    register(server: string, client: McpClient): () => boolean;
    execute(input: InteractionMcpInput, sandbox: Sandbox, options?: McpCallOptions): Promise<InteractionMcpOutput>;
}
export declare function createMcpHandler<R = undefined, C = undefined>(registry: McpRegistry): import("../../node.js").NodeHandler<"INTERACTION.ACT.MCP", R, C>;
//# sourceMappingURL=mcp.d.ts.map