import { type StateCheckpoint } from "./checkpoint.js";
export interface StoreState {
    readonly revision: number;
    readonly values: Readonly<Record<string, unknown>>;
}
export type StoreSnapshot = StateCheckpoint<StoreState>;
/** One atomic authority for explicit Context/Memory/artifact/tool-session state.
 * External effects must use a separate transactional adapter; they are not rolled back here.
 * Values cross the API as JSON copies; forks share immutable base values until writes occur.
 */
export declare class BranchStore {
    #private;
    readonly id: string;
    constructor(id: string, snapshot?: StoreSnapshot);
    get revision(): number;
    snapshot(): StoreSnapshot;
    fork(): StateBranch;
}
type Write = {
    readonly deleted: true;
} | {
    readonly deleted: false;
    readonly value: unknown;
};
export declare class StateBranch {
    #private;
    private readonly base;
    readonly revision: number;
    private readonly apply;
    constructor(base: ReadonlyMap<string, unknown>, revision: number, apply: (writes: ReadonlyMap<string, Write>) => void);
    get<T>(key: string): T | undefined;
    set(key: string, value: unknown): void;
    delete(key: string): void;
    commit(): void;
    discard(): void;
}
export {};
//# sourceMappingURL=state-store.d.ts.map