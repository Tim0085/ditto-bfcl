// 模型调用约定：问模型节点里的 provider（T3 写）↔ 模型出口进程（T5 写）。
// 本文件只放格式和常量，不放逻辑。两边同时开发，谁都不许单方面改；
// 要改先报告指挥官，并同步 docs/02_程序结构规划.md 第三节。
import type { SampleInput, SampleOutput } from "@codesoul-co/ditto/worker/infer";

/** 模型出口的本地 HTTP 路径：provider 以 JSON POST 一个 ModelCallRequest。 */
export const MODEL_ENDPOINT_PATH = "/v1/sample";
export const MODEL_ENDPOINT_PROTOCOL = "ditto-bfcl-model-call/1";

/**
 * Loop 在 SAMPLE 的取输入函数里放进 input.metadata 的身份字段。
 * turn、step 的口径与旧程序 conversation.ts 相同：第几轮用户的话、这一轮第几次问模型，都从 1 开始。
 */
export interface ModelCallIdentity {
  /** 配置编号，例如 "direct-c1"、"monolithic-8-c8"、"uniform-32-c8"。 */
  readonly configId: string;
  /** 这道题这一次执行的唯一编号，建议 `<runId>/<configId>/r<轮次>/<caseId>`；每题请求上限按它计数。 */
  readonly taskId: string;
  /** BFCL 题号，例如 multi_turn_base_1；回放和夹具按它取材料。 */
  readonly caseId: string;
  readonly turn: number;
  readonly step: number;
}

export interface ModelCallRequest extends ModelCallIdentity {
  readonly protocol: typeof MODEL_ENDPOINT_PROTOCOL;
  /** provider.invoke 收到的 SAMPLE 输入，原样转发；请求体由出口用旧程序的 buildRequest 拼。 */
  readonly input: SampleInput;
}

/**
 * input_limit：请求体超过上限（旧程序 8 MiB）→ 单题终态"输入超限"；
 * request_limit：这道题的实际请求次数（含重试）到了上限 → 单题终态"请求超限"；
 * run_stop：预算不够、费用说不清、通信重试用完、身份对不上等 → 整个运行停下，不算单题结果。
 * 模型输出本身造成的单题终态（finishReason "length"、message.metadata.bfclTaskFailure）不走错误，
 * 随 output 正常返回，由 Loop 按旧程序判断。
 */
export type ModelCallErrorKind = "input_limit" | "request_limit" | "run_stop";

export type ModelCallResponse =
  | { readonly ok: true; readonly output: SampleOutput }
  | { readonly ok: false; readonly error: ModelCallError };

export interface ModelCallError {
  readonly kind: ModelCallErrorKind;
  readonly message: string;
  /** input_limit：{inputBytes, maxRequestBytes}；request_limit：{failedModelAttempts, physicalModelRequests, budgetWaitMs?}。 */
  readonly details?: unknown;
}

/**
 * provider 收到错误回复后抛出的 Error.message = 前缀 + JSON.stringify(details)。
 * 前两个前缀与旧 experiments/bfcl_direct/src/ts/retry.ts 完全相同，
 * 这样 Loop 可以直接用旧的 inputLimitDetails / requestLimitDetails 解析。
 */
export const INPUT_LIMIT_MARKER = "BFCL_INPUT_LIMIT:";
export const REQUEST_LIMIT_MARKER = "BFCL_PHYSICAL_REQUEST_LIMIT:";
export const RUN_STOP_MARKER = "BFCL_RUN_STOP:";
