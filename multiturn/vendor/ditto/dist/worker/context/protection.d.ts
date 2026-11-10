import type { ContextItem } from "../../contracts/common.js";
export declare function isProtectedContextItem(item: ContextItem): boolean;
export declare function contextGroups(items: readonly ContextItem[]): readonly ContextItem[][];
/** Providers may select evidence; protected groups remain the original execution facts. */
export declare function validateProtection(input: readonly ContextItem[], output: readonly ContextItem[], protect?: boolean): void;
//# sourceMappingURL=protection.d.ts.map