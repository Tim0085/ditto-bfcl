import { isDeepStrictEqual } from "node:util";
import { booleanMetadata } from "./execution.js";
import { check } from "./validation.js";
export function isProtectedContextItem(item) {
    return booleanMetadata(item, "protected") || booleanMetadata(item, "safety")
        || booleanMetadata(item, "currentGoal") || booleanMetadata(item, "pending")
        || item.metadata?.role === "system";
}
export function contextGroups(items) {
    const groups = new Map();
    for (const item of items) {
        const callId = item.metadata?.callId;
        const key = typeof callId === "string" && callId ? `call:${callId}` : `item:${item.id}`;
        const group = groups.get(key);
        if (group)
            group.push(item);
        else
            groups.set(key, [item]);
    }
    return [...groups.values()];
}
/** Providers may select evidence; protected groups remain the original execution facts. */
export function validateProtection(input, output, protect = true) {
    const byId = new Map(output.map(item => [item.id, item]));
    for (const group of contextGroups(input)) {
        const required = protect && group.some(isProtectedContextItem);
        const present = group.filter(item => byId.has(item.id));
        check(present.length === group.length || (!required && present.length === 0), "Provider removed protected Context or split a correlated tool group", "INVALID_PROVIDER_OUTPUT");
        if (required)
            check(group.every(item => isDeepStrictEqual(item, byId.get(item.id))), "Provider changed a protected Context item", "INVALID_PROVIDER_OUTPUT");
    }
}
//# sourceMappingURL=protection.js.map