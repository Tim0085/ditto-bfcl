// 来源：experiments/bfcl_direct/src/ts/mock.ts；T5：保持原逻辑；相邻模块来自本目录的独立副本。
import type { SampleOutput } from "./types.ts";
import type { WireObject } from "./model.ts";
export function mockResponse(output: SampleOutput, model: string, protocol: string, index: number): WireObject {
  const calls = output.actionRequests ?? [];
  const inputTokens = 1200 + 100 * index, outputTokens = 120;
  if (protocol === "responses") return {
    id: `response-${index}`, model, status: "completed",
    output: [{ type: "reasoning", id: `reason-${index}`, summary: [], encrypted_content: `offline-reasoning-${index}` },
      ...(calls.length ? calls.map(call => ({ type: "function_call", id: `item-${call.id}`, status: "completed",
        call_id: call.id, name: call.name, arguments: JSON.stringify(call.arguments) }))
        : [{ type: "message", id: `message-${index}`, status: "completed", role: "assistant", phase: "final_answer",
          content: [{ type: "output_text", text: output.message.content, annotations: [] }] }])],
    usage: { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens,
      input_tokens_details: { cached_tokens: 200 }, output_tokens_details: { reasoning_tokens: 100 } },
  };
  return { id: `chat-${index}`, model, choices: [{ index: 0, finish_reason: calls.length ? "tool_calls" : "stop",
    message: { role: "assistant", content: output.message.content, reasoning_content: `offline reasoning ${index}`,
      ...(calls.length ? { tool_calls: calls.map(call => ({ id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) } : {}) } }],
    usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens,
      prompt_cache_hit_tokens: 200, completion_tokens_details: { reasoning_tokens: 100 } } };
}

