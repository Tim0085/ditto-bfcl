import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryStore } from "../src/ts/memory-store.ts";
import { createDirectSteps } from "../src/ts/direct-steps.ts";
import { runDirectTask } from "../src/ts/direct-task.ts";
import { runTask } from "../src/ts/task-loop.ts";
import { loadTask } from "../src/ts/tool-actions.ts";
import { localRuntime, taskOptions, python } from "./t4-helpers.ts";
import { sampleOutput } from "./t7-helpers.ts";
const root = () => mkdtemp(join(process.env.T3_FIX3_EVIDENCE ?? tmpdir(), "memory-"));

for (const mode of ["Direct", "Uniform"] as const) test(`M1 ${mode}: interrupt after turn 2 memory, rerun copied directory and same directory`, async () => {
  const dir = await root(), original = join(dir, "original"), moved = join(dir, "new-output");
  const task = await loadTask("multi_turn_base_0"), taskId = "resume/config/r1/" + task.id;
  const run = async (directory: string, stop: boolean) => {
    const extra = { providerFactory: () => ({ invoke: async () => structuredClone(sampleOutput) as any }) };
    const opts = { ...taskOptions(taskId), onStage(stage: string, output: any) {
      if (stop && stage === "save" && output.save.output[0].metadata.turn === 2) throw new Error("interrupt-after-save-2");
    } };
    if (mode === "Direct") {
      const steps = createDirectSteps({ ...extra, python, memoryDirectory: directory, inferenceTimeoutMs: 1000 });
      try { return await runDirectTask(steps, task, opts); } finally { await steps.dispose(); }
    }
    const r = await localRuntime(directory, undefined, "Uniform", extra);
    try { return await runTask(r.runtime, task, { ...opts, bindings: r.bindings, handles: r.handles }); }
    finally { await r.runtime.close(); }
  };
  await assert.rejects(run(original, true), /interrupt-after-save-2/);
  const memoryDir = mode === "Direct" ? original : join(original, "Memory");
  const names = await readdir(memoryDir); assert.equal(names.length, 1);
  const before = JSON.parse(await readFile(join(memoryDir, names[0]), "utf8"));
  assert.equal(before.memories.length, 2);
  await cp(original, moved, { recursive: true });
  for (const path of [moved, original]) {
    const result = await run(path, false); assert.equal(result.executionOutcome, "completed");
    assert.equal(result.completedTurns, task.question.length);
    const after = JSON.parse(await readFile(join(mode === "Direct" ? path : join(path, "Memory"), names[0]), "utf8"));
    assert.equal(after.memories.length, task.question.length); assert.notEqual(after.memories[0].id, before.memories[0].id);
  }
  console.log(JSON.stringify({ dir, mode, interruptedAfter: 2, newDirectory: "completed", sameDirectory: "completed", semantics: "restart" }));
});

test("M1 first WRITE is transactional; duplicate stays failure; 30 concurrent writes and reuse after release", async () => {
  const dir = await root(), plain = createMemoryStore(dir);
  await plain.write({ memories: [{ key: "task/old", content: "history" }] });
  const file = join(dir, (await readdir(dir))[0]), before = await readFile(file, "utf8");
  const store = createMemoryStore(dir, { restartOnFirstWrite: true });
  await assert.rejects(store.write({ memories: [{ key: "task/a", content: undefined }] }), /JSON/);
  assert.equal(await readFile(file, "utf8"), before);
  const ctrl = new AbortController(); ctrl.abort(new Error("cancel"));
  await assert.rejects(store.write({ memories: [{ key: "task/a", content: 1 }] }, { signal: ctrl.signal }), /cancel/);
  assert.equal(await readFile(file, "utf8"), before);
  await assert.rejects(store.write({ memories: [{ key: "task/a", content: 1 }, { key: "task/a", content: 2 }] }), /已存在/);
  assert.equal(await readFile(file, "utf8"), before);
  await Promise.all(Array.from({ length: 30 }, (_, n) => store.write({ memories: [{ key: "task/" + n, content: n }] })));
  assert.equal((await store.query({})).items.length, 30); assert.equal((await readdir(dir)).length, 1);
  const saved = await readFile(file, "utf8");
  await assert.rejects(store.write({ memories: [{ key: "task/0", content: 0 }] }), /已存在/);
  assert.equal(await readFile(file, "utf8"), saved);
  await store.releaseTask("task");
  await store.write({ memories: [{ key: "task/0", content: "new attempt" }] });
  assert.equal((await store.query({})).items.length, 1);
  console.log(JSON.stringify({ dir, concurrentWrites: 30, sameRunDuplicate: "rejected", failedWriteUnchanged: true }));
});

test("M1 duplicated save within one task fails as memory failure", async () => {
  const dir = await root(), steps = createDirectSteps({ python, memoryDirectory: dir, inferenceTimeoutMs: 1000,
    providerFactory: () => ({ invoke: async () => structuredClone(sampleOutput) as any }) });
  const original = steps.execute.bind(steps);
  steps.execute = (async (node: any, input: any, signal: any) => {
    const result = await original(node, input, signal);
    return node === "MEMORY.WRITE" ? original(node, input, signal) : result;
  }) as typeof steps.execute;
  try { await assert.rejects(runDirectTask(steps, await loadTask("multi_turn_base_0"), taskOptions("dup/task")), /Memory backend operation failed/); }
  finally { await steps.dispose(); }
});
