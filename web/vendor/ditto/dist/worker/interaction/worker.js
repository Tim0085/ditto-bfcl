import { defineWorker } from "../define-worker.js";
import { createMcpHandler, McpRegistry } from "./act/mcp.js";
import { createToolHandler, ToolRegistry } from "./act/tool/index.js";
import { observeExternalResult } from "./observe.js";
import { createOutputHandler } from "./output.js";
/** Concrete TOOL/OBSERVE handlers plus resource-backed MCP and OUTPUT handlers. */
export function createInteractionNodes(options = {}) {
    const tools = options.tools ?? new ToolRegistry();
    const nodes = {
        "INTERACTION.ACT.TOOL": createToolHandler(tools),
        "INTERACTION.OBSERVE": async (input) => observeExternalResult(input),
        ...(options.mcp ? { "INTERACTION.ACT.MCP": createMcpHandler(options.mcp) } : {}),
        ...(options.output ? { "INTERACTION.OUTPUT": createOutputHandler(options.output) } : {}),
    };
    return nodes;
}
/** Configure capabilities inside the Worker; Graph and Loop remain independent of SDKs. */
export function createInteractionWorker(options = {}) {
    const tools = options.tools instanceof ToolRegistry ? options.tools : new ToolRegistry();
    if (options.tools && !(options.tools instanceof ToolRegistry)) {
        for (const tool of options.tools)
            tools.register(tool);
    }
    let mcp;
    if (options.mcp instanceof McpRegistry)
        mcp = options.mcp;
    else if (options.mcp) {
        mcp = new McpRegistry();
        for (const [server, client] of Object.entries(options.mcp))
            mcp.register(server, client);
    }
    return defineWorker({
        type: "INTERACTION",
        ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
        nodes: createInteractionNodes({
            tools,
            ...(mcp ? { mcp } : {}),
            ...(options.output ? { output: options.output } : {}),
        }),
    });
}
//# sourceMappingURL=worker.js.map