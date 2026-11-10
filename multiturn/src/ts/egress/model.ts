// 来源：experiments/bfcl_direct/src/ts/model.ts；T5：buildRequest、parseResponse 原文不动；HTTP 改用 backends/live.ts 的 Node 内置 HTTP，移除 undici 依赖；导出原错误脱敏函数。
// 把供应商协议变成 Ditto 的统一响应；实验循环不需要知道 HTTP 格式。
import type { Message, SampleInput, SampleOutput } from "./types.ts";
import { checkUsage } from "./ledger.ts";
import { type ModelSettings } from "./model_config.ts";

export type WireObject = Record<string, any>;
export type ModelTransport = (body: WireObject, signal: AbortSignal) => Promise<WireObject>;
export const modelOutputFailureCodes = ["refusal", "content_filter", "invalid_arguments_json", "arguments_not_object"] as const;
export type ModelOutputFailureCode = typeof modelOutputFailureCodes[number];
// 已返回有效身份与用量的模型答题失败；不能当作通信故障停掉其他题。
export class ModelOutputFailure extends Error {
  constructor(readonly detailCode: ModelOutputFailureCode) { super("Model output failure: " + detailCode); }
}
const transportNames = new Set(["Error", "TypeError", "AggregateError", "AbortError", "TimeoutError", "SocketError",
  "ConnectTimeoutError", "HeadersTimeoutError", "BodyTimeoutError", "RequestAbortedError", "SyntaxError"]);
const transportCodes = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "ETIMEDOUT",
  "EHOSTUNREACH", "ENETUNREACH", "EPIPE", "ABORT_ERR", "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_ABORTED", "UND_ERR_CLOSED", "UND_ERR_DESTROYED",
  "ERR_TLS_CERT_ALTNAME_INVALID", "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "UNABLE_TO_VERIFY_LEAF_SIGNATURE"]);
export class ModelTransportError extends Error {
  readonly safeDetails: {phase:"fetch"|"http"|"read_json";name?:string;code?:string;timeout?:boolean;httpStatus?:number;
    retryAfterMs?:number;cancelled?:boolean;providerError?:ProviderError};
  constructor(message:string,phase:"fetch"|"http"|"read_json",error?:unknown,httpStatus?:number,
      details:{retryAfterMs?:number;cancelled?:boolean;providerError?:ProviderError}={}) {
    super(message);this.name="ModelTransportError";
    let name:unknown,code:unknown;
    try { const value=error as {name?:unknown;code?:unknown;cause?:{code?:unknown}}|undefined;
      name=value?.name;code=value?.cause?.code??value?.code; } catch { /* 异常属性不能阻止安全诊断。 */ }
    this.safeDetails={phase,...(typeof name==="string"&&transportNames.has(name)?{name}:{}),
      ...(typeof code==="string"&&transportCodes.has(code)?{code}:{}),
      ...(phase==="fetch"?{timeout:name==="TimeoutError"}:{}),...(httpStatus?{httpStatus}:{}),
      ...(Number.isSafeInteger(details.retryAfterMs)&&details.retryAfterMs!>=0?{retryAfterMs:details.retryAfterMs}:{}),
      ...(details.cancelled!==undefined?{cancelled:details.cancelled}:{}),
      ...(details.providerError?{providerError:details.providerError}:{})};
  }
}
type ProviderError={code?:string;type?:string;message?:string;requestId?:string;truncated?:boolean};
export async function providerError(response:Response,secrets:string[]):Promise<ProviderError|undefined> {
  const scrub=(value:string)=>{
    for(const secret of secrets.filter(Boolean))for(const form of [secret,encodeURIComponent(secret)])value=value.split(form).join("[REDACTED]");
    return value.replace(/https?:\/\/[^\s"'<>]+/gi,"[URL]").replace(/Bearer\s+[^\s"',;]+/gi,"Bearer [REDACTED]")
      .replace(/sk-[a-zA-Z0-9_-]+/g,"[REDACTED]").slice(0,1000);
  };
  const info:ProviderError={},requestId=response.headers.get("x-request-id")??response.headers.get("request-id");
  if(requestId)info.requestId=scrub(requestId).slice(0,200);
  const reader=response.body?.getReader();if(!reader)return Object.keys(info).length?info:undefined;
  const chunks:Uint8Array[]=[];let size=0;let timer:ReturnType<typeof setTimeout>|undefined;
  const deadline=new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error("diagnostic body deadline")),1000);});
  try {
    for(;;){const item=await Promise.race([reader.read(),deadline]);if(item.done)break;
      const remaining=65536-size;chunks.push(item.value.subarray(0,remaining));size+=Math.min(remaining,item.value.length);
      if(size>=65536){info.truncated=true;break;}}
    const parsed=JSON.parse(Buffer.concat(chunks).toString("utf8")),error=parsed?.error;
    if(error&&typeof error==="object"&&!Array.isArray(error))for(const key of ["code","type","message"] as const)
      if(typeof error[key]==="string")info[key]=scrub(error[key]);
  } catch { /* 不保存无法解析的任意正文；状态、重试时间及请求ID仍保留。 */ }
  finally {if(timer)clearTimeout(timer);void reader.cancel().catch(()=>{});}
  return Object.keys(info).length?info:undefined;
}
export const modelSystem: Message = { role: "system", content: [
  "Use the provided file-system tools to complete each user request.",
  "Keep working within the current turn until all requested operations are complete, or you are genuinely blocked and cannot proceed with the available tools.",
  "Track the current directory from successful tool results; inspect or navigate when uncertain, without repeating directory checks when the location is already known.",
  "Use file and directory names specified by the user exactly, including spelling, capitalization and any extension.",
  "When creating or renaming an item, treat the specified target name as the complete name; do not append or preserve an old extension, add a suffix, or otherwise normalize it unless the user explicitly requests that.",
  "Preserve user-supplied file content exactly, including whitespace, line breaks and punctuation, unless the user requests a transformation.",
  "Use tools according to their descriptions, distinguishing sorting lines from sorting words and returning transformed content from writing it to a file.",
  "Prefer an applicable provided tool; write transformed content back only when the user requests that change.",
  "Track source and destination paths after copies, moves and renames; when a later request refers to the copy, operate on that copy even if its name and contents match the original.",
  "When a tool reports an error, use that feedback to correct the next action when possible.",
  "Give a final response only after completion or to explain a genuine blocker.",
  "Base claims about completed operations on tool results, not on plans or assumptions.",
].join(" ") };

export function buildRequest(input: SampleInput, settings: ModelSettings): WireObject {
  const profile = settings.model;
  if (profile.protocol === "responses") {
    const history = input.messages.flatMap((message): WireObject[] => {
      if (message.role === "assistant") {
        const items = message.metadata?.responseItems;
        if (!Array.isArray(items)) throw new Error("助手消息缺少 Responses 续接数据");
        return structuredClone(items).map((item: WireObject) => {
          if (item.type === "message") item.content = item.content.map((part: WireObject) => {
            const { logprobs, ...replayable } = part;
            return replayable;
          });
          return item;
        });
      }
      if (message.role === "tool") return [{ type: "function_call_output", call_id: message.metadata?.actionRequestId, output: message.content }];
      return [{ role: message.role, content: message.content }];
    });
    return { model: profile.model, input: history, reasoning: { effort: profile.reasoningEffort },
      max_output_tokens: profile.maxOutputTokens, stream: false, store: false,
      tool_choice: "auto", parallel_tool_calls: false,
      tools: input.actions!.map(action => ({ type: "function", name: action.name, description: action.description,
        parameters: action.inputSchema, strict: false })) };
  }
  const messages = input.messages.map(message => {
    if (message.role === "assistant") {
      if (!message.metadata?.chatMessage) throw new Error("助手消息缺少 Chat Completions 续接数据");
      return structuredClone(message.metadata.chatMessage);
    }
    if (message.role === "tool") return { role: "tool", tool_call_id: message.metadata?.actionRequestId, content: message.content };
    return { role: message.role, content: message.content };
  });
  return { model: profile.model, messages, thinking: { type: "enabled" }, reasoning_effort: profile.reasoningEffort,
    max_tokens: profile.maxOutputTokens, stream: false, tool_choice: "auto", parallel_tool_calls: false,
    tools: input.actions!.map(action => ({ type: "function", function: { name: action.name,
      description: action.description, parameters: action.inputSchema, strict: false } })) };
}

export function parseUsage(raw: WireObject, protocol: string) {
  const usage = raw.usage;
  if (!usage) return checkUsage(undefined);
  return checkUsage(protocol === "responses" ? {
    inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, totalTokens: usage.total_tokens,
    ...(usage.input_tokens_details?.cached_tokens !== undefined ? { cachedInputTokens: usage.input_tokens_details.cached_tokens } : {}),
    ...(usage.output_tokens_details?.reasoning_tokens !== undefined ? { reasoningTokens: usage.output_tokens_details.reasoning_tokens } : {}),
  } : {
    inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens, totalTokens: usage.total_tokens,
    ...(usage.prompt_cache_hit_tokens !== undefined ? { cachedInputTokens: usage.prompt_cache_hit_tokens } : {}),
    ...(usage.completion_tokens_details?.reasoning_tokens !== undefined ? { reasoningTokens: usage.completion_tokens_details.reasoning_tokens } : {}),
  });
}

export function checkReturnedModel(raw: WireObject, expected: string): void {
  if (raw.model !== expected) throw new Error("返回模型与指定模型不一致");
}

export function parseResponse(raw: WireObject, protocol: string): SampleOutput {
  let content: string, calls: WireObject[], metadata: WireObject;
  if (protocol === "responses") {
    if (raw.status === "incomplete" && raw.incomplete_details?.reason === "content_filter") {
      if (!Array.isArray(raw.output)) throw new Error("模型响应没有有效输出记录");
      throw new ModelOutputFailure("content_filter");
    }
    if (raw.status === "incomplete" && raw.incomplete_details?.reason === "max_output_tokens") {
      if (!Array.isArray(raw.output)) throw new Error("模型响应没有有效输出记录");
      const partial = raw.output.filter((item: WireObject) => item?.type === "message" && Array.isArray(item.content))
        .flatMap((item: WireObject) => item.content.filter((part: WireObject) => part?.type === "output_text" && typeof part.text === "string").map((part: WireObject) => part.text)).join("\n");
      return { message: { role: "assistant", content: partial, metadata: { responseItems: structuredClone(raw.output),
        returnedModel: raw.model, responseStatus: "incomplete", incompleteDetails: structuredClone(raw.incomplete_details) } }, finishReason: "length", actionRequests: [] };
    }
    if (raw.status !== "completed") throw new Error("模型响应未完成或被截断；停止本次执行");
    if (!Array.isArray(raw.output) || !raw.output.length) throw new Error("模型响应没有输出");
    for (const item of raw.output) {
      if (!["reasoning", "function_call", "message"].includes(item.type)) throw new Error("收到本实验不支持的响应类型");
      if (item.status && item.status !== "completed") throw new Error("模型输出项尚未完成");
      if (item.type === "message" && item.role === "assistant" && Array.isArray(item.content)
          && item.content.some((part: WireObject) => part?.type === "refusal" && typeof part.refusal === "string")) throw new ModelOutputFailure("refusal");
      if (item.type === "message" && (item.role !== "assistant" || !Array.isArray(item.content)
          || item.content.some((part: WireObject) => part.type !== "output_text" || typeof part.text !== "string"))) throw new Error("模型消息包含拒答或无效文本");
    }
    content = raw.output.filter((item: WireObject) => item.type === "message").flatMap((item: WireObject) => item.content.map((part: WireObject) => part.text)).join("\n");
    calls = raw.output.filter((item: WireObject) => item.type === "function_call").map((item: WireObject) => ({ id: item.call_id, name: item.name, arguments: item.arguments }));
    if (!calls.length && raw.output.filter((item: WireObject) => item.type === "message").at(-1)?.phase === "commentary") throw new Error("模型只有过程说明，尚未结束本轮");
    // 保留全部 output（含 reasoning、encrypted_content、phase、call_id），由新进程原样续接。
    metadata = { responseItems: structuredClone(raw.output), returnedModel: raw.model };
  } else {
    if (!Array.isArray(raw.choices) || raw.choices.length !== 1) throw new Error("模型响应必须恰好包含一个候选");
    const choice = raw.choices[0], message = choice.message;
    if (message?.role !== "assistant" || (message.content != null && typeof message.content !== "string")
        || (message.refusal != null && typeof message.refusal !== "string")) throw new Error("模型消息格式错误或拒答");
    if (choice.finish_reason === "content_filter") throw new ModelOutputFailure("content_filter");
    if (!["stop", "tool_calls", "length"].includes(choice.finish_reason)) throw new Error("模型响应未完成或被截断；停止本次执行");
    if (message.refusal) throw new ModelOutputFailure("refusal");
    if (choice.finish_reason === "length") {
      return { message: { role: "assistant", content: message.content ?? "", metadata: {
        chatMessage: structuredClone(message), returnedModel: raw.model, rawFinishReason: "length" } }, finishReason: "length", actionRequests: [] };
    }
    calls = (message.tool_calls ?? []).map((call: WireObject) => {
      if (call.type !== "function") throw new Error("只支持函数工具");
      return { id: call.id, name: call.function?.name, arguments: call.function?.arguments };
    });
    if ((calls.length > 0) !== (choice.finish_reason === "tool_calls")) throw new Error("工具调用与结束标记不一致");
    content = message.content ?? "";
    metadata = { chatMessage: structuredClone(message), returnedModel: raw.model };
  }
  const ids = new Set<string>();
  const actionRequests = calls.map(call => {
    if (typeof call.id !== "string" || !call.id || ids.has(call.id) || typeof call.name !== "string" || !call.name) throw new Error("工具名称或调用 ID 无效");
    ids.add(call.id);
    let args: unknown;
    if (typeof call.arguments !== "string") throw new Error("工具参数字段必须是 JSON 字符串");
    try { args = JSON.parse(call.arguments); } catch { throw new ModelOutputFailure("invalid_arguments_json"); }
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new ModelOutputFailure("arguments_not_object");
    return { id: call.id, name: call.name, arguments: args as Record<string, unknown> };
  });
  if (!actionRequests.length && !content.trim()) {
    if (protocol !== "chat-completions") throw new Error("模型没有给出工具调用或本轮回答");
    // 合法的空 stop 结束当前用户轮次，是否完成任务仍由官方评分器判断。
    metadata.emptyAssistantTurn = true;
  }
  return { message: { role: "assistant", content, metadata }, finishReason: actionRequests.length ? "action_request" : "stop",
    ...(actionRequests.length ? { actionRequests } : {}) };
}

