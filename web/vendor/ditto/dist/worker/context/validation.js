export class ContextError extends Error {
    code;
    constructor(code, message) {
        super(message);
        this.code = code;
        this.name = "ContextError";
    }
}
export function check(value, message, code = "INVALID_INPUT") {
    if (!value)
        throw new ContextError(code, message);
}
export function object(value, name = "value") {
    check(value !== null && typeof value === "object" && !Array.isArray(value), `${name} must be an object`);
    return value;
}
export function nonempty(value, name) {
    check(typeof value === "string" && value.length > 0, `${name} must be a nonempty string`);
}
export function nonnegativeInteger(value, name, max = 1_000_000) {
    check(typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max, `${name} must be an integer in 0..${max}`);
}
function json(value, name, seen = new Set()) {
    if (value === null || typeof value === "string" || typeof value === "boolean")
        return;
    if (typeof value === "number") {
        check(Number.isFinite(value), `${name} contains a non-finite number`);
        return;
    }
    check(typeof value === "object", `${name} must be JSON-serializable`);
    check(!seen.has(value), `${name} cannot contain cycles`);
    seen.add(value);
    if (Array.isArray(value))
        value.forEach((entry, index) => json(entry, `${name}[${index}]`, seen));
    else
        for (const [key, entry] of Object.entries(value))
            json(entry, `${name}.${key}`, seen);
    seen.delete(value);
}
export function jsonObject(value, name) {
    object(value, name);
    json(value, name);
}
export function messageContent(value, name = "content") {
    check(value !== undefined, `${name} is required`);
    json(value, name);
}
export function reference(value, name = "reference") {
    const candidate = object(value, name);
    nonempty(candidate.uri, `${name}.uri`);
    if (candidate.mediaType !== undefined)
        nonempty(candidate.mediaType, `${name}.mediaType`);
    if (candidate.digest !== undefined)
        nonempty(candidate.digest, `${name}.digest`);
}
export function message(value, name = "message") {
    const candidate = object(value, name);
    check(["system", "user", "assistant", "tool"].includes(candidate.role), `${name}.role is invalid`);
    messageContent(candidate.content, `${name}.content`);
    if (candidate.name !== undefined)
        nonempty(candidate.name, `${name}.name`);
}
export function contextItem(value, name = "item") {
    const candidate = object(value, name);
    nonempty(candidate.id, `${name}.id`);
    messageContent(candidate.content, `${name}.content`);
    if (candidate.source !== undefined)
        reference(candidate.source, `${name}.source`);
    if (candidate.metadata !== undefined)
        jsonObject(candidate.metadata, `${name}.metadata`);
}
export function context(value, name = "context") {
    const candidate = object(value, name);
    check(Array.isArray(candidate.items), `${name}.items must be an array`);
    const ids = new Set();
    for (const [index, item] of candidate.items.entries()) {
        contextItem(item, `${name}.items[${index}]`);
        check(!ids.has(item.id), `${name} contains duplicate item id: ${item.id}`);
        ids.add(item.id);
    }
}
export function contextSource(value, name = "source") {
    const candidate = object(value, name);
    if ("id" in candidate)
        contextItem(value, name);
    else if ("role" in candidate)
        message(value, name);
    else
        reference(value, name);
}
export function ingress(value, name = "ingress") {
    const candidate = object(value, name);
    nonempty(candidate.id, `${name}.id`);
    nonempty(candidate.sourceNode, `${name}.sourceNode`);
    check(/^[^.\s]+(?:\.[^.\s]+)+$/.test(candidate.sourceNode), `${name}.sourceNode must be a qualified Node ID`);
    messageContent(candidate.content, `${name}.content`);
    if (candidate.reference !== undefined)
        reference(candidate.reference, `${name}.reference`);
    if (candidate.metadata !== undefined)
        jsonObject(candidate.metadata, `${name}.metadata`);
}
export function validatePolicy(policy) {
    nonnegativeInteger(policy.maxInlineBytes, "policy.maxInlineBytes");
    check(policy.maxInlineBytes > 0, "policy.maxInlineBytes must be positive");
    nonnegativeInteger(policy.maxItems, "policy.maxItems");
    check(policy.maxItems > 0, "policy.maxItems must be positive");
    if (policy.maxTokens !== undefined) {
        nonnegativeInteger(policy.maxTokens, "policy.maxTokens");
        check(policy.maxTokens > 0, "policy.maxTokens must be positive");
    }
    check(["replace", "keep-first", "reject"].includes(policy.duplicate), "policy.duplicate is invalid");
    check(["ignore", "reject"].includes(policy.missingRemoval), "policy.missingRemoval is invalid");
}
export function inlineBytes(content) {
    return new TextEncoder().encode(JSON.stringify(content)).byteLength;
}
//# sourceMappingURL=validation.js.map