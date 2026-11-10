import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startEgress } from "../src/ts/egress/server.ts";
import { loadEgressConfig } from "../src/ts/egress/config.ts";
import { mockResponse } from "../src/ts/egress/mock.ts";
import { createModelClient } from "../src/ts/model-client.ts";
import { createDirectSteps } from "../src/ts/direct-steps.ts";
import { runDirectTask } from "../src/ts/direct-task.ts";
import { loadTask } from "../src/ts/tool-actions.ts";
import { taskOptions } from "./t4-helpers.ts";
import { fakeServer, sampleInput, python, sleep } from "./t7-helpers.ts";
const root = () => mkdtemp(join(process.env.T3_FIX3_EVIDENCE ?? tmpdir(), "cancel-"));
async function setup(timeoutMs = 600000) {
  const dir = await root(), config = await loadEgressConfig("config/egress.offline.json", "live");
  config.retryPolicy.maxRetries = 0;
  config.settings.model.timeoutMs = timeoutMs;
  let release!: () => void, arrived!: () => void;
  const ready = new Promise<void>(r => arrived = r), wait = new Promise<void>(r => release = r);
  const remote = await fakeServer((_body, res) => { arrived(); void wait.then(() =>
    res.end(JSON.stringify(mockResponse({ message: { role: "assistant", content: "done" }, finishReason: "stop" }, "deepseek-flash", "chat-completions", 0)))); });
  const service = await startEgress(config, dir, { testUrl: remote.url });
  let disconnected = 0;
  service.server.on("request", (_req, res) => res.once("close", () => { if (!res.writableEnded) disconnected++; }));
  return { dir, config, service, ready, release, get disconnected() { return disconnected; },
    async close() { release(); await service.close(); await remote.close(); } };
}

for (const cause of ["task-abort", "infer-deadline"] as const) test(`M2 ${cause}: drain, settle and allow another config`, async () => {
  const s = await setup(), ctrl = new AbortController();
  const steps = createDirectSteps({ python, modelEndpoint: s.service.url, memoryDirectory: join(s.dir, "memory"),
    inferenceTimeoutMs: cause === "infer-deadline" ? 30 : 5000 });
  try {
    const pending = steps.execute("INFER.REASONING.SAMPLE", sampleInput as any, ctrl.signal);
    await s.ready;
    if (cause === "task-abort") ctrl.abort(new Error("task cancelled")); else await sleep(60);
    assert.equal(s.disconnected, 0); assert.equal(s.service.gateway.stopped, false);
    s.release(); const result = await pending;
    assert.equal(result.status, cause === "task-abort" ? "cancelled" : "timeout");
    assert.equal(s.service.gateway.ledger.snapshot().settled, 1);
    const other = structuredClone(sampleInput); other.metadata.configId = "other-config"; other.metadata.taskId = "other/task";
    const next = await createModelClient(s.service.url).invoke(other as any, { signal: new AbortController().signal });
    assert.equal(next.finishReason, "stop"); assert.equal(s.service.gateway.ledger.snapshot().settled, 2);
    const nextSteps = createDirectSteps({ python, modelEndpoint: s.service.url, memoryDirectory: join(s.dir, "next-memory"), inferenceTimeoutMs: 5000 });
    try {
      const task = await loadTask("multi_turn_base_0");
      const complete = await runDirectTask(nextSteps, task, { ...taskOptions("next/task"), configId: "other-config" });
      assert.equal(complete.executionOutcome, "completed"); assert.equal(complete.completedTurns, task.question.length);
    } finally { await nextSteps.dispose(); }
    assert.equal(s.disconnected, 0); await assert.rejects(access(join(s.dir, "stopped.json")));
    console.log(JSON.stringify({ dir: s.dir, cause, status: result.status, disconnected: s.disconnected, ledger: s.service.gateway.ledger.snapshot(), nextConfig: "success" }));
  } finally { await steps.dispose(); await s.close(); }
});

test("M2 abandoned request still obeys egress deadline and retains unknown fee", async () => {
  const s = await setup(100), ctrl = new AbortController();
  const steps = createDirectSteps({ python, modelEndpoint: s.service.url, memoryDirectory: join(s.dir, "memory"), inferenceTimeoutMs: 5000 });
  try {
    const pending = steps.execute("INFER.REASONING.SAMPLE", sampleInput as any, ctrl.signal);
    const checked = assert.rejects(pending, /BFCL_RUN_STOP/);
    await s.ready; ctrl.abort(new Error("task abandoned"));
    await checked;
    assert.equal(s.service.gateway.stopped, true); assert(s.service.gateway.ledger.snapshot().reservedMicroUsd > 0);
    assert.equal(s.service.gateway.ledger.snapshot().settled, 0); await access(join(s.dir, "stopped.json"));
    console.log(JSON.stringify({ dir: s.dir, compressedEgressDeadlineMs: 100, productionDeadlineMs: 600000, ledger: s.service.gateway.ledger.snapshot() }));
  } finally { s.release(); await steps.dispose(); await s.close(); }
});

for (const cause of ["explicit-client-cancel", "egress-fault", "run-stop"] as const) test(`M2 retains ${cause} global stop`, async () => {
  const s = await setup(), ctrl = new AbortController();
  try {
    if (cause === "explicit-client-cancel") {
      const pending = createModelClient(s.service.url).invoke(sampleInput as any, { signal: ctrl.signal });
      const check = assert.rejects(pending); await s.ready; ctrl.abort(new Error("explicit config cancellation")); await check;
      s.release();
      for (let i = 0; i < 100 && !s.service.gateway.stopped; i++) await sleep(10);
    } else if (cause === "egress-fault") {
      await fetch(s.service.url, { method: "POST", body: "{}" });
    } else await s.service.gateway.halt();
    assert.equal(s.service.gateway.stopped, true);
    for (let i = 0; i < 100; i++) { try { await access(join(s.dir, "stopped.json")); break; } catch { await sleep(10); } }
    await access(join(s.dir, "stopped.json"));
    await assert.rejects(createModelClient(s.service.url).invoke(sampleInput as any, { signal: new AbortController().signal }), /BFCL_RUN_STOP/);
    console.log(JSON.stringify({ dir: s.dir, cause, stopped: JSON.parse(await readFile(join(s.dir, "stopped.json"), "utf8")) }));
  } finally { await s.close(); }
});
