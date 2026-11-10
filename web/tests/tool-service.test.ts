import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createAgentCoreWorker } from "../src/ts/agent-core.ts";
import { createDirectSteps } from "../src/ts/direct-steps.ts";
import { createToolService } from "../src/ts/tool-service.ts";
import { loadActions,loadTask } from "../src/ts/tool-actions.ts";
import { legacyTool } from "./t3-legacy-tool.ts";
import { context,options,outcome } from "./t3-helpers.ts";
import type { JsonValue } from "@codesoul-co/ditto/contracts";

function exited(pid:number) {assert.throws(()=>process.kill(pid,0),(e:any)=>e.code==="ESRCH");}
for(const category of ["multi_turn_base","multi_turn_miss_func","multi_turn_miss_param","multi_turn_long_context"]) for(const number of [0,1]) {
  test(`tools: ${category}_${number} every old completed observation + Direct + legacy init/turn/release`,async()=>{
    const caseId=`${category}_${number}`, taskId=`t3/${caseId}`,o=await options();
    const worker=createAgentCoreWorker(o).instantiate(),direct=createDirectSteps(await options()),legacy=await legacyTool(o.python);
    const record=JSON.parse(await readFile(`../../bfcl_direct/runs/multiturn-full800-001/full/${category}/monolithic/monolithic-c1/tasks/${caseId}.json`,"utf8"));
    const task=await loadTask(caseId),ctx=context();
    let seq=0,turns=0;
    const argument=(request:JsonValue)=>({call:{id:`control-${seq++}`,name:"bfcl_bridge",arguments:{taskId,request}}});
    const invoke=async(args:any)=>await worker.execute("INTERACTION.ACT.TOOL",args,ctx) as any;
    const pids:number[]=[];
    const noPid=(v:any)=>{const copy=structuredClone(v);if(copy.structuredContent)delete copy.structuredContent.pythonPid;return copy;};
    try {
      const init=argument({action:"init",case_id:caseId});
      const a=await invoke(init),b:any=await direct.execute("INTERACTION.ACT.TOOL",init),c:any=await legacy.execute("INTERACTION.ACT.TOOL",init,ctx);
      assert.deepEqual(noPid(a),noPid(c));assert.deepEqual(noPid(a),noPid(b));
      pids.push(a.structuredContent.pythonPid,b.structuredContent.pythonPid,c.structuredContent.pythonPid);assert.equal(new Set(pids).size,3);
      assert.deepEqual(a.structuredContent.data,{case_id:caseId,involved_classes:task.involved_classes});
      assert.deepEqual(await outcome(()=>invoke(init)),await outcome(()=>legacy.execute("INTERACTION.ACT.TOOL",init,ctx)));
      for(let turn=1;turn<=record.completedTurns;turn++) {
        if(task.missed_function) {
          const request=argument({action:"turn",turn});
          const advanced=await invoke(request),old:any=await legacy.execute("INTERACTION.ACT.TOOL",request,ctx),d=await direct.execute("INTERACTION.ACT.TOOL",request);
          assert.deepEqual(noPid(advanced),noPid(old));assert.deepEqual(noPid(advanced),noPid(d));
          assert.deepEqual(advanced.structuredContent.data.allowed_tools,(await loadActions(caseId,turn)).map(x=>x.name));turns++;
        }
        for(const completed of record.completed.filter((x:any)=>x.turn===turn)) {
          const request={call:{id:completed.id,name:"bfcl_bridge",arguments:{taskId,request:{action:"call",tool_name:completed.tool,arguments:completed.arguments}}}};
          const result=await invoke(request),d:any=await direct.execute("INTERACTION.ACT.TOOL",request),old:any=await legacy.execute("INTERACTION.ACT.TOOL",request,ctx);
          assert.equal(result.content,completed.result.observation,`${caseId} turn=${turn} ${completed.id}`);
          assert.equal(result.content,d.content);assert.equal(result.content,old.structuredContent.data.observation);
          assert.equal(Object.hasOwn(result,"structuredContent"),false);assert.equal(result.metadata.pythonPid,pids[0]);
          const observed:any=await worker.execute("INTERACTION.OBSERVE",{result},ctx);
          assert.equal(observed.message.content,completed.result.observation);assert.equal(typeof observed.message.content,"string");
        }
      }
      const unknown=argument({action:"call",tool_name:"t3_tool_does_not_exist",arguments:{}});
      const unknownResult=await invoke(unknown),oldUnknown:any=await legacy.execute("INTERACTION.ACT.TOOL",unknown,ctx);
      assert.equal(unknownResult.content,oldUnknown.structuredContent.data.observation);
      assert.equal(unknownResult.content,"Error during execution: name 't3_tool_does_not_exist' is not defined");
      const release={call:{id:"release",name:"bfcl_bridge",arguments:{taskId,release:true}}};
      assert.deepEqual(await invoke(release),await legacy.execute("INTERACTION.ACT.TOOL",release,ctx));
      assert.deepEqual(await direct.execute("INTERACTION.ACT.TOOL",release),await invoke(release));
      pids.forEach(exited);
      assert.deepEqual(await outcome(()=>invoke(unknown)),await outcome(()=>legacy.execute("INTERACTION.ACT.TOOL",unknown,ctx)));
      console.log(JSON.stringify({caseId,observations:record.completed.length,byteEqual:record.completed.length,turnCalls:turns,unknownTool:"matched",releasedPids:pids,allExited:true}));
    } finally {await worker.dispose?.();await direct.dispose();await legacy.dispose?.();}
  });
}

test("tool service: only bfcl_bridge is registered/allowed; dispose releases owned Python; source copies exact",async()=>{
  const o=await options(), service=createToolService(o.python);
  const ctx=context();
  assert.deepEqual(ctx.services.sandbox.policy.tools,["bfcl_bridge"]);
  for(const name of ["shell","other","*"]) assert.equal(ctx.services.sandbox.allows("tools",name),false);
  const worker=createAgentCoreWorker(o).instantiate();
  try {
    await assert.rejects(worker.execute("INTERACTION.ACT.TOOL",{call:{id:"x",name:"other",arguments:{}}},ctx),/Permission denied/);
    assert.throws(()=>service.tool.validate({taskId:""}),/任务 ID/);
    const initialized:any=await worker.execute("INTERACTION.ACT.TOOL",{call:{id:"init",name:"bfcl_bridge",arguments:{taskId:"dispose",request:{action:"init",case_id:"multi_turn_base_0"}}}},ctx);
    const pid=initialized.structuredContent.pythonPid;await worker.dispose?.();exited(pid);
    const old=await readFile("../../bfcl_direct/src/ts/agent.ts","utf8"),copy=await readFile("src/ts/python-bridge.ts","utf8");
    assert.equal(copy.slice(copy.indexOf("\n")+1),old);
    const oldConfig=(await readFile("../../bfcl_direct/src/ts/model_config.ts","utf8")).replaceAll("\r\n","\n"),newConfig=(await readFile("src/ts/tool-actions.ts","utf8")).replaceAll("\r\n","\n");
    let comparable=newConfig;
    for(const name of ["loadTasks","loadTask","loadActions"]){
      const start=comparable.indexOf(`export async function ${name}(`);
      assert(start>=0);const end=comparable.indexOf("\n}",start)+2;assert(end>start);
      const wrapped=comparable.slice(start,end);
      assert.match(wrapped,/^[^\n]*\n  try \{\n/);
      assert(wrapped.endsWith('\n  }catch(error){throw markFailure(error,"other");}\n}'));
      const unwrapped=wrapped.replace(/^([^\n]*\n)  try \{\n/,"$1")
        .replace('\n  }catch(error){throw markFailure(error,"other");}\n}',"\n}");
      comparable=comparable.slice(0,start)+unwrapped+comparable.slice(end);
    }
    assert.equal(comparable.slice(comparable.indexOf("export function validateCategories")),oldConfig.slice(oldConfig.indexOf("export function validateCategories")));
    console.log("Python client byte-exact after source comment; loading logic exact except three verified origin wrappers; allowlist only bfcl_bridge; owned process exits on dispose");
  }finally{await worker.dispose?.();await service.dispose();}
});
