// 来源：旧 bfcl_direct/src/ts/retry.ts 的 modelOutputFailureDetails 和 model.ts 的代码清单；仅改类型导入。
import type { SampleOutput } from "@codesoul-co/ditto/worker/infer";
const modelOutputFailureCodes = ["refusal", "content_filter", "invalid_arguments_json", "arguments_not_object"] as const;
type ModelOutputFailureCode = typeof modelOutputFailureCodes[number];
export function modelOutputFailureDetails(output: SampleOutput): {reason:"model_output";code:ModelOutputFailureCode}|undefined {
  const value = output.message?.metadata?.bfclTaskFailure as { reason?: string; code: ModelOutputFailureCode } | undefined;
  if (output.finishReason === "error" && value?.reason === "model_output" && modelOutputFailureCodes.includes(value.code))
    return {reason:"model_output",code:value.code};
}
