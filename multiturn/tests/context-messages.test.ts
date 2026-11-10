import assert from "node:assert/strict";
import test from "node:test";
import type { ContextItem, MessagePart, Observation } from "@codesoul-co/ditto/contracts";
import type { ActionRequest, Message } from "@codesoul-co/ditto/worker/infer";
import { compressNode, createContextExecution, loadNode, updateNode } from "@codesoul-co/ditto/worker/context";
import { assertWireSafe, observationToIngress, toContextItems, toModelMessages } from "../src/ts/context-messages.ts";
import type { ModelMessage } from "../src/ts/context-messages.ts";

const options = { turn: 1, startStep: 0 };
const request = (id: string): ActionRequest => ({ id, name: "lookup", arguments: { query: id, nested: [1, null, true] } });
function toolConversation(count: number): Message[] {
  const requests = Array.from({ length: count }, (_, i) => request(`call-${i + 1}`));
  return [
    { role: "assistant", content: "", metadata: { actionRequests: requests } },
    ...requests.map(action => ({ role: "tool" as const, content: `result ${action.id}`, metadata: { actionRequestId: action.id, name: action.name } })),
  ];
}
const observation = (id = "call-1"): Observation => ({
  callId: id, source: "lookup", status: "success",
  message: { role: "tool", name: "lookup", content: "found" },
});

test("system/user/assistant text round trip preserves exact whitespace and metadata", () => {
  const messages: Message[] = [
    { role: "system", content: " Keep\r\nthis. " },
    { role: "user", content: "你好\n", metadata: {} },
    { role: "assistant", content: "\tYes.\n", metadata: { actionRequests: [] } },
  ];
  assertWireSafe(messages);
  assert.deepStrictEqual(toModelMessages(toContextItems(messages, options)), messages);
});

test("two consecutive identical yes messages survive real Context LOAD and UPDATE", async () => {
  const messages: Message[] = [{ role: "user", content: "yes" }, { role: "user", content: "yes" }];
  const items = toContextItems(messages, options);
  assert.deepStrictEqual(items.map(item => item.id), ["turn-1-step-0-user", "turn-1-step-1-user"]);
  const execution = createContextExecution();
  const loaded = await loadNode({ sources: [items[0]] }, execution);
  const updated = await updateNode({ context: loaded, add: [items[1]] }, execution);
  assert.equal(updated.items.length, 2);
  assert.deepStrictEqual(toModelMessages(updated.items), messages);
});

test("explicit step offsets keep incremental batches unique within a turn", () => {
  const messages: Message[] = [{ role: "user", content: "yes" }];
  const first = toContextItems(messages, options);
  const next = toContextItems(messages, { turn: 1, startStep: first.length });
  const otherTurn = toContextItems(messages, { turn: 2, startStep: 0 });
  assert.equal(new Set([...first, ...next, ...otherTurn].map(item => item.id)).size, 3);
  for (const bad of [{ turn: -1, startStep: 0 }, { turn: 1, startStep: 0.5 }, { turn: 1, startStep: Number.MAX_SAFE_INTEGER }]) {
    assert.throws(() => toContextItems(messages, bad), /safe integer/);
  }
});

test("one assistant tool call and result round trip with matching ids and callId", () => {
  const messages = toolConversation(1);
  const items = toContextItems(messages, options);
  assertWireSafe(messages);
  assert.deepStrictEqual(items.map(item => item.metadata?.callId), ["call-1", "call-1"]);
  assert.deepStrictEqual(items[0].metadata?.actionRequests, messages[0].metadata?.actionRequests);
  assert.equal(items[1].metadata?.actionRequestId, "call-1");
  assert.deepStrictEqual(toModelMessages(items), messages);
});

test("three calls retain individual result ids and one atomic compression group", async () => {
  const messages = toolConversation(3);
  const items = toContextItems(messages, options);
  assertWireSafe(messages);
  assert.deepStrictEqual(items.map(item => item.metadata?.callId), Array(4).fill("call-1"));
  assert.deepStrictEqual(items.slice(1).map(item => item.metadata?.actionRequestId), ["call-1", "call-2", "call-3"]);
  assert.deepStrictEqual(toModelMessages(items), messages);
  const execution = createContextExecution();
  const kept = await compressNode({ context: { items }, maxItems: 4 }, execution);
  assert.deepStrictEqual(toModelMessages(kept.items), messages);
  const removed = await compressNode({ context: { items }, maxItems: 3 }, execution);
  assert.equal(removed.items.length, 0, "the real compressor must not leave a partial tool group");
});

test("assertWireSafe accepts text-only assistants without adding defaults", () => {
  for (const message of [{ role: "assistant", content: "done" }, { role: "assistant", content: "done", metadata: undefined },
    { role: "assistant", content: "done", metadata: {} }] satisfies Message[]) {
    const before = structuredClone(message);
    assert.doesNotThrow(() => assertWireSafe([message]));
    assert.deepStrictEqual(message, before);
  }
});

test("assistant actionRequests must have valid structure whenever present", () => {
  for (const actionRequests of [{ id: "a", name: "lookup", arguments: {} }, [request("a"), null]]) {
    const message: Message = { role: "assistant", content: "", metadata: { actionRequests } };
    const before = structuredClone(message);
    assert.throws(() => assertWireSafe([message]), /metadata\.actionRequests/);
    assert.deepStrictEqual(message, before);
  }
});

test("complete tool history ending in a text-only assistant is wire-safe", () => {
  const messages: Message[] = [{ role: "system", content: "help" }, { role: "user", content: "move the file" },
    ...toolConversation(1), { role: "assistant", content: "Done, the file is moved." }];
  const before = structuredClone(messages);
  assert.doesNotThrow(() => assertWireSafe(messages));
  const restored = toModelMessages(toContextItems(messages, options));
  assert.doesNotThrow(() => assertWireSafe(restored));
  assert.deepStrictEqual(restored, before);
  assert.deepStrictEqual(messages, before);
});

test("assertWireSafe rejects missing tool actionRequestId without adding defaults", () => {
  for (const message of [{ role: "tool", content: "done" }, { role: "tool", content: "done", metadata: {} }] satisfies Message[]) {
    const before = structuredClone(message);
    assert.throws(() => assertWireSafe([message]), /messages\[0\].*tool.*metadata\.actionRequestId/);
    assert.deepStrictEqual(message, before);
  }
});

test("observationToIngress writes the actual request id and the supplied callId", async () => {
  const obs = observation();
  const before = structuredClone(obs);
  const ingress = observationToIngress(obs, "call-1");
  assert.equal(ingress.sourceNode, "INTERACTION.OBSERVE");
  assert.equal(ingress.metadata?.callId, "call-1");
  assert.equal(ingress.metadata?.actionRequestId, "call-1");
  const items = toContextItems(toolConversation(1).slice(0, 1), options);
  const updated = await updateNode({ context: { items }, ingress: [ingress] }, createContextExecution());
  const messages = toModelMessages(updated.items).slice(1);
  assert.deepStrictEqual(messages, [{ role: "tool", content: "found", metadata: { name: "lookup", actionRequestId: "call-1", callId: "call-1" } }]);
  assertWireSafe([toolConversation(1)[0], ...messages]);
  assert.deepStrictEqual(obs, before);
});

test("three separate observation ingresses join their assistant compression group", async () => {
  const items = toContextItems(toolConversation(3).slice(0, 1), options);
  const groupId = items[0].metadata!.callId as string;
  const ingress = ["call-1", "call-2", "call-3"].map(id => observationToIngress(observation(id), groupId));
  assert.equal(new Set(ingress.map(entry => entry.id)).size, 3);
  const execution = createContextExecution();
  const updated = await updateNode({ context: { items }, ingress }, execution);
  assert.deepStrictEqual(updated.items.map(item => item.metadata?.callId), Array(4).fill(groupId));
  assert.deepStrictEqual(toModelMessages(updated.items).slice(1).map(message => message.metadata?.actionRequestId), ["call-1", "call-2", "call-3"]);
  assert.equal((await compressNode({ context: updated, maxItems: 3 }, execution)).items.length, 0);
});

test("observation ids with hyphens, colons, and escapes cannot collide in real UPDATE", async () => {
  const pairs = [["a-b", "c"], ["a", "b-c"], ["a:b", "c"], ["a", "b:c"], ["a%3Ab", "c"], ["你好", "c"]];
  const ingress = pairs.map(([group, action]) => observationToIngress(observation(action), group));
  assert.equal(new Set(ingress.map(entry => entry.id)).size, pairs.length);
  const updated = await updateNode({ context: { items: [] }, ingress }, createContextExecution());
  assert.equal(updated.items.length, pairs.length);
  // Each tuple is an independent conversation; restore it with its own request.
  const restored = updated.items.map((item, i) => {
    const [callId, id] = pairs[i];
    const items = toContextItems([{ role: "assistant", content: "", metadata: { callId, actionRequests: [request(id)] } }], options);
    return toModelMessages([...items, item])[1];
  });
  assert.deepStrictEqual(restored.map(message => [message.metadata?.callId, message.metadata?.actionRequestId]), pairs);
});

test("structured message arrays and observation MessageParts stay arrays", () => {
  const parts: MessagePart[] = [
    { type: "text", text: "\nexact " },
    { type: "json", data: { result: [1, false, null], text: "你好" } },
    { type: "reference", reference: { uri: "local:fixture", mediaType: "text/plain" } },
  ];
  const messages: Message[] = [{ role: "user", content: parts }, { role: "assistant", content: [], metadata: { actionRequests: [] } }];
  assert.deepStrictEqual(toModelMessages(toContextItems(messages, options)), messages);
  const ingress = observationToIngress({ ...observation(), message: { role: "tool", content: parts } }, "call-1");
  assert.deepStrictEqual(ingress.content, parts);
  const requestItems = toContextItems(toolConversation(1).slice(0, 1), options);
  assert.deepStrictEqual(toModelMessages([...requestItems, ingress])[1].content, parts);
});

test("all original metadata survives reserved-key collisions and JSON persistence", () => {
  const messages = toolConversation(1);
  messages[0].metadata = { ...messages[0].metadata, callId: "group-A", role: "original-value", sourceNode: "original-node",
    dittoModelMessage: { userOwned: true }, provider: "openai-compatible", reasoningContent: " keep\n", nested: { x: [true, 2, null] } };
  messages[1].metadata!.callId = "group-A";
  const items = toContextItems(messages, options);
  assert.equal(items[0].metadata?.role, "assistant");
  assert.deepStrictEqual(items.map(item => item.metadata?.callId), ["group-A", "group-A"]);
  assert.deepStrictEqual(toModelMessages(JSON.parse(JSON.stringify(items))), messages);
});

test("metadata absence, explicit undefined, and empty object stay distinct", () => {
  const messages: Message[] = [
    { role: "user", content: "a" },
    { role: "user", content: "b", metadata: undefined },
    { role: "user", content: "c", metadata: {} },
  ];
  assert.deepStrictEqual(toModelMessages(JSON.parse(JSON.stringify(toContextItems(messages, options)))), messages);
});

test("legal text-only assistant round trips unchanged and passes the wire gate", () => {
  // A final text-only assistant is legal; absence of actionRequests is preserved.
  const messages: Message[] = [{ role: "assistant", content: "historical final", metadata: { reasoningContent: "old" } }];
  const restored = toModelMessages(toContextItems(messages, options));
  assert.deepStrictEqual(restored, messages);
  assert.doesNotThrow(() => assertWireSafe(restored));
  assert.equal(Object.hasOwn(restored[0].metadata!, "actionRequests"), false);
});

test("conversion snapshots do not alias or mutate input content and metadata", () => {
  const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "before" }], metadata: { nested: { value: 1 } } }];
  const before = structuredClone(messages);
  const items = toContextItems(messages, options);
  const restored = toModelMessages(items);
  (restored[0].content as { text: string }[])[0].text = "changed";
  (restored[0].metadata!.nested as { value: number }).value = 99;
  assert.deepStrictEqual(messages, before);
  assert.deepStrictEqual(toModelMessages(items), before);
});

test("mismatched, orphaned, and duplicate tool results are rejected", () => {
  const messages = toolConversation(1);
  const mismatch = structuredClone(messages);
  mismatch[1].metadata!.actionRequestId = "wrong-id";
  assert.throws(() => toContextItems(mismatch, options), /actionRequestId.*no pending assistant/);
  assert.throws(() => toContextItems([messages[1], messages[0]], options), /no pending assistant/);
  assert.throws(() => toContextItems([...messages, messages[1]], options), /no pending assistant/);
});

test("toModelMessages itself rejects mismatched, orphaned, duplicate, and interrupted tool results", () => {
  const native: ContextItem[] = toolConversation(2).map((message, i) => ({
    id: `native-${i}`, content: message.content as ContextItem["content"], metadata: { role: message.role, ...message.metadata } as ContextItem["metadata"],
  }));
  const mismatch = structuredClone(native);
  (mismatch[1].metadata! as Record<string, unknown>).actionRequestId = "wrong-id";
  assert.throws(() => toModelMessages(mismatch), /actionRequestId wrong-id has no pending assistant/);
  assert.throws(() => toModelMessages(native.slice(1)), /no pending assistant/);
  assert.throws(() => toModelMessages([...native, { ...native[1], id: "duplicate-result" }]), /no pending assistant/);
  assert.throws(() => toModelMessages([native[0], { id: "interrupt", content: "next", metadata: { role: "user" } }, ...native.slice(1)]),
    /before pending tool results/);
  assert.doesNotThrow(() => toModelMessages([native[0], ...native.slice(1).reverse()]));
  const wrapped = toContextItems(toolConversation(1), options);
  (wrapped[1].metadata! as Record<string, unknown>).actionRequestId = "wrong-id";
  (wrapped[1].metadata!.dittoModelMessage as { metadata: { actionRequestId: string } }).metadata.actionRequestId = "wrong-id";
  assert.throws(() => toModelMessages(wrapped), /actionRequestId wrong-id has no pending assistant/);
});

test("toModelMessages permits a pending trailing request but assertWireSafe requires its result", () => {
  const messages = toolConversation(1).slice(0, 1);
  const restored = toModelMessages(toContextItems(messages, options));
  assert.deepStrictEqual(restored, messages);
  assert.throws(() => assertWireSafe(restored), /missing tool results/);
});

test("toModelMessages rejects outer callId conflicts with original or derived groups", () => {
  for (const explicit of [false, true]) {
    const messages = toolConversation(2);
    if (explicit) for (const message of messages) message.metadata!.callId = "original-group";
    for (const index of [0, 1, 2]) {
      for (const remove of [false, true]) {
        const items = toContextItems(messages, options);
        const metadata = items[index].metadata! as Record<string, unknown>;
        if (remove) delete metadata.callId;
        else metadata.callId = "different-group";
        const before = structuredClone(items);
        assert.throws(() => toModelMessages(items), /metadata\.callId disagrees/);
        assert.deepStrictEqual(items, before);
      }
    }
  }
});

test("toModelMessages rejects outer actionRequestId conflicts with the original copy", () => {
  for (const remove of [false, true]) {
    const items = toContextItems(toolConversation(1), options);
    const metadata = items[1].metadata! as Record<string, unknown>;
    if (remove) delete metadata.actionRequestId;
    else metadata.actionRequestId = "different-action";
    const before = structuredClone(items);
    assert.throws(() => toModelMessages(items), /metadata\.actionRequestId disagrees/);
    assert.deepStrictEqual(items, before);
  }
});

test("top-level names and their absence survive round trips and JSON persistence", () => {
  const messages: ModelMessage[] = [{ role: "system", content: "help", name: "system-name" },
    { role: "user", content: "yes", name: "Alice", metadata: { name: "different-metadata-name" } },
    { role: "user", content: "yes", name: undefined }, { role: "user", content: "yes", name: "" },
    ...toolConversation(1).map((message, i) => ({ ...message, name: `tool-part-${i}` })),
    { role: "assistant", content: "done", name: "助手" }, { role: "user", content: "yes" }];
  const before = structuredClone(messages);
  assert.doesNotThrow(() => assertWireSafe(messages));
  const items = toContextItems(messages, options);
  assert.deepStrictEqual(toModelMessages(items), before);
  assert.deepStrictEqual(toModelMessages(JSON.parse(JSON.stringify(items))), before);
  assert.deepStrictEqual(messages, before);
  assert.throws(() => toContextItems([{ role: "user", content: "yes", name: 1 } as unknown as ModelMessage], options), /name must be a string/);
});

test("older version-1 envelopes without nameState remain readable", () => {
  const messages = toolConversation(1);
  const items = toContextItems(messages, options);
  for (const item of items) delete (item.metadata!.dittoModelMessage as Record<string, unknown>).nameState;
  assert.deepStrictEqual(toModelMessages(items), messages);
});

test("duplicate request ids and conflicting compression group ids are rejected", () => {
  const messages = toolConversation(1);
  const conflict = structuredClone(messages);
  conflict[1].metadata!.callId = "wrong-group";
  assert.throws(() => toContextItems(conflict, options), /callId disagrees/);
  assert.throws(() => toContextItems([...messages, ...messages], options), /reuses|duplicates/);
  const duplicate: Message = { role: "assistant", content: "", metadata: { actionRequests: [request("same"), request("same")] } };
  assert.throws(() => assertWireSafe([duplicate]), /duplicates/);
});

test("wire gate rejects missing, orphaned, duplicate, and interrupted tool result sequences", () => {
  const messages = toolConversation(3);
  assert.throws(() => assertWireSafe(messages.slice(0, 3)), /missing tool results.*call-3/);
  assert.throws(() => assertWireSafe(messages.slice(1)), /no pending assistant/);
  assert.throws(() => assertWireSafe([...messages, messages[1]]), /no pending assistant/);
  assert.throws(() => assertWireSafe([messages[0], { role: "user", content: "next" }, ...messages.slice(1)]), /before pending tool results/);
  const badGroup = structuredClone(messages);
  badGroup[2].metadata!.callId = "call-2";
  assert.throws(() => assertWireSafe(badGroup), /callId disagrees/);
  assert.doesNotThrow(() => assertWireSafe([messages[0], ...messages.slice(1).reverse()]));
});

test("wrong observation action ids cannot pass the complete-history wire gate", async () => {
  const items = toContextItems(toolConversation(1).slice(0, 1), options);
  const ingress = observationToIngress(observation("wrong-action"), "call-1");
  const updated = await updateNode({ context: { items }, ingress: [ingress] }, createContextExecution());
  assert.throws(() => assertWireSafe(toModelMessages(updated.items)), /actionRequestId wrong-action has no pending assistant/);
});

test("wire gate rejects malformed request arrays, ids, names, and arguments", () => {
  for (const value of [null, {}, "calls", [{ id: "", name: "lookup", arguments: {} }], [{ id: "x", name: "", arguments: {} }], [{ id: "x", name: "lookup", arguments: [] }]]) {
    assert.throws(() => assertWireSafe([{ role: "assistant", content: "", metadata: { actionRequests: value } }]), /actionRequests/);
  }
  for (const value of [null, 1, "", "   "]) {
    assert.throws(() => assertWireSafe([{ role: "tool", content: "", metadata: { actionRequestId: value } }]), /actionRequestId/);
  }
});

test("unsupported JSON values fail explicitly instead of being silently serialized away", () => {
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  for (const value of [undefined, NaN, Infinity, -0, 1n, () => 1, new Date(), cycle, [1, , 3]]) {
    assert.throws(() => toContextItems([{ role: "user", content: "x", metadata: { value } }], options), /JSON|cycle/);
  }
  assert.throws(() => toContextItems([{ role: "user", content: [undefined] }], options), /JSON/);
});

test("non-enumerable and accessor metadata properties are rejected before losing fields", () => {
  const hidden = Object.defineProperty({}, "hidden", { value: "keep me", enumerable: false });
  const getter = Object.defineProperty({}, "getter", { get() { throw new Error("must not invoke getter"); }, enumerable: true });
  for (const metadata of [hidden, getter]) {
    assert.throws(() => toContextItems([{ role: "user", content: "x", metadata }], options), /enumerable JSON data property/);
  }
});

test("sparse message and Context arrays are rejected instead of skipping entries", () => {
  const messages = Array<Message>(1);
  assert.throws(() => assertWireSafe(messages), /message object/);
  assert.throws(() => toContextItems(messages, options), /message object/);
  assert.throws(() => toModelMessages(Array<ContextItem>(1)), /ContextItem/);
});

test("native Context items restore role and reject invalid roles, scalar content, or duplicate ids", () => {
  const native: ContextItem[] = [{ id: "native", content: "hello", metadata: { role: "assistant", actionRequests: [], sourceType: "message" } }];
  assert.deepStrictEqual(toModelMessages(native), [{ role: "assistant", content: "hello", metadata: { actionRequests: [] } }]);
  assert.throws(() => toModelMessages([{ id: "x", content: "hello" }]), /metadata.*role/);
  assert.throws(() => toModelMessages([{ id: "x", content: "hello", metadata: { role: "unknown" } }]), /role/);
  assert.throws(() => toModelMessages([{ id: "x", content: { value: 1 }, metadata: { role: "tool", actionRequestId: "a" } }]), /content.*string or an array/);
  assert.throws(() => toModelMessages([...native, ...native]), /duplicates/);
});

test("observation rejects wrapped output, conflicting ids, empty group ids, and non-tool roles", () => {
  assert.throws(() => observationToIngress({ status: "success", output: observation() } as unknown as Observation, "x"), /bare INTERACTION.OBSERVE/);
  assert.throws(() => observationToIngress(observation(), ""), /callId/);
  assert.throws(() => observationToIngress({ ...observation(), metadata: { actionRequestId: "wrong" } }, "call-1"), /actionRequestId disagrees/);
  assert.throws(() => observationToIngress({ ...observation(), metadata: { callId: "wrong" } }, "call-1"), /callId disagrees/);
  assert.throws(() => observationToIngress({ ...observation(), message: { role: "user", content: "x" } }, "call-1"), /role must be tool/);
});

test("failed tool observations retain their error content and structured parts", () => {
  const obs: Observation = { ...observation(), status: "failed", error: { code: "MISSING", message: "not found" },
    message: { role: "tool", content: [{ type: "text", text: "failed: MISSING: not found" }, { type: "json", data: { retry: false } }] } };
  const items = toContextItems(toolConversation(1).slice(0, 1), options);
  assert.deepStrictEqual(toModelMessages([...items, observationToIngress(obs, "call-1")])[1].content, obs.message.content);
});

test("empty histories stay empty without inserting messages", () => {
  assert.deepStrictEqual(toContextItems([], options), []);
  assert.deepStrictEqual(toModelMessages([]), []);
  assert.doesNotThrow(() => assertWireSafe([]));
});
