import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import type { Message } from "@codesoul-co/ditto/worker/infer";
import { assertWireSafe, toContextItems, toModelMessages } from "../src/ts/context-messages.ts";

// Read one authorized file only. Never imports or executes the old experiment.
const path = process.argv[2] ? resolve(process.argv[2]) : fileURLToPath(new URL(
  "../../../bfcl_direct/runs/multiturn-full800-001/full/multi_turn_base/direct/direct-c1/tasks/multi_turn_base_1.json", import.meta.url,
));
const beforeStat = statSync(path, { bigint: true });
const before = readFileSync(path);
const task = JSON.parse(before.toString("utf8"));
assert.ok(Array.isArray(task.messages), "old trajectory must contain messages[]");
const messages = task.messages as Message[];
if (!process.argv[2]) assert.equal(messages.length, 31, "default real trajectory must contain exactly 31 messages");
const original = structuredClone(messages);
const items = toContextItems(messages, { turn: 0, startStep: 0 });
const restored = toModelMessages(items);
assert.deepStrictEqual(restored, original, "all message fields must round trip exactly");
assert.deepStrictEqual(messages, original, "input messages must not be mutated");
assert.equal(new Set(items.map(item => item.id)).size, messages.length);
assert.deepStrictEqual(toModelMessages(JSON.parse(JSON.stringify(items))), original, "Context JSON persistence must also be lossless");

let toolPairs = 0;
const calls = new Map<string, string>();
for (const item of items) {
  for (const action of (item.metadata?.actionRequests ?? []) as { id: string }[]) calls.set(action.id, item.metadata!.callId as string);
  if (item.metadata?.role === "tool") {
    const requestId = item.metadata.actionRequestId as string;
    assert.ok(calls.has(requestId), "tool must match an earlier assistant request");
    assert.equal(item.metadata.callId, calls.get(requestId));
    calls.delete(requestId);
    toolPairs++;
  }
}
assert.equal(calls.size, 0, "this complete trajectory must have no unanswered calls");

const missing = messages.flatMap((message, i) => message.role === "assistant" && message.metadata?.actionRequests === undefined ? [i] : []);
// Text-only assistants are legal. Accept them without inserting actionRequests.
if (!process.argv[2]) assert.deepStrictEqual(missing, [6, 20, 26, 30]);
for (const i of missing) {
  assert.doesNotThrow(() => assertWireSafe([restored[i]]));
  assert.equal(Object.hasOwn(restored[i].metadata ?? {}, "actionRequests"), false);
}
assert.doesNotThrow(() => assertWireSafe(messages), "the complete real history must be wire-safe");
assert.doesNotThrow(() => assertWireSafe(restored), "the complete restored real history must be wire-safe");
assert.deepStrictEqual(restored, original, "wire validation must not insert defaults or mutate messages");

assert.deepStrictEqual(readFileSync(path), before, "source bytes changed during verification");
const afterStat = statSync(path, { bigint: true });
assert.equal(afterStat.mtimeNs, beforeStat.mtimeNs, "source mtime changed during verification");
assert.equal(afterStat.size, beforeStat.size);
console.log(`Source: ${path}`);
console.log(`PASS: exact round trip of ${messages.length} messages, including all metadata`);
console.log(`PASS: ${items.length} distinct explicit Context ids`);
console.log(`PASS: ${toolPairs} tool request/result pairs with matching callId`);
console.log("PASS: JSON-persisted Context round trip and input immutability");
console.log(`Text-only assistants without actionRequests (zero-based): ${missing.join(", ") || "none"}`);
console.log(`PASS: assertWireSafe accepts all ${missing.length} text-only assistants; no defaults added`);
console.log(`PASS: assertWireSafe accepts the complete real ${messages.length}-message history (original and restored)`);
console.log(`PASS: source bytes/mtime unchanged; SHA-256 ${createHash("sha256").update(before).digest("hex")}`);
