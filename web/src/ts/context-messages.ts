import type { ContextIngress, ContextItem, JsonObject, JsonValue, Observation } from "@codesoul-co/ditto/contracts";
import type { ActionRequest, Message } from "@codesoul-co/ditto/worker/infer";

/** Preserve the optional model message name without modifying Ditto's types. */
export interface ModelMessage extends Message {
  name?: string;
}

export interface ContextMessageOptions {
  /** The caller owns the turn number and advances startStep by the batch length. */
  turn: number;
  startStep: number;
}

const envelopeKey = "dittoModelMessage";

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown, path: string): asserts value is string {
  check(typeof value === "string" && value.trim().length > 0, `${path} must be a non-empty string`);
}

// Context metadata is JSON, unlike infer.Message's unknown values. Reject values
// that serialization would silently drop or change, instead of stringifying them.
function json(value: unknown, path: string, ancestors = new Set<object>()): asserts value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    check(Number.isFinite(value) && !Object.is(value, -0), `${path} must be a finite JSON number without negative zero`);
    return;
  }
  check(typeof value === "object" && value !== null, `${path} must be JSON-compatible`);
  check(!ancestors.has(value), `${path} contains a cycle`);
  check(Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null,
    `${path} must be a plain JSON object or array`);
  check(Object.getOwnPropertySymbols(value).length === 0, `${path} must not contain symbol keys`);
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (Array.isArray(value) && key === "length") continue;
    check(descriptor.enumerable && Object.hasOwn(descriptor, "value"), `${path}.${key} must be an enumerable JSON data property`);
  }
  ancestors.add(value);
  if (Array.isArray(value)) {
    check(Object.keys(value).length === value.length, `${path} must be a dense JSON array without extra properties`);
    for (let i = 0; i < value.length; i++) json(value[i], `${path}[${i}]`, ancestors);
  } else {
    for (const [key, child] of Object.entries(value)) json(child, `${path}.${key}`, ancestors);
  }
  ancestors.delete(value);
}

function content(value: unknown, path: string): asserts value is Message["content"] {
  check(typeof value === "string" || Array.isArray(value), `${path} must be a string or an array`);
  json(value, path);
}

function role(value: unknown, path: string): asserts value is Message["role"] {
  check(value === "system" || value === "user" || value === "assistant" || value === "tool", `${path} is not a supported message role`);
}

function actions(value: unknown, path: string): asserts value is ActionRequest[] {
  check(Array.isArray(value), `${path} must be an array`);
  const ids = new Set<string>();
  for (const [i, action] of value.entries()) {
    check(record(action), `${path}[${i}] must be an object`);
    text(action.id, `${path}[${i}].id`);
    text(action.name, `${path}[${i}].name`);
    check(record(action.arguments), `${path}[${i}].arguments must be an object`);
    check(!ids.has(action.id), `${path}[${i}].id duplicates an action request id`);
    ids.add(action.id);
  }
}

function validateMessage(message: ModelMessage, path: string): void {
  check(record(message), `${path} must be a message object`);
  role(message.role, `${path}.role`);
  content(message.content, `${path}.content`);
  if (message.name !== undefined) check(typeof message.name === "string", `${path}.name must be a string`);
  if (message.metadata !== undefined) {
    check(record(message.metadata), `${path}.metadata must be an object`);
    json(message.metadata, `${path}.metadata`);
  }
  if (message.role === "assistant" && message.metadata?.actionRequests !== undefined) {
    actions(message.metadata?.actionRequests, `${path} (assistant) metadata.actionRequests`);
  }
  if (message.role === "tool") text(message.metadata?.actionRequestId, `${path} (tool) metadata.actionRequestId`);
}

/** Validate a complete history before inference. Never fills fields or results. */
export function assertWireSafe(messages: readonly ModelMessage[]): void {
  check(Array.isArray(messages), "messages must be an array");
  for (const [index, message] of messages.entries()) validateMessage(message, `messages[${index}]`);
  callGroups(messages, true);
}

function contextMetadata(message: ModelMessage, callId?: string): JsonObject {
  const original = message.metadata;
  return structuredClone({
    role: message.role,
    ...(original?.actionRequests === undefined ? {} : { actionRequests: original.actionRequests }),
    ...(original?.actionRequestId === undefined ? {} : { actionRequestId: original.actionRequestId }),
    ...(callId === undefined ? {} : { callId }),
    // Keep original metadata separately: Context's role/callId/sourceNode must
    // not leak into the next model request or overwrite identically named keys.
    [envelopeKey]: {
      version: 1,
      nameState: !Object.hasOwn(message, "name") ? "absent" : message.name === undefined ? "undefined" : "present",
      ...(message.name === undefined ? {} : { name: message.name }),
      metadataState: !Object.hasOwn(message, "metadata") ? "absent" : original === undefined ? "undefined" : "present",
      ...(original === undefined ? {} : { metadata: original }),
    },
  }) as JsonObject;
}

function callGroups(messages: readonly Message[], requireComplete: boolean): (string | undefined)[] {
  const pending = new Map<string, string>();
  const seen = new Set<string>();
  const groups = new Set<string>();
  const result = Array.from(messages, (message, index) => {
    check(message.role === "tool" || pending.size === 0,
      `messages[${index}] arrives before pending tool results with metadata.actionRequestId: ${[...pending.keys()].join(", ")}`);
    let callId: string | undefined;
    if (message.role === "assistant") {
      const requests = message.metadata?.actionRequests as ActionRequest[] | undefined;
      if (requests?.length) {
        callId = (message.metadata?.callId === undefined ? requests[0].id : message.metadata.callId) as string;
        text(callId, `messages[${index}] metadata.callId`);
        check(!groups.has(callId), `messages[${index}] reuses another assistant's metadata.callId`);
        groups.add(callId);
        for (const request of requests) {
          check(!seen.has(request.id), `messages[${index}] duplicates actionRequests id ${request.id}`);
          seen.add(request.id);
          pending.set(request.id, callId);
        }
      }
    } else if (message.role === "tool") {
      const actionId = message.metadata!.actionRequestId as string;
      callId = pending.get(actionId);
      check(callId !== undefined, `messages[${index}] metadata.actionRequestId ${actionId} has no pending assistant actionRequests id`);
      check(message.metadata?.callId === undefined || message.metadata.callId === callId,
        `messages[${index}] metadata.callId disagrees with its assistant tool group`);
      pending.delete(actionId);
    }
    return callId;
  });
  check(!requireComplete || pending.size === 0,
    `messages are missing tool results with metadata.actionRequestId: ${[...pending.keys()].join(", ")}`);
  return result;
}

/**
 * Lossless storage conversion. Text-only assistants without actionRequests are
 * legal and remain unchanged. Only the inference gate requires all results.
 * Tool results in this batch must follow their assistant request. For results
 * appended later, use observationToIngress with the assistant item's callId.
 */
export function toContextItems(messages: readonly ModelMessage[], options: ContextMessageOptions): ContextItem[] {
  check(Array.isArray(messages), "messages must be an array");
  for (const key of ["turn", "startStep"] as const) {
    check(Number.isSafeInteger(options?.[key]) && options[key] >= 0, `options.${key} must be a non-negative safe integer`);
  }
  check(Number.isSafeInteger(options.startStep + messages.length), "message step numbers exceed the safe integer range");
  for (const [index, message] of messages.entries()) validateMessage(message, `messages[${index}]`);
  const groups = callGroups(messages, false);
  return Array.from(messages, (message, index) => {
    // One assistant has only one Context callId. All results of a multi-call
    // assistant share it; actionRequestId still identifies each individual call.
    return {
      id: `turn-${options.turn}-step-${options.startStep + index}-${message.role}`,
      content: structuredClone(message.content) as ContextItem["content"],
      metadata: contextMetadata(message, groups[index]),
    };
  });
}

/** Restore a history with validated tool links; a trailing request may await results. */
export function toModelMessages(items: readonly ContextItem[]): ModelMessage[] {
  check(Array.isArray(items), "items must be an array");
  const ids = new Set<string>();
  const messages = Array.from(items, (item, index) => {
    check(record(item), `items[${index}] must be a ContextItem`);
    text(item.id, `items[${index}].id`);
    check(!ids.has(item.id), `items[${index}].id duplicates another Context item`);
    ids.add(item.id);
    const metadata = item.metadata;
    check(record(metadata), `items[${index}].metadata must contain role`);
    json(metadata, `items[${index}].metadata`);
    role(metadata.role, `items[${index}].metadata.role`);
    content(item.content, `items[${index}].content`);
    const message: ModelMessage = { role: metadata.role, content: structuredClone(item.content) };
    if (Object.hasOwn(metadata, envelopeKey)) {
      const envelope = metadata[envelopeKey];
      check(record(envelope) && envelope.version === 1, `items[${index}] has an invalid ${envelopeKey} envelope`);
      if (envelope.nameState === "present") {
        check(typeof envelope.name === "string", `items[${index}] lost original model name`);
        message.name = envelope.name;
      } else {
        // Older version-1 envelopes have no nameState and represent no name.
        check(envelope.nameState === undefined || envelope.nameState === "absent" || envelope.nameState === "undefined",
          `items[${index}] has an invalid nameState`);
        check(!Object.hasOwn(envelope, "name"), `items[${index}] has conflicting original model name`);
        if (envelope.nameState === "undefined") message.name = undefined;
      }
      if (envelope.metadataState === "present") {
        check(record(envelope.metadata), `items[${index}] lost original model metadata`);
        message.metadata = structuredClone(envelope.metadata);
      } else {
        check(envelope.metadataState === "absent" || envelope.metadataState === "undefined", `items[${index}] has an invalid metadataState`);
        check(!Object.hasOwn(envelope, "metadata"), `items[${index}] has conflicting original model metadata`);
        if (envelope.metadataState === "undefined") message.metadata = undefined;
      }
    } else {
      // Native Context entries follow the official metadata.role convention.
      const { role: _role, sourceNode: _node, sourceType: _type, ...modelMetadata } = metadata;
      if (Object.keys(modelMetadata).length) message.metadata = structuredClone(modelMetadata);
    }
    validateMessage(message, `items[${index}] restored message`);
    return message;
  });
  const groups = callGroups(messages, false);
  for (const [index, item] of items.entries()) {
    const metadata = item.metadata!;
    if (Object.hasOwn(metadata, envelopeKey)) {
      check(metadata.actionRequestId === messages[index].metadata?.actionRequestId,
        `items[${index}] metadata.actionRequestId disagrees with original model metadata`);
      // callId may be generated from the request id when the original has none.
      // Compare against the restored history's group, never trust one copy alone.
      check(metadata.callId === groups[index],
        `items[${index}] metadata.callId disagrees with original model tool group`);
    }
  }
  return messages;
}

/**
 * Accept the bare INTERACTION.OBSERVE result, never an Infer {status, output}.
 * callId is the assistant item's compression group; observation.callId is the
 * actual actionRequestId (they differ for later calls of a multi-call assistant).
 */
export function observationToIngress(observation: Observation, callId: string): ContextIngress {
  text(callId, "callId");
  check(record(observation) && record(observation.message), "observation must be the bare INTERACTION.OBSERVE result with message");
  text(observation.callId, "observation.callId");
  check(observation.message.role === "tool", "observation.message.role must be tool");
  content(observation.message.content, "observation.message.content");
  if (observation.metadata !== undefined) {
    check(record(observation.metadata), "observation.metadata must be an object");
    json(observation.metadata, "observation.metadata");
    check(observation.metadata.actionRequestId === undefined || observation.metadata.actionRequestId === observation.callId,
      "observation.metadata.actionRequestId disagrees with observation.callId");
    check(observation.metadata.callId === undefined || observation.metadata.callId === callId,
      "observation.metadata.callId disagrees with the assistant tool group");
  }
  const message: Message = {
    role: "tool",
    content: observation.message.content,
    metadata: {
      ...observation.metadata,
      ...(observation.message.name === undefined ? {} : { name: observation.message.name }),
      actionRequestId: observation.callId,
      callId,
    },
  };
  // This is one result fragment. assertWireSafe checks it against the assistant
  // only after the caller has assembled the complete history for inference.
  validateMessage(message, "observation tool message");
  return {
    // ':' is escaped within both components, so distinct tuples cannot collide.
    id: `observation-${encodeURIComponent(callId)}:${encodeURIComponent(observation.callId)}`,
    sourceNode: "INTERACTION.OBSERVE",
    content: structuredClone(message.content) as ContextItem["content"],
    metadata: contextMetadata(message, callId),
  };
}
