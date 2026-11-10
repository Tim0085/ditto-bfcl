// 来源：旧 bfcl_direct/src/ts/child.ts 的 sessions 与 bfcl_bridge；去掉进程入口，call 仅返回观察文字，PID 移到 metadata。
import { fileURLToPath } from "node:url";
import type { RegisteredTool } from "@codesoul-co/ditto/worker/interaction";
import { startPython, ACT_TOOL_TIMEOUT_MS, type PythonBridge, type BridgeRequest } from "./python-bridge.ts";
import { loadActions } from "./tool-actions.ts";
import { CONTEXT_POLICY } from "./agent-core.ts";
import { inlineBytes } from "../../vendor/ditto/dist/worker/context/validation.js";
import { InputLimit } from "./egress/retry.ts";

async function requestToolNode(bridge:PythonBridge,request:BridgeRequest) {
  let timer:ReturnType<typeof setTimeout>|undefined;
  try {
    return await Promise.race([bridge.request(request),new Promise<never>((_,reject)=>{
      timer=setTimeout(()=>reject(new Error("ACT.TOOL 等待超过 930000 ms")),ACT_TOOL_TIMEOUT_MS);
    })]);
  } finally { clearTimeout(timer); }
}

export function createToolService(python: string, bridgePath = fileURLToPath(new URL("../python/bridge.py", import.meta.url))) {
  const sessions = new Map<string, { bridge: PythonBridge; allowed: Set<string>; caseId: string; diagnosticFailure?: boolean }>();
  const tool: RegisteredTool = {
    name: "bfcl_bridge", description: "独立任务的 BFCL 工具环境", inputSchema: { type: "object" }, effects: ["read", "write", "execute"],
    validate(args) {
      if (typeof args.taskId !== "string" || !args.taskId || (args.release !== true && (!args.request || typeof args.request !== "object")))
        throw new Error("工具请求需要任务 ID 和请求对象");
    },
    async execute(args) {
      const taskId = String(args.taskId), request = args.request as unknown as BridgeRequest;
      if (args.release === true) {
        const session = sessions.get(taskId);
        if (session) {
          try { await session.bridge.close(); }
          catch (error) { if (!session.diagnosticFailure) throw error; }
          finally { sessions.delete(taskId); }
        }
        return { status: "success", structuredContent: { data: {}, pythonPid: 0 } };
      }
      if (request.action === "init") {
        if (sessions.has(taskId)) throw new Error("任务已初始化");
        const allowed = new Set((await loadActions(request.case_id)).map(action => action.name));
        // loadActions 等待期间可能来了重复 init；只启动本服务自己的进程。
        if (sessions.has(taskId)) throw new Error("任务已初始化");
        sessions.set(taskId, { bridge: startPython(python,bridgePath,undefined,request.web?.mode), allowed, caseId: request.case_id });
      }
      const session = sessions.get(taskId);
      if (!session) throw new Error("工具任务未初始化");
      let response;
      try {
        response = await requestToolNode(session.bridge,request);
        if (!response.ok) throw new Error(response.error);
      } catch (error) {
        if (request.action === "snapshot") session.diagnosticFailure = true;
        throw error;
      }
      if (request.action === "turn") {
        const allowed = (await loadActions(session.caseId,request.turn)).map(action => action.name), reported = response.result.allowed_tools;
        if (!Array.isArray(reported) || reported.length !== allowed.length || !reported.every(name => typeof name === "string" && allowed.includes(name))) throw new Error("Python与Worker的本轮工具清单不一致");
        session.allowed = new Set(allowed);
      }
      if (request.action === "call") {
        if (typeof response.result.observation !== "string") throw new Error("Python 工具没有返回观察字符串");
        // Ditto context validation counts UTF-8 bytes of JSON.stringify(item.content).
        const bytes = inlineBytes(response.result.observation);
        if (bytes > CONTEXT_POLICY.maxInlineBytes) throw new InputLimit(bytes, CONTEXT_POLICY.maxInlineBytes);
        return { status: "success", content: response.result.observation, metadata: { pythonPid: session.bridge.pid! } };
      }
      return { status: "success", structuredContent: { data: JSON.parse(JSON.stringify(response.result)), pythonPid: session.bridge.pid! } };
    },
  };
  async function releaseTask(taskId: string): Promise<boolean> {
    const session = sessions.get(taskId);
    if (!session) return false;
    // 与原 release 分支相同；管理入口不需要节点的 WorkerContext。
    try { await session.bridge.close(); }
    catch (error) { if (!session.diagnosticFailure) throw error; }
    finally { sessions.delete(taskId); }
    return true;
  }
  return { tool, releaseTask, async dispose() {
    const results = await Promise.allSettled([...sessions.values()].map(session => session.bridge.close()));
    sessions.clear();
    const failed = results.find(result => result.status === "rejected");
    if (failed?.status === "rejected") throw failed.reason;
  } };
}
