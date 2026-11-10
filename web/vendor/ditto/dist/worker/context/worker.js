import { check, nonempty, object, ContextError } from "./validation.js";
import { contextScopeKey, readContextState, requireContextState } from "./state.js";
import { createRedisContextStore } from "./redis.js";
import { defineWorker } from "../define-worker.js";
import { createContextExecution } from "./execution.js";
import { loadNode } from "./load/node.js";
import { selectNode } from "./select/node.js";
import { updateNode } from "./update/node.js";
import { compressNode } from "./compress/node.js";
const handlers = {
    "CONTEXT.LOAD": loadNode,
    "CONTEXT.SELECT": selectNode,
    "CONTEXT.UPDATE": updateNode,
    "CONTEXT.COMPRESS": compressNode,
};
/** The direct SDK and Runtime Worker share the same validated leaf handlers. */
export function createContext(options = {}) {
    check(!(options.redis && options.services?.stateStore), "Configure either redis or stateStore");
    const services = options.redis
        ? { ...options.services, stateStore: createRedisContextStore(options.redis.client, options.redis) }
        : options.services;
    const baseExecution = createContextExecution(options.policy, services);
    async function execute(node, input, call) {
        const execution = { ...baseExecution, signal: call?.signal, runtime: call?.runtime };
        execution.signal?.throwIfAborted();
        check(Object.hasOwn(handlers, node), "Unknown Context node", "UNKNOWN_NODE");
        const request = object(input, "input");
        if (node === "CONTEXT.LOAD" && request.resolveReferences !== undefined) {
            check(typeof request.resolveReferences === "boolean", "resolveReferences must be a boolean");
            check(!request.resolveReferences || request.sources !== undefined, "resolveReferences requires sources");
        }
        const handler = handlers[node];
        if (request.scope === undefined) {
            check(request.expectedVersion === undefined, "expectedVersion requires scope");
            const output = await handler(input, execution);
            execution.signal?.throwIfAborted();
            return output;
        }
        const state = input;
        contextScopeKey(state.scope);
        const scope = Object.freeze({ ...state.scope });
        const expectedVersion = state.expectedVersion;
        check(request.context === undefined, "Pass either context or scope, not both");
        if (expectedVersion !== undefined)
            nonempty(expectedVersion, "expectedVersion");
        const store = execution.services.stateStore;
        if (!store)
            throw new ContextError("STATE_STORE_UNAVAILABLE", "Configure a Context state store or Redis client");
        const operation = async () => {
            execution.signal?.throwIfAborted();
            const stored = await readContextState(store, scope, call);
            execution.signal?.throwIfAborted();
            if (expectedVersion !== undefined && stored?.version !== expectedVersion) {
                throw new ContextError("STATE_CONFLICT", "Context version changed or expired");
            }
            if (node === "CONTEXT.LOAD" && request.sources === undefined) {
                return requireContextState(stored);
            }
            const resolved = node === "CONTEXT.LOAD" ? input : { ...request, context: requireContextState(stored) };
            const output = await handler(resolved, execution);
            execution.signal?.throwIfAborted();
            // SELECT is a projection; it never replaces the session's working set.
            if (node !== "CONTEXT.SELECT")
                await store.compareAndSet(scope, stored?.version, output, call);
            execution.signal?.throwIfAborted();
            return output;
        };
        return execution.services.operationQueue?.enqueue(scope, operation, call) ?? operation();
    }
    return Object.freeze({
        execute,
        load: (input, call) => execute("CONTEXT.LOAD", input, call),
        select: (input, call) => execute("CONTEXT.SELECT", input, call),
        update: (input, call) => execute("CONTEXT.UPDATE", input, call),
        compress: (input, call) => execute("CONTEXT.COMPRESS", input, call),
    });
}
export function createContextWorker(options = {}) {
    return defineWorker({
        type: "CONTEXT",
        resources: () => {
            const policy = { ...options.policy };
            const services = options.servicesFactory?.() ?? options.services ?? {};
            const create = (defaults) => createContext({
                policy: { ...defaults, ...policy }, services,
                ...(options.redis === undefined ? {} : { redis: options.redis }),
            });
            const base = create(), clients = new WeakMap();
            // Runtime settings are immutable: resolve policy once, sharing the same resources.
            return defaults => {
                if (!defaults)
                    return base;
                let client = clients.get(defaults);
                if (!client) {
                    client = create(defaults);
                    clients.set(defaults, client);
                }
                return client;
            };
        },
        ...(options.concurrency === undefined ? {} : { concurrency: options.concurrency }),
        nodes: {
            "CONTEXT.LOAD": (input, ctx) => ctx.resources(ctx.services.config.context.policy).load(input, { runtime: ctx, ...(ctx.signal ? { signal: ctx.signal } : {}) }),
            "CONTEXT.SELECT": (input, ctx) => ctx.resources(ctx.services.config.context.policy).select(input, { runtime: ctx, ...(ctx.signal ? { signal: ctx.signal } : {}) }),
            "CONTEXT.UPDATE": (input, ctx) => ctx.resources(ctx.services.config.context.policy).update(input, { runtime: ctx, ...(ctx.signal ? { signal: ctx.signal } : {}) }),
            "CONTEXT.COMPRESS": (input, ctx) => ctx.resources(ctx.services.config.context.policy).compress(input, { runtime: ctx, ...(ctx.signal ? { signal: ctx.signal } : {}) }),
        },
    });
}
//# sourceMappingURL=worker.js.map