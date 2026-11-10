import { externalResult, nonempty } from "../../validation.js";
export class ToolRegistry {
    #tools = new Map();
    register(tool) {
        if (!/^[a-zA-Z0-9_-]{1,64}$/.test(tool.name) || this.#tools.has(tool.name)) {
            throw new Error(`Invalid or duplicate tool: ${tool.name}`);
        }
        this.#tools.set(tool.name, tool);
        return () => this.#tools.get(tool.name) === tool && this.#tools.delete(tool.name);
    }
    list(context) {
        return [...this.#tools.values()]
            .filter((tool) => context.services.sandbox.allows("tools", tool.name))
            .map(({ name, description, inputSchema, effects, requiresApproval }) => ({
            name,
            inputSchema,
            ...(description === undefined ? {} : { description }),
            ...(effects === undefined ? {} : { effects }),
            ...(requiresApproval === undefined ? {} : { requiresApproval }),
        }));
    }
    async call(call, context) {
        nonempty(call.id, "call.id");
        context.services.sandbox.assert("tools", call.name);
        const tool = this.#tools.get(call.name);
        if (!tool)
            throw new Error(`Unknown tool: ${call.name}`);
        tool.validate(call.arguments);
        const outcome = await tool.execute(call.arguments, context);
        return externalResult({ ...outcome, callId: call.id, source: call.name });
    }
}
//# sourceMappingURL=registry.js.map