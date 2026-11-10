// 来源：experiments/bfcl_direct/src/ts/retry.ts；T5：保持原逻辑；相邻模块来自本目录的独立副本。
// 父进程生成的控制信息；不把未知响应伪造成模型回答或零费用。
import { ModelTransportError, modelOutputFailureCodes, type ModelOutputFailureCode } from "./model.ts";
import type { SampleOutput } from "./types.ts";

export function modelOutputFailureDetails(output: SampleOutput): {reason:"model_output";code:ModelOutputFailureCode}|undefined {
  const value = output.message?.metadata?.bfclTaskFailure;
  if (output.finishReason === "error" && value?.reason === "model_output" && modelOutputFailureCodes.includes(value.code))
    return {reason:"model_output",code:value.code};
}
const INPUT_LIMIT_MARKER = "BFCL_INPUT_LIMIT:";
export class InputLimit extends Error {
  constructor(readonly inputBytes:number,readonly maxRequestBytes:number) {
    super(INPUT_LIMIT_MARKER+JSON.stringify({inputBytes,maxRequestBytes}));
  }
}
export function inputLimitDetails(error:unknown):{inputBytes:number;maxRequestBytes:number}|undefined {
  const text=error instanceof Error?error.message:"",start=text.indexOf(INPUT_LIMIT_MARKER);
  if(start<0)return;
  try {
    const value=JSON.parse(text.slice(start+INPUT_LIMIT_MARKER.length));
    if(Number.isSafeInteger(value.inputBytes)&&Number.isSafeInteger(value.maxRequestBytes)
        && value.maxRequestBytes>0&&value.inputBytes>value.maxRequestBytes)return {inputBytes:value.inputBytes,maxRequestBytes:value.maxRequestBytes};
  } catch { /* 不把任意错误文字当作受控单题限额。 */ }
}
export type FailedModelAttempt = {id:string;reason:"transport_unknown";heldReferenceMicroUsd:number;
  apiMs:number;requestStartedAt:number;rateWaitMs:number;errorCategory:string;turn?:number;step?:number;
  retryDelayMs?:number;transportFailure?:{phase:string;name?:string;code?:string;timeout?:boolean;httpStatus?:number;
    retryAfterMs?:number;cancelled?:boolean}};
const temporaryCodes=new Set(["EAI_AGAIN","ECONNRESET","ECONNABORTED","ECONNREFUSED","ETIMEDOUT","EPIPE",
  "UND_ERR_SOCKET","UND_ERR_CONNECT_TIMEOUT","UND_ERR_HEADERS_TIMEOUT","UND_ERR_BODY_TIMEOUT","UND_ERR_CLOSED"]);
export function temporaryModelFailure(error:unknown) {
  if(!(error instanceof ModelTransportError))return false;
  const details=error.safeDetails;
  if(details.cancelled)return false;
  if(details.phase==="http")return details.httpStatus===429||details.httpStatus===408
    || [500,502,503,504].includes(details.httpStatus??0);
  return details.timeout===true||details.name==="TimeoutError"||temporaryCodes.has(details.code??"");
}
export function retryDelayMs(error:unknown,attempt:number) {
  const supplied=error instanceof ModelTransportError?error.safeDetails.retryAfterMs??0:0;
  return Math.max(Math.min(30000*2**attempt,120000),supplied);
}
const LIMIT_MARKER = "BFCL_PHYSICAL_REQUEST_LIMIT:";
export class PhysicalRequestLimit extends Error {
  constructor(readonly failedModelAttempts:FailedModelAttempt[],readonly physicalModelRequests:number,readonly budgetWaitMs=0) {
    if(!Number.isFinite(budgetWaitMs)||budgetWaitMs<0)throw new Error("预算等待时长无效");
    super(LIMIT_MARKER+JSON.stringify({failedModelAttempts,physicalModelRequests,...(budgetWaitMs?{budgetWaitMs}:{})}));
  }
}
export function requestLimitDetails(error:unknown):{failedModelAttempts:FailedModelAttempt[];physicalModelRequests:number;budgetWaitMs?:number}|undefined {
  const text=error instanceof Error?error.message:"",start=text.indexOf(LIMIT_MARKER);
  if(start<0)return;
  try {
    const value=JSON.parse(text.slice(start+LIMIT_MARKER.length));
    if(!Number.isSafeInteger(value.physicalModelRequests)||value.physicalModelRequests<1||!Array.isArray(value.failedModelAttempts))return;
    if(value.budgetWaitMs!==undefined&&(!Number.isFinite(value.budgetWaitMs)||value.budgetWaitMs<0))return;
    if(value.failedModelAttempts.some((x:any)=>typeof x.id!=="string"||x.reason!=="transport_unknown"||!Number.isSafeInteger(x.heldReferenceMicroUsd)))return;
    return value;
  } catch { return; }
}
