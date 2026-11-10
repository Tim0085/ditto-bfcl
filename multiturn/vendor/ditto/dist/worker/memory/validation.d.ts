import type { MemoryItem } from "./types.js";
export declare class MemoryError extends Error {
    readonly code: string;
    constructor(code: string, message: string);
}
export declare function check(value: unknown, message: string): asserts value;
export declare function object(value: unknown, name?: string): Record<string, unknown>;
export declare function text(value: unknown, name: string): asserts value is string;
export declare function integer(value: unknown, name: string, max?: number): asserts value is number;
export declare function item(value: unknown): asserts value is MemoryItem;
export declare function validateInput(operation: string, value: unknown): void;
export declare function validateOutput(operation: string, output: unknown, input?: unknown): void;
//# sourceMappingURL=validation.d.ts.map