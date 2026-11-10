import type { JsonValue } from "../contracts/common.js";
export type Expression = (scope: Readonly<Record<string, unknown>>) => unknown;
export declare function fail(where: string, message: string, code?: string): never;
export declare function record(value: unknown, where: string): Record<string, unknown>;
export declare function fields(value: Record<string, unknown>, allowed: readonly string[], where: string): void;
export declare function name(value: unknown, where: string): string;
export declare function positive(value: unknown, where: string): number;
/** Snapshot JSON before compiling: reject executable values, cycles and prototype keys. */
export declare function snapshot(value: unknown): JsonValue;
export declare function pathParts(value: unknown, where: string): string[];
export declare function lookup(value: unknown, parts: readonly string[]): unknown;
export declare function boolean(value: unknown, where: string): boolean;
/** Expressions are compiled once, never evaluated as JavaScript. */
export declare function expression(value: unknown, roots: readonly string[], where: string, dependencies?: readonly string[], references?: Set<string>): Expression;
//# sourceMappingURL=agent-expression.d.ts.map