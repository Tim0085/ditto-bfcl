import { defineNode } from "./node.js";
/** Add operations in a namespace; existing Worker definitions are not mutated. */
export function extendWorker(type, options) {
    const nodes = {};
    for (const [operation, handler] of Object.entries(options.nodes)) {
        if (!operation || operation.startsWith(".") || operation.endsWith(".") || operation.includes("..")) {
            throw new Error("Expected a relative Node operation path");
        }
        nodes[`${type}.${operation}`] = handler;
    }
    // Requalifying keys preserves each operation's checked input/output contract.
    return defineWorker({ ...options, type, nodes });
}
export function defineWorker(options) {
    if (!options.type.trim())
        throw new Error("Worker type cannot be empty");
    if (options.concurrency !== undefined && (!Number.isSafeInteger(options.concurrency) || options.concurrency < 1)) {
        throw new Error("Worker concurrency must be a positive integer");
    }
    // Type erasure is limited to this heterogeneous lookup. Definitions are
    // checked per key by WorkerNodes, and dispatch checks capability membership.
    const nodes = new Map();
    for (const [key, entry] of Object.entries(options.nodes)) {
        const node = key;
        const definition = typeof entry === "function"
            ? defineNode(options.type, node, entry)
            : entry;
        if (definition?.type !== node) {
            throw new Error(`Node definition does not match ${node}`);
        }
        if (definition.workerType !== options.type) {
            throw new Error(`Node ${node} belongs to Worker ${definition.workerType}, not ${options.type}`);
        }
        // Normalize structural definitions too: validate and snapshot before registration.
        nodes.set(node, typeof entry === "function" ? definition : defineNode(options.type, node, definition.execute));
    }
    if (nodes.size === 0)
        throw new Error("A Worker must implement at least one Node");
    const capabilities = [...new Set(options.expose ?? nodes.keys())];
    if (!capabilities.length || capabilities.some((node) => !nodes.has(node))) {
        throw new Error("Worker must expose at least one implemented Node");
    }
    const resourceFactory = options.resources;
    const config = options.config;
    return Object.freeze({
        type: options.type,
        capabilities: Object.freeze(capabilities),
        nodeTypes: Object.freeze([...nodes.keys()]),
        ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
        instantiate() {
            const resources = resourceFactory?.();
            return {
                dispose: () => options.dispose?.(resources),
                execute(node, input, services) {
                    const definition = nodes.get(node);
                    if (!definition)
                        throw new Error(`Worker does not implement ${node}`);
                    // Type erasure stays inside this heterogeneous dispatch table.
                    const handler = definition.execute;
                    return handler(input, { ...services, resources, config });
                },
            };
        },
    });
}
//# sourceMappingURL=define-worker.js.map