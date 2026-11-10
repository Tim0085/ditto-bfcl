import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createDitto, loadRuntimeConfig } from "@codesoul-co/ditto";
import type { InputOf } from "@codesoul-co/ditto/contracts";
import { createAgentCoreWorker, CAPABILITIES, type AgentCoreInstanceHandle } from "../src/ts/agent-core.ts";
import { createDirectSteps } from "../src/ts/direct-steps.ts";
import { createToolService } from "../src/ts/tool-service.ts";
import { options, context } from "./t3-helpers.ts";

const empty = { contextDeleted:false, pythonReleased:false };
const both = { contextDeleted:true, pythonReleased:true };
const scope = (taskId:string) => ({sessionId:taskId});
const load = (taskId:string) => ({scope:scope(taskId),sources:[{id:"one",content:taskId}]});
const tool = (taskId:string, action:"init"|"call" = "init"):InputOf<"INTERACTION.ACT.TOOL"> => ({call:{id:`${taskId}-${action}`,name:"bfcl_bridge",
  arguments:{taskId,request:action === "init" ? {action,case_id:"multi_turn_base_0"} : {action,tool_name:"pwd",arguments:{}}}}});
function alive(pid:number) { try { process.kill(pid,0);return true; } catch(e) { if((e as NodeJS.ErrnoException).code === "ESRCH")return false;throw e; } }

test("handle: two registrations isolate same task and other task; actual deletion/exit; memory survives",async()=>{
  const handles:AgentCoreInstanceHandle[]=[],o=await options({onInstance:h=>handles.push(h)});
  const definition=createAgentCoreWorker(o),runtime=createDitto({config:loadRuntimeConfig({})});
  assert.equal(handles.length,0);
  runtime.register(definition,{id:"a"});runtime.register(definition,{id:"b"});
  assert.equal(handles.length,2);assert.notEqual(handles[0].instanceId,handles[1].instanceId);
  const invoke=(workerId:string,node:any,input:any)=>runtime.invoke(node,input,{workerId}) as Promise<any>;
  const pids:number[]=[];
  try {
    for(const [workerId,taskId] of [["a","X"],["a","Y"],["b","X"]]) {
      await invoke(workerId,"CONTEXT.LOAD",load(taskId));
      const init=await invoke(workerId,"INTERACTION.ACT.TOOL",tool(taskId));assert.equal(init.status,"success");
      pids.push(init.structuredContent.pythonPid);
    }
    assert.equal(new Set(pids).size,3);pids.forEach(pid=>assert.equal(alive(pid),true));
    await invoke("a","MEMORY.WRITE",{memories:[{key:"X/turn-1",content:"keep",metadata:{taskId:"X"}}]});
    const files=await readdir(o.memoryDirectory),before=await Promise.all(files.map(f=>readFile(join(o.memoryDirectory,f),"utf8")));
    assert.equal(files.length,1);
    assert.deepEqual(await handles[0].releaseTask("X"),both);
    await assert.rejects(invoke("a","CONTEXT.LOAD",{scope:scope("X")}),{code:"CONTEXT_NOT_FOUND"});
    assert.equal(alive(pids[0]),false);
    for(const [workerId,taskId,pid] of [["a","Y",pids[1]],["b","X",pids[2]]] as const) {
      assert.equal((await invoke(workerId,"CONTEXT.LOAD",{scope:scope(taskId)})).items[0].content,taskId);
      assert.equal(alive(pid),true);assert.equal((await invoke(workerId,"INTERACTION.ACT.TOOL",tool(taskId,"call"))).status,"success");
    }
    assert.deepEqual(await readdir(o.memoryDirectory),files);
    assert.deepEqual(await Promise.all(files.map(f=>readFile(join(o.memoryDirectory,f),"utf8"))),before);
    assert.deepEqual(await handles[0].releaseTask("X"),empty);
    console.log(JSON.stringify({instanceIds:handles.map(h=>h.instanceId),pids,released:pids[0],otherTaskAndReplicaAlive:true,memoryBytesUnchanged:true}));
  } finally {await runtime.close();}
  pids.forEach(pid=>assert.equal(alive(pid),false));
  for(const h of handles) assert.deepEqual(await h.releaseTask("Y"),empty);
});

for(const mode of ["Worker","Direct"] as const) {
  test(`${mode} handle: unused and disposed instances create no services`,async()=>{
    const built:string[]=[],handles:AgentCoreInstanceHandle[]=[];
    const o=await options({onServiceCreated:c=>built.push(c),onInstance:h=>handles.push(h)});
    const instance=mode === "Worker" ? createAgentCoreWorker(o).instantiate() : createDirectSteps(o);
    const release=mode === "Worker" ? handles[0].releaseTask : (instance as ReturnType<typeof createDirectSteps>).releaseTask;
    assert.deepEqual(await release("absent"),empty);assert.deepEqual(built,[]);
    await instance.dispose?.();assert.deepEqual(await release("absent"),empty);assert.deepEqual(built,[]);
    console.log(JSON.stringify({mode,built,unusedAndDisposed:empty}));
  });

  for(const capability of ["Context","Interaction"] as const) test(`${mode} handle: ${capability} only; no service created by cleanup`,async()=>{
    const built:string[]=[],handles:AgentCoreInstanceHandle[]=[];
    const o=await options({onServiceCreated:c=>built.push(c),onInstance:h=>handles.push(h)});
    const runtime=createDitto({config:loadRuntimeConfig({})});
    const definition=mode === "Worker" ? createAgentCoreWorker(o) : undefined;
    if(definition) runtime.register({...definition,capabilities:CAPABILITIES[capability]},{id:"partial"});
    const direct=mode === "Direct" ? createDirectSteps(o) : undefined;
    const execute=(node:any,input:any)=>direct ? direct.execute(node,input) as Promise<any> : runtime.invoke(node,input,{workerId:"partial"}) as Promise<any>;
    const release=direct?.releaseTask ?? handles[0].releaseTask;
    let pid:number|undefined;
    try {
      if(capability === "Context") await execute("CONTEXT.LOAD",load("X"));
      else {const init=await execute("INTERACTION.ACT.TOOL",tool("X"));assert.equal(init.status,"success");pid=init.structuredContent.pythonPid;}
      const expected={contextDeleted:capability === "Context",pythonReleased:capability === "Interaction"};
      assert.deepEqual(await release("X"),expected);assert.deepEqual(await release("X"),empty);
      if(pid) assert.equal(alive(pid),false);
      if(capability === "Context") await assert.rejects(execute("CONTEXT.LOAD",{scope:scope("X")}),{code:"CONTEXT_NOT_FOUND"});
      assert.deepEqual(built,[capability]);
      console.log(JSON.stringify({mode,capability,built,result:expected,pid,pythonExited:pid ? !alive(pid) : null}));
    } finally {await direct?.dispose();await runtime.close();}
    assert.deepEqual(await release("X"),empty);
  });

  test(`${mode} handle: queued writes finish before deletion; same-scope later LOAD sees absence`,async()=>{
    const handles:AgentCoreInstanceHandle[]=[],o=await options({onInstance:h=>handles.push(h)});
    const direct=mode === "Direct" ? createDirectSteps(o) : undefined;
    const worker=mode === "Worker" ? createAgentCoreWorker(o).instantiate() : undefined;
    const execute=(node:any,input:any)=>direct ? direct.execute(node,input) as Promise<any> : worker!.execute(node,input,context()) as Promise<any>;
    const release=direct?.releaseTask ?? handles[0].releaseTask;
    try {
      await execute("CONTEXT.LOAD",load("X"));
      const order:string[]=[];
      // 不 await：两个 UPDATE 先进入同一 scope 的队列，随后立即提交清理。
      const first=execute("CONTEXT.UPDATE",{scope:scope("X"),add:[{id:"two",content:"second"}]}).then(r=>{order.push("write-1");assert.equal(r.items.length,2);});
      const second=execute("CONTEXT.UPDATE",{scope:scope("X"),add:[{id:"three",content:"third"}]}).then(r=>{order.push("write-2");assert.equal(r.items.length,3);});
      const cleanup=release("X").then(r=>{order.push("delete");assert.deepEqual(r,{contextDeleted:true,pythonReleased:false});});
      await Promise.all([first,second,cleanup]);
      assert.deepEqual(order,["write-1","write-2","delete"]);
      await assert.rejects(execute("CONTEXT.LOAD",{scope:scope("X")}),{code:"CONTEXT_NOT_FOUND"});
      console.log(JSON.stringify({mode,order,after:"CONTEXT_NOT_FOUND"}));
    } finally {await direct?.dispose();await worker?.dispose?.();}
  });
}

test("Direct releaseTask: same result, other task preserved, memory bytes kept, deleteContext still works",async()=>{
  const o=await options(),direct=createDirectSteps(o),pids:number[]=[];
  try {
    for(const taskId of ["X","Y"]) {
      await direct.execute("CONTEXT.LOAD",load(taskId));
      const init:any=await direct.execute("INTERACTION.ACT.TOOL",tool(taskId));assert.equal(init.status,"success");pids.push(init.structuredContent.pythonPid);
    }
    await direct.execute("MEMORY.WRITE",{memories:[{key:"X/turn-1",content:"keep",metadata:{taskId:"X"}}]});
    const files=await readdir(o.memoryDirectory),before=await Promise.all(files.map(f=>readFile(join(o.memoryDirectory,f),"utf8")));
    assert.deepEqual(await direct.releaseTask("X"),both);assert.equal(alive(pids[0]),false);assert.equal(alive(pids[1]),true);
    await assert.rejects(direct.execute("CONTEXT.LOAD",{scope:scope("X")}),{code:"CONTEXT_NOT_FOUND"});
    assert.equal((await direct.execute("CONTEXT.LOAD",{scope:scope("Y")})).items[0].content,"Y");
    assert.equal((await direct.execute("INTERACTION.ACT.TOOL",tool("Y","call"))).status,"success");
    assert.deepEqual(await direct.releaseTask("X"),empty);
    assert.deepEqual(await Promise.all(files.map(f=>readFile(join(o.memoryDirectory,f),"utf8"))),before);
    assert.equal(await direct.deleteContext("Y"),true);assert.equal(await direct.deleteContext("Y"),false);
    console.log(JSON.stringify({mode:"Direct",pids,otherTaskAlive:true,memoryBytesUnchanged:true,legacyDeleteContext:true}));
  } finally {await direct.dispose();}
  pids.forEach(pid=>assert.equal(alive(pid),false));assert.deepEqual(await direct.releaseTask("Y"),empty);
});

test("management Python close errors match original release including diagnosticFailure; session removed",async()=>{
  const o=await options(),bridgePath=join(o.memoryDirectory,"close-failure.py");
  await writeFile(bridgePath,'import sys, json\nfor line in sys.stdin:\n    request = json.loads(line)\n    print(json.dumps({"ok": True, "result": {}} if request["action"] == "init" else {"ok": False, "error": "controlled snapshot failure"}), flush=True)\nsys.exit(7)\n');
  for(const diagnostic of [false,true]) for(const mode of ["original","management"]) {
    const service=createToolService(o.python,bridgePath);
    try {
      const init=await service.tool.execute(tool("X").call.arguments,context());
      const pid=(init.structuredContent as {pythonPid:number}).pythonPid;
      if(diagnostic) await assert.rejects(service.tool.execute({taskId:"X",request:{action:"snapshot"}},context()),/controlled snapshot failure/);
      const release=()=>mode === "management" ? service.releaseTask("X") : service.tool.execute({taskId:"X",release:true},context());
      if(diagnostic) {const result=await release();if(mode === "management")assert.equal(result,true);}
      else await assert.rejects(release(),/Python 意外退出：退出码 7/);
      assert.equal(alive(pid),false);assert.equal(await service.releaseTask("X"),false);
      console.log(JSON.stringify({mode,diagnostic,exitCode:7,errorSuppressed:diagnostic,pythonExited:true,sessionRemoved:true}));
    } finally {await service.dispose();}
  }
});
