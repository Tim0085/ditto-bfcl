// 来源：experiments/bfcl_direct/src/ts/agent.ts；除本来源注释外原样复制。
// Python 通信客户端：负责请求收发，题目环境仍由 bridge.py 管理。

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export const PYTHON_REQUEST_TIMEOUT_MS = 915_000;
export const ACT_TOOL_TIMEOUT_MS = 930_000;
export type WebToolSettings = { mode:"fixture"|"replay"|"live"; taskId:string; configId:string; searchEndpoint?:string; fetchProxy?:string };

export type BridgeRequest =
  | { action: "init"; case_id: string; web?: WebToolSettings }
  | { action: "turn"; turn: number }
  | { action: "call"; tool_name: string; arguments: Record<string, unknown> }
  | { action: "snapshot" };

export type BridgeResponse =
  | { ok: true; result: Record<string, unknown> }
  | { ok: false; error: string };

// 表示与一个 Python 进程的连接；文件环境仍留在 Python 中。
export type PythonBridge = {
  readonly pid: number | undefined;
  request(message: BridgeRequest): Promise<BridgeResponse>;
  close(): Promise<void>;
};

export function startPython(
  pythonPath: string,
  bridgePath: string,
  timeoutMs = PYTHON_REQUEST_TIMEOUT_MS,
  webMode?:WebToolSettings["mode"],
): PythonBridge {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("请求超时必须是正数（毫秒）");
  }
  // 启动指定的 Python，保持进程存活，并提供 request / close 两个操作。
  const child = spawn(pythonPath, ["-B", "-X", "utf8", bridgePath, ...(webMode?["--web-mode",webMode]:[])], {
    stdio: ["pipe", "pipe", "inherit"],
    windowsHide: true,
  });
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  let failure: Error | undefined;
  let exited = false;
  let closing = false;
  let closePromise: Promise<void> | undefined;
  let queue = Promise.resolve();
  let pending: {
    resolve(response: BridgeResponse): void;
    reject(error: Error): void;
  } | undefined;

  // 通信失步后停止当前连接，不重试工具，避免重复执行 mv 等操作。
  function fail(error: Error): void {
    failure ??= error;
    pending?.reject(failure);
    if (!exited) child.kill(); // 只结束 startPython 创建的这个子进程。
  }

  child.once("error", fail);
  child.stdin.on("error", fail);
  child.stdout.on("error", fail);
  const closed = new Promise<void>(resolve => {
    child.once("close", (code, signal) => {
      exited = true;
      if (pending || code !== 0 || signal) {
        fail(new Error(`Python 意外退出：退出码 ${code}，信号 ${signal ?? "无"}`));
      }
      lines.close();
      resolve();
    });
  });

  lines.on("line", line => {
    if (failure) return;
    if (!pending) return fail(new Error("Python 返回了没有对应请求的响应"));
    try {
      const response: unknown = JSON.parse(line);
      if (!isResponse(response)) throw new Error("响应必须包含 ok 和 result / error");
      pending.resolve(response);
    } catch (error) {
      fail(new Error("无法读取 Python 的 JSON 响应", { cause: error }));
    }
  });

  function send(payload: string): Promise<BridgeResponse> {
    if (failure) return Promise.reject(failure);
    if (exited) return Promise.reject(new Error("Python 进程已结束"));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => fail(new Error(`Python 响应超时（${timeoutMs} ms）`)), timeoutMs);
      pending = {
        resolve(response) { clearTimeout(timer); pending = undefined; resolve(response); },
        reject(error) { clearTimeout(timer); pending = undefined; reject(error); },
      };
      // 换行是消息的结束标记；Python 的 for line in sys.stdin 每次读取一条。
      child.stdin.write(payload + "\n", "utf8", error => { if (error) fail(error); });
    });
  }

  return {
    get pid() { return child.pid; },
    async request(message: BridgeRequest): Promise<BridgeResponse> {
      if (closing) throw new Error("连接正在关闭，不能再发送请求");
      const payload = JSON.stringify(message);
      // 即使调用者同时提交请求，也一次只发一条，保证响应与请求对应。
      const response = queue.then(() => send(payload));
      queue = response.then(() => undefined, () => undefined);
      return response;
    },
    close(): Promise<void> {
      closing = true;
      closePromise ??= (async () => {
        await queue; // 先完成已经接收的请求，再关闭输入。
        const timer = setTimeout(() => fail(new Error("Python 未能在 5 秒内关闭")), 5_000);
        try {
          if (!child.stdin.destroyed) child.stdin.end();
          await closed;
          if (failure) throw failure;
        } finally {
          clearTimeout(timer);
        }
      })();
      return closePromise;
    },
  };
}

function isResponse(value: unknown): value is BridgeResponse {
  if (typeof value !== "object" || value === null) return false;
  if (!("ok" in value)) return false;
  if (value.ok === false) return "error" in value && typeof value.error === "string";
  return value.ok === true && "result" in value && typeof value.result === "object"
    && value.result !== null && !Array.isArray(value.result);
}

