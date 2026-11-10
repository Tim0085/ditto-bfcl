// 来源：experiments/bfcl_direct/src/ts/types.ts；T5：保持原逻辑；相邻模块来自本目录的独立副本。
// 实验协议的中性数据类型；Direct 编译和运行都不需要 Ditto 类型包。
export interface Message { role: "system" | "user" | "assistant" | "tool"; content: string | unknown[]; metadata?: Record<string, any>; }
export interface Usage { inputTokens?: number; outputTokens?: number; totalTokens?: number; reasoningTokens?: number; cachedInputTokens?: number; }
export interface ActionDescriptor { name: string; description?: string; inputSchema: Record<string, unknown>;
  target?: {kind:"tool";toolName?:string}|{kind:"mcp";server:string;toolName:string}|{kind:"node";node:string}; }
export interface ActionRequest { id: string; name: string; arguments: Record<string, unknown>; }
export interface SampleInput {
  messages: Message[]; actions?: ActionDescriptor[];
  model: {provider?: string; model: string; endpoint?: string; providerOptions?: Record<string, unknown>};
  generation?: {temperature?:number;topP?:number;topK?:number;maxTokens?:number;stop?:string[];seed?:number};
  metadata?: Record<string, unknown>;
}
export interface SampleOutput { message: Message; actionRequests?: ActionRequest[];
  finishReason: "stop" | "length" | "action_request" | "cancelled" | "error"; usage?: Usage; }
