import { context, ContextError, nonempty, object, check } from "./validation.js";
import { snapshotContext, stableContextId } from "./execution.js";
export function contextScopeKey(scope) {
    const value = object(scope, "scope");
    const keys = ["sessionId", "turnId", "invocationId"];
    check(Object.keys(value).every(key => keys.includes(key)), "Unknown Context scope field");
    check(keys.some(key => value[key] !== undefined), "Context scope must contain an identifier");
    for (const key of keys)
        if (value[key] !== undefined)
            nonempty(value[key], `scope.${key}`);
    return stableContextId("scope", keys.map(key => value[key] ?? null));
}
export function checkedStoredContext(value) {
    try {
        const stored = object(value, "stored context");
        nonempty(stored.version, "version");
        context(stored.context);
        return Object.freeze({ version: stored.version, context: snapshotContext(stored.context.items) });
    }
    catch {
        throw new ContextError("INVALID_STATE", "Context store returned invalid state");
    }
}
export async function readContextState(store, scope, options) {
    const value = await store.get(scope, options);
    return value === undefined ? undefined : checkedStoredContext(value);
}
export function requireContextState(stored) {
    if (!stored)
        throw new ContextError("CONTEXT_NOT_FOUND", "Context is absent or expired; initialize it with LOAD");
    return stored.context;
}
//# sourceMappingURL=state.js.map