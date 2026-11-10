import { checkpointState, restoreState } from "./checkpoint.js";
/** One atomic authority for explicit Context/Memory/artifact/tool-session state.
 * External effects must use a separate transactional adapter; they are not rolled back here.
 * Values cross the API as JSON copies; forks share immutable base values until writes occur.
 */
export class BranchStore {
    id;
    #values = new Map();
    #revision = 0;
    constructor(id, snapshot) {
        this.id = id;
        if (!id.trim())
            throw new Error("State store ID is required");
        if (snapshot) {
            const state = restoreState(snapshot, `store:${id}`, "1");
            if (!Number.isSafeInteger(state.revision) || state.revision < 0)
                throw new Error("Invalid store revision");
            this.#revision = state.revision;
            this.#values = new Map(Object.entries(state.values));
        }
    }
    get revision() { return this.#revision; }
    snapshot() {
        return checkpointState(`store:${this.id}`, "1", { revision: this.#revision, values: Object.fromEntries(this.#values) });
    }
    fork() {
        const revision = this.#revision;
        return new StateBranch(new Map(this.#values), revision, writes => {
            if (revision !== this.#revision)
                throw new Error("State branch commit conflict");
            for (const [key, entry] of writes) {
                if (entry.deleted)
                    this.#values.delete(key);
                else
                    this.#values.set(key, entry.value);
            }
            this.#revision++;
        });
    }
}
export class StateBranch {
    base;
    revision;
    apply;
    #closed = false;
    #writes = new Map();
    constructor(base, revision, apply) {
        this.base = base;
        this.revision = revision;
        this.apply = apply;
    }
    #open() { if (this.#closed)
        throw new Error("State branch is closed"); }
    get(key) {
        this.#open();
        const entry = this.#writes.get(key);
        const value = entry ? entry.deleted ? undefined : entry.value : this.base.get(key);
        return value === undefined ? undefined : structuredClone(value);
    }
    set(key, value) {
        this.#open();
        if (!key)
            throw new Error("State key is required");
        this.#writes.set(key, { deleted: false, value: checkpointState("value", "1", value).state });
    }
    delete(key) { this.#open(); this.#writes.set(key, { deleted: true }); }
    commit() { this.#open(); this.apply(this.#writes); this.#closed = true; this.#writes.clear(); }
    discard() { this.#open(); this.#writes.clear(); this.#closed = true; }
}
//# sourceMappingURL=state-store.js.map