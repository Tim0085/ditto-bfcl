// 来源：Ditto v0.1.5 d95ded5；复制官方处理代码，差异见交付说明。
// 在原进程内 LRU 存储上增加 delete(scope)，并放宽 TTL 配置上限。
import { randomUUID } from "node:crypto";
import type { ContextOperationQueue, ContextStateStore, StoredContext } from "../../vendor/ditto/dist/worker/context/types.js";
import { checkedStoredContext, contextScopeKey } from "../../vendor/ditto/dist/worker/context/state.js";
import { check, context, nonempty, ContextError } from "../../vendor/ditto/dist/worker/context/validation.js";

export interface DeletableContextStore extends ContextStateStore { delete(scope: import("@codesoul-co/ditto/worker/context").ContextScope, call?: import("@codesoul-co/ditto/worker/context").ContextCallOptions): Promise<boolean>; }
export interface InMemoryContextOptions {
  readonly ttlMs?: number;
  readonly maxEntries?: number;
  readonly now?: () => number;
}
// 此存储只比较时间戳，不调用 setTimeout；无需受 32 位定时器上限约束。
export const BFCL_CONTEXT_TTL_MS = 365 * 24 * 60 * 60 * 1000;
/** Bounded, process-local LRU cache. CAS is atomic within this JavaScript isolate. */
export function createContextStore(options: InMemoryContextOptions = {}): DeletableContextStore {
  const ttlMs = options.ttlMs ?? 3_600_000;
  const maxEntries = options.maxEntries ?? 1000;
  check(Number.isSafeInteger(ttlMs) && ttlMs > 0 && ttlMs <= BFCL_CONTEXT_TTL_MS, "Invalid Context ttlMs");
  check(Number.isSafeInteger(maxEntries) && maxEntries > 0, "Invalid Context maxEntries");
  const now = options.now ?? Date.now;
  const entries = new Map<string, { stored: StoredContext; expires: number }>();
  const current = (key: string) => {
    const entry = entries.get(key);
    if (entry && entry.expires <= now()) { entries.delete(key); return undefined; }
    return entry;
  };
  return Object.freeze({
    async get(scope, call = {}) {
      call.signal?.throwIfAborted();
      const key = contextScopeKey(scope), entry = current(key);
      if (!entry) return undefined;
      entries.delete(key); entries.set(key, entry);
      return entry.stored; // Deeply frozen on write; reads do not refresh expiry.
    },
    async compareAndSet(scope, expectedVersion, next, call = {}) {
      call.signal?.throwIfAborted();
      const key = contextScopeKey(scope);
      if (expectedVersion !== undefined) nonempty(expectedVersion, "expectedVersion");
      context(next);
      if (current(key)?.stored.version !== expectedVersion) {
        throw new ContextError("STATE_CONFLICT", "Context changed or expired; reload before retrying");
      }
      const stored = checkedStoredContext({ version: randomUUID(), context: next });
      entries.delete(key);
      if (entries.size >= maxEntries) {
        const time = now();
        for (const [id, entry] of entries) if (entry.expires <= time) entries.delete(id);
      }
      entries.set(key, { stored, expires: now() + ttlMs });
      if (entries.size > maxEntries) entries.delete(entries.keys().next().value!);
      return stored;
    },
      async delete(scope, call = {}) { call.signal?.throwIfAborted(); return entries.delete(contextScopeKey(scope)); },
  } satisfies DeletableContextStore);
}

