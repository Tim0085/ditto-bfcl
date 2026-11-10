// T11（11-08）：Uniform／Targeted 里不固定的步骤（问模型 SAMPLE、整理工具结果 OBSERVE）每次派给
// 当时排队最少的那一份（排队中＋正在做的件数最少；一样少时轮流）。照旧实验，见重设计方案 5.2。
// Ditto 0.1.5 的路由只轮流派、不看忙闲，且版本冻结不改。它在 bind 返回后同步选份，中间不会插入别的代码，
// 所以每一步派出前由这里设好路由能看见的份：不固定的步骤只留选中的那一份，固定的步骤全部可见。
// 全忙时照样选排队最少的那一份、在它的 Worker 里排队（queueMs 照旧），不会出现"没有可用的份"。
import type { DittoRuntime } from "@codesoul-co/ditto/runtime";

/** 选排队最少的；一样少时从 next 开始往后找第一份（轮流）。返回选中的份和下一次的起点。 */
export function pickLeastQueued(workers: readonly { id: string; queued: number }[], next: number) {
  if (!workers.length) throw new Error("没有能做这一步的份");
  const least = Math.min(...workers.map(w => w.queued));
  for (let k = 0; k < workers.length; k++) {
    const i = (next + k) % workers.length;
    if (workers[i].queued === least) return { id: workers[i].id, next: (i + 1) % workers.length };
  }
  throw new Error("unreachable");
}

type Registration = { readonly address: { readonly workerId: string }; setAvailable(available: boolean): void };
export class LeastQueuedRoute {
  #next = new Map<string, number>();
  #exclusive = false;
  constructor(readonly runtime: DittoRuntime, readonly registrations: ReadonlyMap<string, Registration>) {}
  /** 每一步派出前同步调用。workerId 是这一步的固定份；没有就按排队数选份，返回选中的份。 */
  before(node: string, workerId?: string): string | undefined {
    this.#showAll();
    if (workerId !== undefined) return;
    // runtime.workers() 的 active＝这个 runtime 已派给该份、还没回来的件数，即排队中＋正在做。
    const candidates = this.runtime.workers().filter(w => (w.capabilities as readonly string[]).includes(node) && this.registrations.has(w.address.workerId));
    if (!candidates.length) return;
    const { id, next } = pickLeastQueued(candidates.map(w => ({ id: w.address.workerId, queued: w.active })), this.#next.get(node) ?? 0);
    this.#next.set(node, next);
    for (const w of candidates) this.registrations.get(w.address.workerId)!.setAvailable(w.address.workerId === id);
    this.#exclusive = true;
    queueMicrotask(() => this.#showAll());
    return id;
  }
  #showAll() {
    if (!this.#exclusive) return;
    this.#exclusive = false;
    for (const registration of this.registrations.values()) registration.setAvailable(true);
  }
}
const routes = new WeakMap<object, LeastQueuedRoute>();
export function useLeastQueued(runtime: DittoRuntime, registrations: ReadonlyMap<string, Registration>) {
  const route = new LeastQueuedRoute(runtime, registrations);
  routes.set(runtime, route);
  return route;
}
export function leastQueuedRoute(runtime: DittoRuntime) { return routes.get(runtime); }
