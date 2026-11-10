import type { Context, ContextIngress, ContextItem, ContextSource, JsonObject, Message, MessageContent, Reference } from "../../contracts/common.js";
import type { ContextPolicy } from "./types.js";
export declare class ContextError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
export declare function check(value: unknown, message: string, code?: string): asserts value;
export declare function object(value: unknown, name?: string): Record<string, unknown>;
export declare function nonempty(value: unknown, name: string): asserts value is string;
export declare function nonnegativeInteger(value: unknown, name: string, max?: number): asserts value is number;
export declare function jsonObject(value: unknown, name: string): asserts value is JsonObject;
export declare function messageContent(value: unknown, name?: string): asserts value is MessageContent;
export declare function reference(value: unknown, name?: string): asserts value is Reference;
export declare function message(value: unknown, name?: string): asserts value is Message;
export declare function contextItem(value: unknown, name?: string): asserts value is ContextItem;
export declare function context(value: unknown, name?: string): asserts value is Context;
export declare function contextSource(value: unknown, name?: string): asserts value is ContextSource;
export declare function ingress(value: unknown, name?: string): asserts value is ContextIngress;
export declare function validatePolicy(policy: ContextPolicy): void;
export declare function inlineBytes(content: MessageContent): number;
//# sourceMappingURL=validation.d.ts.map