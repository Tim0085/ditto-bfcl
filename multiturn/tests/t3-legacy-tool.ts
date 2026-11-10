// 来源：旧 bfcl_direct/src/ts/child.ts 的完整 const tool 块；测试运行时读取并原样编译。
// 只把 root 指向新包，Python 客户端和 loadActions 使用已核对的原样复制代码；不启动旧 child 的进程入口。
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import ts from "typescript";
import { createInteractionWorker } from "@codesoul-co/ditto/worker/interaction";
import type { WorkerExecutor } from "@codesoul-co/ditto/worker";
import { startPython, type PythonBridge } from "../src/ts/python-bridge.ts";
import { loadActions } from "../src/ts/tool-actions.ts";
export async function legacyTool(python:string):Promise<WorkerExecutor> {
  const source=await readFile("../../bfcl_direct/src/ts/child.ts","utf8");
  const block=source.slice(source.indexOf("const tool = createInteractionWorker"),source.indexOf("const definition: WorkerDefinition"));
  if(!block.endsWith("\n") || !block.includes('sessions.get(taskId)')) throw new Error("legacy source block not found");
  const js=ts.transpileModule(block,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
  const sessions=new Map<string,{bridge:PythonBridge}>();
  const factory=new Function("createInteractionWorker","sessions","loadActions","startPython","python","join","root",js+"\nreturn tool;");
  const executor:WorkerExecutor=factory(createInteractionWorker,sessions,loadActions,startPython,python,join,process.cwd());
  return {execute:(...args)=>executor.execute(...args),async dispose(){await Promise.allSettled([...sessions.values()].map(x=>x.bridge.close()));await executor.dispose?.();}};
}
