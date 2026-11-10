import { workerTimeouts, type DispatchPolicy } from "./egress/model_config.ts";
export const TIMER_MAX = 2_147_483_647;
export interface TimeoutConfig {
  settings: { model: { timeoutMs: number } };
  retryPolicy: { maxRetries: number };
  dispatchPolicy: DispatchPolicy;
}
/** IPC/清理包含整个 FIFO 的等待；不是卡死检测器，T8 监控步骤文件。 */
export function deployTimeouts(config: TimeoutConfig) {
  const { timeoutMs } = config.settings.model;
  const { maxRetries } = config.retryPolicy;
  const p = config.dispatchPolicy;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(maxRetries) || maxRetries < 0 || maxRetries > 2
    || !p || ["maxInFlight","requestsPerMinute","minIntervalMs","maxCooldownMs"].some(key=>!Number.isSafeInteger((p as any)[key]) || (p as any)[key]<1)
    || p.maxCooldownMs>900000 || p.minIntervalMs<Math.ceil(60000/p.requestsPerMinute) || p.minIntervalMs>60000)
    throw new Error("出口等待配置无效");
  const t = workerTimeouts(timeoutMs, maxRetries, p);
  return { modelBridge: t.modelBridge, inferenceTimeoutMs: t.inference, ipcTimeoutMs: TIMER_MAX,
    cleanupTimeoutMs: TIMER_MAX, handshakeTimeoutMs: 60_000, shutdownTimeoutMs: 30_000 };
}
