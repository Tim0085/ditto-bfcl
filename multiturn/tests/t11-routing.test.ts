// T11 第 1 条：问模型／整理工具结果挑排队最少的那一份；一样少时轮流；全忙时照样排队、不报错。
// 用真实 Ditto 运行时 + 假的远端 Worker（每件活由测试手动放行），派活走 Ditto 自己的图执行器。
import test from "node:test";
import assert from "node:assert/strict";
import { createDitto, graph, loadRuntimeConfig } from "@codesoul-co/ditto";
import { CAPABILITIES, type Capability } from "../src/ts/agent-core.ts";
import { pickLeastQueued, useLeastQueued } from "../src/ts/least-queued.ts";

test("T11 rule: least queued wins, ties rotate, all busy still picks one", () => {
  assert.deepEqual(pickLeastQueued([{ id: "a", queued: 2 }, { id: "b", queued: 0 }, { id: "c", queued: 1 }], 0), { id: "b", next: 2 });
  let next = 0; const seen: string[] = [];
  for (let k = 0; k < 6; k++) { const r = pickLeastQueued(["a", "b", "c"].map(id => ({ id, queued: 0 })), next); seen.push(r.id); next = r.next; }
  assert.deepEqual(seen, ["a", "b", "c", "a", "b", "c"]);
  assert.equal(pickLeastQueued([{ id: "a", queued: 3 }, { id: "b", queued: 1 }, { id: "c", queued: 1 }], 0).id, "b");
  assert.equal(pickLeastQueued([{ id: "a", queued: 3 }, { id: "b", queued: 1 }, { id: "c", queued: 1 }], 2).id, "c");
  assert.throws(() => pickLeastQueued([], 0));
});

function harness(roles: Partial<Record<Capability, number>>, leastQueued = true) {
  const held = new Map<string, (() => void)[]>(), sent: { node: string; worker: string }[] = [], ids: [string, Capability][] = [];
  const transports = Object.entries(roles).flatMap(([role, count]) => Array.from({ length: count! }, (_, i) => {
    const id = `${role}-${i + 1}`; ids.push([id, role as Capability]);
    return { id, async invoke(envelope: any) {
      sent.push({ node: envelope.node, worker: id });
      await new Promise<void>(release => { if (!held.has(id)) held.set(id, []); held.get(id)!.push(release); });
      return { invocationId: envelope.id, payload: { kind: "inline" as const, value: { status: "success", worker: id } } };
    } };
  }));
  const runtime = createDitto({ config: loadRuntimeConfig({}), transports });
  const registrations = new Map(ids.map(([id, role]) => [id, runtime.registerRemote({ address: { workerId: id, workerType: "agent-core", hostId: "other", processId: id }, capabilities: [...CAPABILITIES[role]], transportId: id })]));
  const route = leastQueued ? useLeastQueued(runtime, registrations) : undefined;
  // 一步的图，和 task-loop.ts 一样在 bind 之后调 route.before，然后由 Ditto 自己同步选份。
  const start = (node: string, workerId?: string) => runtime.run(graph<any>("g").node("s", node as any, [], () => { route?.before(node, workerId); return {}; }) as any, {}, { workers: workerId ? { s: workerId } : {} });
  const tick = () => new Promise(r => setImmediate(r));
  const queued = () => Object.fromEntries(runtime.workers().map(w => [w.address.workerId, w.active]));
  const release = async (id: string) => { held.get(id)!.shift()!(); await tick(); await tick(); };
  return { runtime, start, tick, queued, release, sent };
}

test("T11 SAMPLE: idle copy first, busy copies queue on the least loaded one, never NoWorkerAvailableError", async () => {
  const h = harness({ Infer: 2 }), node = "INFER.REASONING.SAMPLE", runs: Promise<unknown>[] = [];
  const go = async () => { runs.push(h.start(node)); await h.tick(); return h.sent.at(-1)!.worker; };
  try {
    assert.equal(await go(), "Infer-1");
    assert.equal(await go(), "Infer-2", "the idle copy, not behind Infer-1");
    assert.equal(await go(), "Infer-1", "both busy: tie, rotate; it waits in Infer-1's queue instead of failing");
    assert.deepEqual(h.queued(), { "Infer-1": 2, "Infer-2": 1 });
    await h.release("Infer-2");
    assert.equal(await go(), "Infer-2", "Infer-2 is free, Infer-1 still has 2");
    await h.release("Infer-2");
    assert.equal(await go(), "Infer-2", "again the shortest queue (plain rotation would pick Infer-1)");
    for (const id of ["Infer-1", "Infer-1", "Infer-2"]) await h.release(id);
    assert.equal((await Promise.allSettled(runs)).filter(r => r.status === "rejected").length, 0);
    assert.deepEqual(h.queued(), { "Infer-1": 0, "Infer-2": 0 });
  } finally { await h.runtime.close(); }
});

test("T11 Targeted-like: 5 Infer copies, 4 concurrent asks never share a copy", async () => {
  const h = harness({ Infer: 5 }), node = "INFER.REASONING.SAMPLE", runs: Promise<unknown>[] = [];
  try {
    for (let i = 0; i < 4; i++) { runs.push(h.start(node)); await h.tick(); }
    for (let round = 0; round < 8; round++) {
      assert(Object.values(h.queued()).every(n => n <= 1), JSON.stringify(h.queued()));
      await h.release(h.sent[round].worker);
      runs.push(h.start(node)); await h.tick();
    }
    assert(Object.values(h.queued()).every(n => n <= 1), JSON.stringify(h.queued()));
    for (const [id, n] of Object.entries(h.queued())) for (let i = 0; i < n; i++) await h.release(id);
    assert.equal((await Promise.allSettled(runs)).filter(r => r.status === "rejected").length, 0);
  } finally { await h.runtime.close(); }
});

test("T11 OBSERVE choice hides the other Interaction copy only for that dispatch; a fixed ACT.TOOL right after still routes", async () => {
  const h = harness({ Interaction: 2 }), runs: Promise<unknown>[] = [];
  try {
    runs.push(h.start("INTERACTION.ACT.TOOL", "Interaction-1")); await h.tick();
    // 同一个回合里：OBSERVE 选 Interaction-2（Interaction-1 正忙），紧接着一个固定在 Interaction-1 的 ACT.TOOL。
    runs.push(h.start("INTERACTION.OBSERVE"), h.start("INTERACTION.ACT.TOOL", "Interaction-1")); await h.tick();
    assert.deepEqual(h.sent.map(s => `${s.node}@${s.worker}`), ["INTERACTION.ACT.TOOL@Interaction-1", "INTERACTION.OBSERVE@Interaction-2", "INTERACTION.ACT.TOOL@Interaction-1"]);
    for (const id of ["Interaction-1", "Interaction-2", "Interaction-1"]) await h.release(id);
    assert.equal((await Promise.allSettled(runs)).filter(r => r.status === "rejected").length, 0);
    assert(h.runtime.workers().every(w => w.available), "all copies visible again after dispatch");
  } finally { await h.runtime.close(); }
});

test("T11 contrast: Ditto's own rotation (no least-queued) puts an ask behind a busy copy while another is idle", async () => {
  const h = harness({ Infer: 2 }, false), node = "INFER.REASONING.SAMPLE", runs: Promise<unknown>[] = [];
  try {
    for (let i = 0; i < 2; i++) { runs.push(h.start(node)); await h.tick(); }
    await h.release("Infer-2");
    runs.push(h.start(node)); await h.tick();
    assert.equal(h.sent.at(-1)!.worker, "Infer-1"); assert.deepEqual(h.queued(), { "Infer-1": 2, "Infer-2": 0 });
    for (const id of ["Infer-1", "Infer-1"]) await h.release(id);
    await Promise.allSettled(runs);
  } finally { await h.runtime.close(); }
});
