import type { Context } from "../../contracts/common.js";
import type { ContextScope, ContextStateStore, StoredContext, ContextCallOptions } from "./types.js";
/** A scope addresses cached working state; it is not an authorization credential. */
export interface ContextStateInput {
    readonly scope: ContextScope;
    readonly expectedVersion?: string;
}
export type ContextRequest<T> = T | (Omit<T, "context"> & ContextStateInput & {
    readonly context?: never;
});
export declare function contextScopeKey(scope: ContextScope): string;
export declare function checkedStoredContext(value: unknown): StoredContext;
export declare function readContextState(store: ContextStateStore, scope: ContextScope, options?: ContextCallOptions): Promise<StoredContext | undefined>;
export declare function requireContextState(stored: StoredContext | undefined): Context;
//# sourceMappingURL=state.d.ts.map