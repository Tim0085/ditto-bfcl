import { createHash } from "node:crypto";
import { ContextError, check, inlineBytes, validatePolicy } from "./validation.js";
export const DEFAULT_CONTEXT_POLICY = Object.freeze({
    maxInlineBytes: 64 * 1024,
    maxItems: 256,
    duplicate: "replace",
    missingRemoval: "ignore",
});
export function createContextExecution(policy = {}, services = {}) {
    const resolved = Object.freeze({
        maxInlineBytes: policy.maxInlineBytes ?? DEFAULT_CONTEXT_POLICY.maxInlineBytes,
        maxItems: policy.maxItems ?? DEFAULT_CONTEXT_POLICY.maxItems,
        ...(policy.maxTokens === undefined ? {} : { maxTokens: policy.maxTokens }),
        duplicate: policy.duplicate ?? DEFAULT_CONTEXT_POLICY.duplicate,
        missingRemoval: policy.missingRemoval ?? DEFAULT_CONTEXT_POLICY.missingRemoval,
    });
    validatePolicy(resolved);
    return Object.freeze({ policy: resolved, services: Object.freeze({ ...services }) });
}
function canonical(value) {
    if (value === null || typeof value !== "object")
        return JSON.stringify(value);
    if (Array.isArray(value))
        return `[${value.map(canonical).join(",")}]`;
    const record = value;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${canonical(record[key])}`).join(",")}}`;
}
export function stableContextId(prefix, value) {
    return `${prefix}:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}
function clone(value) { return structuredClone(value); }
function freezeDeep(value) {
    if (value && typeof value === "object" && !Object.isFrozen(value)) {
        for (const child of Object.values(value))
            freezeDeep(child);
        Object.freeze(value);
    }
    return value;
}
export function snapshotItem(item) {
    return freezeDeep(clone(item));
}
export function snapshotContext(items) {
    return Object.freeze({ items: Object.freeze(items.map(snapshotItem)) });
}
function messageMetadata(message) {
    return Object.freeze({
        sourceType: "message",
        role: message.role,
        ...(message.name === undefined ? {} : { name: message.name }),
    });
}
export function normalizeSource(source, execution) {
    if ("id" in source)
        return checkedItem(source, execution);
    if ("role" in source) {
        const message = clone(source);
        return checkedItem({
            id: stableContextId("message", message),
            content: message.content,
            metadata: messageMetadata(message),
        }, execution);
    }
    const reference = clone(source);
    return checkedItem({
        id: stableContextId("reference", reference),
        content: [{ type: "reference", reference }],
        source: reference,
        metadata: { sourceType: "reference" },
    }, execution);
}
export function checkedItem(item, execution) {
    const bytes = inlineBytes(item.content);
    const referenced = item.source !== undefined
        || (Array.isArray(item.content) && item.content.some(part => part !== null && typeof part === "object" && "type" in part && part.type === "reference"));
    check(bytes <= execution.policy.maxInlineBytes || referenced, `Context item ${item.id} exceeds the inline byte limit`, "INLINE_LIMIT_EXCEEDED");
    return snapshotItem(item);
}
export function putItem(items, item, policy) {
    if (!items.has(item.id)) {
        items.set(item.id, item);
        return;
    }
    if (policy.duplicate === "keep-first")
        return;
    if (policy.duplicate === "reject")
        throw new ContextError("DUPLICATE_ITEM", `Duplicate Context item: ${item.id}`);
    // Map.set replaces the value without moving the original insertion position.
    items.set(item.id, item);
}
export async function estimateTokens(content, execution) {
    execution.signal?.throwIfAborted();
    const supplied = await execution.services.tokenEstimator?.estimate(content, execution);
    execution.signal?.throwIfAborted();
    const estimate = supplied ?? Math.ceil(new TextEncoder().encode(JSON.stringify(content)).byteLength / 4);
    check(Number.isSafeInteger(estimate) && estimate >= 0, "Token estimator returned an invalid value", "INVALID_PROVIDER_OUTPUT");
    return estimate;
}
export function numericMetadata(item, key) {
    const value = item.metadata?.[key];
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
export function booleanMetadata(item, key) {
    return item.metadata?.[key] === true;
}
export function textContent(content) {
    if (typeof content === "string")
        return content;
    if (Array.isArray(content))
        return content.map(part => {
            if (part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part)
                return String(part.text);
            return canonical(part);
        }).join(" ");
    return canonical(content);
}
//# sourceMappingURL=execution.js.map