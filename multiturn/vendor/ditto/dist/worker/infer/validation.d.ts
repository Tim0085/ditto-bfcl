import type { Message, Usage } from "./types.js";
export declare class InferError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
export declare function check(condition: unknown, message: string): asserts condition;
export declare function object(value: unknown, name?: string): Record<string, unknown>;
export declare function text(value: unknown, name: string, empty?: boolean): asserts value is string;
export declare function number(value: unknown, name: string, min?: number, max?: number, integer?: boolean): asserts value is number;
export declare function list(value: unknown, name: string): asserts value is unknown[];
export declare function message(value: unknown): asserts value is Message;
export declare function common(value: unknown): Record<string, unknown>;
export declare function messagesAndActions(v: Record<string, unknown>): void;
export declare function nodeName(value: unknown): asserts value is string;
export declare function steps(value: unknown): void;
export declare function usage(value: unknown): asserts value is Usage;
export declare function parseOutput(content: Message["content"]): Record<string, unknown>;
export declare function modelOutput<T>(validate: () => T): T;
export declare function errorInfo(error: unknown): {
    code: string;
    message: string;
};
/** Race even adapters that ignore AbortSignal; callers must still cooperate to stop their I/O. */
export declare function abortable<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T>;
export declare function addUsage(total: Usage, next?: Usage): void;
//# sourceMappingURL=validation.d.ts.map