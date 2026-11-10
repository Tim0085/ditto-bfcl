import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createAgentCoreWorker,AGENT_CORE_NODES } from "../src/ts/agent-core.ts";
import { createDirectSteps } from "../src/ts/direct-steps.ts";
import { options,seedMemory,valid,context,outcome } from "./t3-helpers.ts";
for(const node of AGENT_CORE_NODES) test(`Direct ${node}: same valid/invalid inputs as agent-core`,async()=>{
  const a=await options(),b=await options();await seedMemory(a);await seedMemory(b);
  const worker=createAgentCoreWorker(a).instantiate(),direct=createDirectSteps(b);
  try {for(const input of [valid[node],null]) assert.deepEqual(await outcome(()=>worker.execute(node,input,context())),await outcome(()=>direct.execute(node,input as never)));}
  finally {await worker.dispose?.();await direct.dispose();}
});
test("Direct executes all 19 nodes while Runtime, graph, router and Ditto IPC are disabled",()=>{
  // 不继承 Node 测试进程内部的二进制报告通道；只传本地运行需要的非凭据环境变量。
  const result=spawnSync(process.execPath,["--experimental-transform-types","tests/t3-direct-probe.mjs"],{encoding:"utf8",timeout:20000,
    env:{PATH:process.env.PATH,SystemRoot:process.env.SystemRoot,TEMP:process.env.TEMP,TMP:process.env.TMP}});
  assert.equal(result.status,0,result.stdout+result.stderr);
  console.log(result.stdout.trim());
});
