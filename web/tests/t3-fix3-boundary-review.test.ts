import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runTask } from "../src/ts/task-loop.ts";
import { loadTask } from "../src/ts/tool-actions.ts";
import { localRuntime, taskOptions } from "./t4-helpers.ts";
import { fakeServer, sampleOutput } from "./t7-helpers.ts";

for (const where of ["before-open", "between-graphs", "after-select-before-sample", "during-tool"] as const) test(`independent cancellation boundary ${where}`, async () => {
  const dir = await mkdtemp(join(process.env.T3_FIX3_EVIDENCE ?? tmpdir(), "boundary-")), ctrl = new AbortController();
  let requests = 0, toolSignals = 0;
  const server = await fakeServer((_body, res) => { requests++; res.end(JSON.stringify({ ok: true, output: requests === 1 && where === "during-tool" ? {
    message: { role: "assistant", content: "" }, finishReason: "action_request", actionRequests: [{ id: "review-tool", name: "pwd", arguments: {} }], usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
  } : sampleOutput })); });
  const graph = await localRuntime(dir, server.url, "Uniform", {}, (node, input, result) => {
    if (where === "after-select-before-sample" && node === "CONTEXT.SELECT") ctrl.abort(new Error("review select boundary cancellation"));
    if (where === "during-tool" && node === "INTERACTION.ACT.TOOL" && input.call.arguments.request?.action === "call") { toolSignals++; ctrl.abort(new Error("review tool cancellation")); }
    return result;
  });
  const task = await loadTask("multi_turn_base_0"), taskId = "review/boundary/" + where;
  try {
    if (where === "before-open") ctrl.abort(new Error("review preflight cancellation"));
    await assert.rejects(runTask(graph.runtime, task, { ...taskOptions(taskId), signal: ctrl.signal, bindings: graph.bindings, handles: graph.handles,
      onStage(stage) { if (where === "between-graphs" && stage === "open") ctrl.abort(new Error("review between graph cancellation")); },
    }), /cancel/);
    if (where === "during-tool") { assert.equal(toolSignals, 1); assert.equal(requests, 1); }
    else assert.equal(requests, 0, "no model request may start after cancellation before SAMPLE");
    for (const handle of graph.handles.values()) assert.deepEqual(await handle.releaseTask(taskId), { contextDeleted: false, pythonReleased: false });
    console.log(JSON.stringify({ independent: true, dir, where, requests, cleanupComplete: true }));
  } finally { await graph.runtime.close(); await server.close(); }
});
