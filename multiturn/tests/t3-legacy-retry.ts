// 来源：experiments/bfcl_direct/src/ts/retry.ts；只复制两个错误解析函数及所需常量/类型，函数正文不改。
const INPUT_LIMIT_MARKER = "BFCL_INPUT_LIMIT:";
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
const LIMIT_MARKER = "BFCL_PHYSICAL_REQUEST_LIMIT:";
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
