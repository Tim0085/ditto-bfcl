// 来源：Ditto v0.1.5 d95ded5；复制官方处理代码，差异见交付说明。
import { modelOutputFailureDetails } from "./bfcl-output-failure.ts";
import { createNodeScaffold } from "../../vendor/ditto/dist/worker/node-scaffold.js";
import type { InferExecution } from "../../vendor/ditto/dist/worker/infer/execution.js";
import type { SampleInput, SampleOutput } from "../../vendor/ditto/dist/worker/infer/reasoning/sample/types.js";
import { validateSample, validateSampleOutput } from "../../vendor/ditto/dist/worker/infer/reasoning/sample/schema.js";
import { abortable, InferError } from "../../vendor/ditto/dist/worker/infer/validation.js";
export async function sampleNode(input: SampleInput, ctx: InferExecution): Promise<SampleOutput> {
  validateSample(input);
  if (ctx.defaults?.generation) input = { ...input, generation: { ...ctx.defaults.generation, ...input.generation } };
  const name = "configured";
  const provider = ctx.providers.get(name);
  let output: SampleOutput | undefined;
  if (ctx.streaming && provider.stream) {
    const iterator = provider.stream(input, { signal: ctx.signal })[Symbol.asyncIterator]();
    try {
      for (;;) {
        const next = await abortable(() => iterator.next(), ctx.signal);
        if (next.done) break;
        if (output) throw new InferError("INVALID_MODEL_OUTPUT", "Provider emitted after terminal result");
        if (next.value.type === "text_delta" && typeof next.value.delta === "string") ctx.emitDelta(next.value.delta);
        else if ((next.value.type === "reasoning_delta" || next.value.type === "action_delta") && typeof next.value.delta === "string") {
          // Progress is observable on ModelProvider, but is not public answer text.
          if (next.value.type === "action_delta" && (!Number.isSafeInteger(next.value.index) || next.value.index < 0)) throw new InferError("INVALID_MODEL_OUTPUT", "Invalid action delta index");
        }
        else if (next.value.type === "result") output = next.value.output;
        else throw new InferError("INVALID_MODEL_OUTPUT", "Unknown provider stream event");
      }
    } finally { if (iterator.return) void Promise.resolve(iterator.return()).catch(() => {}); }
  } else {
    output = await abortable(() => provider.invoke(input, { signal: ctx.signal }), ctx.signal);
    if (ctx.streaming && typeof output?.message?.content === "string") ctx.emitDelta(output.message.content);
  }
  validateSampleOutput(output);
  if (output.finishReason === "cancelled") throw new InferError("CANCELLED", "Model generation cancelled");
  if (output.finishReason === "error" && modelOutputFailureDetails(output)) return output;
  if (output.finishReason === "error") throw new InferError("MODEL_ERROR", "Model generation failed");
  const actions = output.actionRequests?.map(request => {
    // Routing comes only from the caller's descriptors, never the model response.
    return { id: request.id, name: request.name, arguments: request.arguments };
  });
  return { message: output.message, finishReason: output.finishReason,
    ...(output.usage ? { usage: output.usage } : {}), ...(actions?.length ? { actionRequests: actions } : {}) };
}

export const inferSampleNode = createNodeScaffold("INFER.REASONING.SAMPLE");
