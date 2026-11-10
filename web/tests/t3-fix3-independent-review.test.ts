import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, access, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDirectSteps } from "../src/ts/direct-steps.ts";
import { runDirectTask } from "../src/ts/direct-task.ts";
import { runTask } from "../src/ts/task-loop.ts";
import { loadTask } from "../src/ts/tool-actions.ts";
import { startEgress } from "../src/ts/egress/server.ts";
import { loadEgressConfig } from "../src/ts/egress/config.ts";
import { mockResponse } from "../src/ts/egress/mock.ts";
import { localRuntime, taskOptions, python } from "./t4-helpers.ts";
import { fakeServer, sampleOutput, sleep } from "./t7-helpers.ts";

const base = process.env.T3_FIX3_EVIDENCE ?? tmpdir();
const root = () => mkdtemp(join(base, "independent-"));

for (const mode of ["Direct", "Uniform"] as const) test(`independent M1 ${mode}: same instance interrupted turn two, restart and third run`, async () => {
  const dir = await root(), task = await loadTask("multi_turn_base_0"), taskId = "review/same/" + task.id;
  const extra = { providerFactory: () => ({ invoke: async () => structuredClone(sampleOutput) as any }) };
  const direct = mode === "Direct" ? createDirectSteps({ ...extra, python, memoryDirectory: dir, inferenceTimeoutMs: 1000 }) : undefined;
  const graph = mode === "Uniform" ? await localRuntime(dir, undefined, "Uniform", extra) : undefined;
  const run = (stop: boolean) => {
    const options = { ...taskOptions(taskId), onStage(stage: string, output: any) {
      if (stop && stage === "save" && output.save.output[0].metadata.turn === 2) throw new Error("review turn two interruption");
    } };
    return direct ? runDirectTask(direct, task, options) : runTask(graph!.runtime, task, { ...options, bindings: graph!.bindings, handles: graph!.handles });
  };
  try {
    await assert.rejects(run(true), /review turn two interruption/);
    const memory = mode === "Direct" ? dir : join(dir, "Memory"), files = await readdir(memory);
    assert.equal(files.length, 1);
    const interrupted = JSON.parse(await readFile(join(memory, files[0]), "utf8"));
    assert.equal(interrupted.memories.length, 2);
    for (let n = 0; n < 2; n++) {
      const result = await run(false); assert.equal(result.executionOutcome, "completed");
      const saved = JSON.parse(await readFile(join(memory, files[0]), "utf8"));
      assert.equal(saved.memories.length, task.question.length); assert.notEqual(saved.memories[0].id, interrupted.memories[0].id);
    }
    console.log(JSON.stringify({ independent: true, dir, mode, sameInstanceRestarts: 2, completedTurns: task.question.length }));
  } finally { if (direct) await direct.dispose(); else await graph!.runtime.close(); }
});

for (const mode of ["Direct", "Uniform"] as const) for (const fault of [false, true]) test(`independent M2 whole ${mode} task cancellation, post-abort ${fault ? "egress failure" : "settlement and another complete config"}`, async () => {
  const dir = await root(), config = await loadEgressConfig("config/egress.offline.json", "live");
  config.retryPolicy.maxRetries = 0;
  let release!: () => void, arrived!: () => void, requests = 0;
  const gate = new Promise<void>(r => release = r), ready = new Promise<void>(r => arrived = r);
  const remote = await fakeServer((_body, res) => { const first = ++requests === 1; if (first) arrived();
    void (first ? gate : Promise.resolve()).then(() => res.end(fault ? "invalid JSON from fake upstream" : JSON.stringify(mockResponse({ message: { role: "assistant", content: "done" }, finishReason: "stop" }, "deepseek-flash", "chat-completions", 0)))); });
  const egress = await startEgress(config, join(dir, "egress"), { testUrl: remote.url });
  let disconnected = 0;
  egress.server.on("request", (_req, res) => res.once("close", () => { if (!res.writableEnded) disconnected++; }));
  const direct = mode === "Direct" ? createDirectSteps({ python, memoryDirectory: join(dir, "first"), inferenceTimeoutMs: 10000, modelEndpoint: egress.url }) : undefined;
  const graph = mode === "Uniform" ? await localRuntime(join(dir, "first"), egress.url, "Uniform") : undefined;
  const task = await loadTask("multi_turn_base_0"), ctrl = new AbortController();
  const options = { ...taskOptions("review/first/" + task.id), configId: "first", signal: ctrl.signal };
  let completed = false;
  const pending = (direct ? runDirectTask(direct, task, options) : runTask(graph!.runtime, task, { ...options, bindings: graph!.bindings, handles: graph!.handles }))
    .then(value => { completed = true; return { value, error: undefined }; }, error => { completed = true; return { value: undefined, error }; });
  try {
    await ready; ctrl.abort(new Error("review task cancelled")); await sleep(80);
    assert.equal(disconnected, 0); assert.equal(completed, false, "whole task must wait for billed request settlement");
    release(); const first = await pending; assert(first.error); assert.equal(disconnected, 0);
    console.log(JSON.stringify({ independent: true, dir, mode, fault, firstError: String(first.error), ledger: egress.gateway.ledger.snapshot(), disconnected }));
    if (fault) {
      assert.equal(egress.gateway.stopped, true); await access(join(dir, "egress", "stopped.json"));
      assert.match(String(first.error), /BFCL_RUN_STOP:/, "cancellation must not swallow egress or unknown-cost failure");
    } else {
      assert.equal(egress.gateway.ledger.snapshot().settled, 1);
      await assert.rejects(access(join(dir, "egress", "stopped.json")));
      const other = await localRuntime(join(dir, "other"), egress.url, "Uniform");
      try {
        const second = await runTask(other.runtime, task, { ...taskOptions("review/other/" + task.id), configId: "other", bindings: other.bindings, handles: other.handles });
        assert.equal(second.executionOutcome, "completed"); assert.equal(second.completedTurns, task.question.length);
        assert.equal(egress.gateway.ledger.snapshot().settled, task.question.length + 1);
        assert.equal(disconnected, 0); await assert.rejects(access(join(dir, "egress", "stopped.json")));
        console.log(JSON.stringify({ independent: true, dir, mode, nextConfigCompleted: true, completedTurns: second.completedTurns, ledger: egress.gateway.ledger.snapshot() }));
      } finally { await other.runtime.close(); }
    }
  } finally {
    release(); await pending;
    if (direct) await direct.dispose(); else await graph!.runtime.close();
    await egress.close(); await remote.close();
  }
});
