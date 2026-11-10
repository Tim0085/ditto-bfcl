import { randomUUID } from "node:crypto";
import { defineWorker } from "../define-worker.js";
import { MemoryError, validateInput, validateOutput, integer } from "./validation.js";
import { getNode } from "./get/node.js";
import { queryNode } from "./query/node.js";
import { searchNode } from "./search/node.js";
import { writeNode } from "./write/node.js";
import { updateNode } from "./update/node.js";
import { deleteNode } from "./delete/node.js";
const handlers = {
    "MEMORY.GET": getNode, "MEMORY.QUERY": queryNode, "MEMORY.SEARCH": searchNode,
    "MEMORY.WRITE": writeNode, "MEMORY.UPDATE": updateNode, "MEMORY.DELETE": deleteNode,
};
/** Application-owned plugins; no implicit backend or workflow construction. */
export function createMemory(options) {
    const configuredDefaults = Object.freeze({ ...options.defaults });
    for (const [key, value] of Object.entries(configuredDefaults))
        integer(value, key);
    const resources = { store: options.store, ...(options.search === undefined ? {} : { search: options.search }) };
    async function execute(node, input, defaults = {}) {
        const base = { executionId: randomUUID(), node };
        try {
            defaults.signal?.throwIfAborted();
            if (!Object.hasOwn(handlers, node))
                throw new MemoryError("UNKNOWN_NODE", "Unknown MEMORY node");
            const op = node.slice(7).toLowerCase();
            if (node === "MEMORY.QUERY" || node === "MEMORY.SEARCH") {
                // Validate before defaulting so explicit invalid values never become defaults.
                validateInput(op, input);
                const limit = node === "MEMORY.QUERY"
                    ? configuredDefaults.queryLimit ?? defaults.queryLimit ?? 100
                    : configuredDefaults.searchLimit ?? defaults.searchLimit ?? 10;
                input = { ...input, limit: input.limit ?? limit };
            }
            // Type erasure is confined to the heterogeneous handler dispatch.
            const handler = handlers[node];
            const output = await handler(input, resources, { ...(defaults.runtime ? { runtime: defaults.runtime } : {}), ...(defaults.signal ? { signal: defaults.signal } : {}) });
            defaults.signal?.throwIfAborted();
            validateOutput(op, output, input);
            return { ...base, status: "success", output };
        }
        catch (error) {
            if (defaults.signal?.aborted)
                return { ...base, status: "cancelled", error: { code: "MEMORY_CANCELLED", message: "Memory operation cancelled" } };
            return { ...base, status: "failed", error: error instanceof MemoryError
                    ? { code: error.code, message: error.message }
                    : { code: "MEMORY_BACKEND_ERROR", message: "Memory backend operation failed" } };
        }
    }
    return {
        execute,
        get: (input, options = {}) => execute("MEMORY.GET", input, options),
        query: (input, options = {}) => execute("MEMORY.QUERY", input, options),
        search: (input, options = {}) => execute("MEMORY.SEARCH", input, options),
        write: (input, options = {}) => execute("MEMORY.WRITE", input, options),
        update: (input, options = {}) => execute("MEMORY.UPDATE", input, options),
        delete: (input, options = {}) => execute("MEMORY.DELETE", input, options),
    };
}
export function createMemoryWorker(options) {
    const memory = createMemory(options);
    return defineWorker({
        type: "MEMORY",
        resources: () => memory,
        ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
        nodes: Object.fromEntries(Object.keys(handlers).map(node => [node,
            (input, ctx) => ctx.resources.execute(node, input, { ...ctx.services.config.memory, runtime: ctx, ...(ctx.signal ? { signal: ctx.signal } : {}) }),
        ])),
    });
}
//# sourceMappingURL=worker.js.map