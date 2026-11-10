import type { ModelProvider } from "@codesoul-co/ditto/worker/infer";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { AsyncLocalStorage } from "node:async_hooks";
import { validateSampleOutput } from "../../vendor/ditto/dist/worker/infer/reasoning/sample/schema.js";
import { MODEL_ENDPOINT_PATH, MODEL_ENDPOINT_PROTOCOL, INPUT_LIMIT_MARKER, REQUEST_LIMIT_MARKER, RUN_STOP_MARKER } from "./model-endpoint.ts";
import type { ModelCallRequest, ModelCallResponse } from "./model-endpoint.ts";

/** Local diagnostics only: never added to the egress body or model output. */
export const connectRetryScope = new AsyncLocalStorage<{ connectRetries: number; connectRetryWaitMs: number }>();
class ConnectionFailure extends Error {
  constructor(readonly original: unknown, readonly connected: boolean) {
    super(original instanceof Error ? original.message : String(original), { cause: original });
  }
}
async function retryWait(ms: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const started = performance.now();
  try {
    await new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(signal?.reason); };
      const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  } finally {
    const metrics = connectRetryScope.getStore();
    if (metrics) metrics.connectRetryWaitMs += performance.now() - started;
  }
}
/** 地址由主进程传入；不读环境变量、凭据，只重连从未建立的连接。 */
export function createModelClient(endpoint: string, policy: { taskCancellation?: "drain" } = {}): ModelProvider {
  const url = new URL(MODEL_ENDPOINT_PATH, endpoint);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("模型出口地址无效");
  return {
    async invoke(input, options) {
      options.signal?.throwIfAborted();
      const m = input.metadata;
      for (const name of ["configId", "taskId", "caseId"] as const) {
        if (typeof m?.[name] !== "string" || !m[name].trim()) throw new Error(`模型请求缺少 metadata.${name}`);
      }
      for (const name of ["turn", "step"] as const) {
        if (!Number.isSafeInteger(m?.[name]) || (m![name] as number) < 1) throw new Error(`metadata.${name} 必须是从 1 开始的整数`);
      }
      const request: ModelCallRequest = { protocol: MODEL_ENDPOINT_PROTOCOL, configId: m!.configId as string,
        taskId: m!.taskId as string, caseId: m!.caseId as string, turn: m!.turn as number, step: m!.step as number, input };
      const body = JSON.stringify(request), errors: string[] = [];
      type Response = { status: number; ok: boolean; value: ModelCallResponse };
      const attempt = () => new Promise<Response>((resolve, reject) => {
        let connected = false, failure: ConnectionFailure | undefined, cancelled = false;
        // Only the explicit abort handler bypasses the egress-stop marker. Do not
        // infer cancellation from a socket error name or a later signal change.
        const fail = (error: unknown) => {
          if (failure || cancelled) return;
          failure = new ConnectionFailure(error, connected);
          req.destroy();
          if (req.closed) reject(failure);
          // Reject on close, so another attempt cannot overlap this socket.
        };
        const req = (url.protocol === "https:" ? httpsRequest : httpRequest)(url,
          { method: "POST", headers: { "content-type": "application/json" }, agent: false }, res => {
            const chunks: Buffer[] = [];
            res.on("data", chunk => chunks.push(Buffer.from(chunk)));
            res.once("error", fail);
            res.once("end", () => {
              try {
                const status = res.statusCode ?? 0;
                // Only this exact relay response means no upstream connection and
                // no forwarded bytes. All other responses retain the host path.
                if (status === 502 && res.headers['x-ditto-relay'] === 'upstream-not-connected-v1'
                  && res.headers['content-type'] === 'text/plain' && res.headers['connection'] === 'close'
                  && res.headers['content-length'] === '38' && res.rawHeaders.length === 8
                  && Buffer.concat(chunks).equals(Buffer.from('DITTO_RELAY_UPSTREAM_NOT_CONNECTED_V1\n'))) {
                  connected = false;
                  fail(new Error('模型出口转发未建立上游连接'));
                  return;
                }
                if (status >= 300 && status < 400) throw new Error("模型出口不允许重定向");
                const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
                if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("模型出口响应必须是对象");
                if (value.ok === true) {
                  // The vendor validator coerces finishReason through String().
                  // The wire contract requires an actual string, not ["stop"].
                  if (typeof value.output?.finishReason !== "string") throw new Error("模型出口 output.finishReason 必须是字符串");
                  validateSampleOutput(value.output);
                }
                else if (value.ok !== false || !value.error || !["input_limit", "request_limit", "run_stop"].includes(value.error.kind)
                  || typeof value.error.message !== "string") throw new Error("模型出口错误格式无效：需要 error.kind 和 error.message");
                resolve({ status, ok: status >= 200 && status < 300, value });
              } catch (error) { fail(error); }
            });
          });
        // Task abandonment must not disconnect a billed request. Keep awaiting
        // the egress response (including its own deadline and durable settlement).
        // Explicit non-task client cancellation retains the original stop behavior.
        req.once("socket", socket => {
          socket.once(url.protocol === "https:" ? "secureConnect" : "connect", () => { connected = true; });
        });
        const abort = () => {
          if (!connected || policy.taskCancellation !== "drain") {
            cancelled = true; reject(options.signal?.reason); req.destroy();
          }
        };
        req.once("error", fail);
        req.once("close", () => {
          options.signal?.removeEventListener("abort", abort);
          if (failure && !cancelled) reject(failure);
        });
        options.signal?.addEventListener("abort", abort, { once: true });
        if (options.signal?.aborted) { abort(); return; }
        req.end(body);
      });
      let response!: Response;
      for (let index = 0; index < 4; index++) {
        options.signal?.throwIfAborted();
        try { response = await attempt(); break; }
        catch (error) {
          if (!(error instanceof ConnectionFailure)) throw error;
          errors.push(error.message);
          if (error.connected || index === 3) throw new Error(RUN_STOP_MARKER + JSON.stringify({
            message: error.message, attempts: index + 1, errors,
          }), { cause: error.original });
          await retryWait([1000, 2000, 4000][index], options.signal);
          options.signal?.throwIfAborted();
          const metrics = connectRetryScope.getStore();
          if (metrics) metrics.connectRetries++;
        }
      }
      const value = response.value;
      if (value?.ok === false) {
        const prefix = { input_limit: INPUT_LIMIT_MARKER, request_limit: REQUEST_LIMIT_MARKER, run_stop: RUN_STOP_MARKER }[value.error?.kind];
        if (!prefix) throw new Error(RUN_STOP_MARKER + JSON.stringify({ message: "模型出口错误格式无效" }));
        throw new Error(prefix + JSON.stringify(value.error.details ?? { message: value.error.message }));
      }
      if (!response.ok || value?.ok !== true || !value.output) throw new Error(RUN_STOP_MARKER + JSON.stringify({ message: "模型出口响应无效", httpStatus: response.status }));
      options.signal?.throwIfAborted();
      return value.output;
    },
  };
}
