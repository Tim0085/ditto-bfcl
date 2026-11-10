import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import ts from "typescript";
import { temporary, localRuntime, taskOptions, alive } from "./t4-helpers.ts";
import { loadTask } from "../src/ts/tool-actions.ts";
import { runTask } from "../src/ts/task-loop.ts";
import { TaskRunError, withTaskCleanup } from "../src/ts/direct-task.ts";
import { createModelClient } from "../src/ts/model-client.ts";
import { createBindings } from "../src/ts/bindings.ts";

const output=(finishReason="stop",metadata:any={})=>({message:{role:"assistant",content:"done",metadata},finishReason,usage:{inputTokens:1,outputTokens:1,totalTokens:2}});
async function fake(reply:any) {
  const requests:any[]=[];
  const server=createServer(async(req,res)=>{let text="";for await(const chunk of req)text+=chunk;requests.push(JSON.parse(text));res.end(JSON.stringify(typeof reply==="function"?reply(requests.at(-1)):reply));});
  await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));
  return {url:`http://127.0.0.1:${(server.address() as any).port}`,requests,close:()=>new Promise<void>(r=>server.close(()=>r()))};
}
// Compile the untouched old executeTask body, rewiring imports to the local exact copies.
const source=await readFile("../../bfcl_direct/src/ts/conversation.ts","utf8");
const imports:Record<string,string>={"./model_config.ts":"src/ts/tool-actions.ts","./model.ts":"src/ts/egress/model.ts","./offline.ts":"src/ts/egress/offline.ts","./retry.ts":"src/ts/egress/retry.ts"};
let compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
for(const [old,path]of Object.entries(imports))compiled=compiled.replaceAll(JSON.stringify(old),JSON.stringify(pathToFileURL(resolve(path)).href));
const {executeTask:oldExecute}=await import("data:text/javascript;base64,"+Buffer.from(compiled).toString("base64"));
const scenarios=[
  {name:"stop",reply:{ok:true,output:output()},outcome:"completed"},
  {name:"length",reply:{ok:true,output:output("length")},outcome:"output_limit"},
  {name:"bfclTaskFailure",reply:{ok:true,output:output("error",{bfclTaskFailure:{reason:"model_output",code:"content_filter"}})},outcome:"model_output"},
  {name:"input_limit",reply:{ok:false,error:{kind:"input_limit",message:"fixture input limit",details:{inputBytes:9,maxRequestBytes:8}}},outcome:"input_limit"},
  {name:"request_limit",reply:{ok:false,error:{kind:"request_limit",message:"fixture request limit",details:{physicalModelRequests:100,failedModelAttempts:[]}}},outcome:"request_limit"},
];
for(const scenario of scenarios)test(`T4 fake endpoint ${scenario.name}: exact old executeTask terminal fields`,async()=>{
  const service=await fake(scenario.reply),host=await localRuntime(await temporary(),service.url);
  const task=await loadTask("multi_turn_base_0"),options=taskOptions("flow/"+scenario.name),stages:string[]=[];
  try {
    const result=await runTask(host.runtime,task,{...options,handles:host.handles,bindings:host.bindings,onStage:s=>stages.push(s)});
    const provider=createModelClient(service.url);
    const old=await oldExecute({tool:async()=>({}),infer:async(id:string,caseId:string,input:any)=>({result:{output:await provider.invoke({...input,metadata:{...input.metadata,taskId:id,caseId,configId:options.configId}},{signal:new AbortController().signal})}})},task,options.taskId,
      {mode:options.mode,perTaskRequests:options.perTaskRequests,settings:{model:{model:options.model,maxOutputTokens:options.maxOutputTokens}}});
    assert.deepEqual(result,old);assert.equal(result.executionOutcome,scenario.outcome);assert(!stages.includes("action"));assert(stages.includes("close"));
    console.log(JSON.stringify({scenario:scenario.name,exactLegacyReturn:true,outcome:result.executionOutcome,termination:result.termination}));
  } finally {await host.runtime.close();await service.close();}
});
test("T4 request counter checked before each SAMPLE, including historical failed requests",async()=>{
  const service=await fake({ok:true,output:output()}),host=await localRuntime(await temporary(),service.url),task=await loadTask("multi_turn_base_0");
  try {
    const r=await runTask(host.runtime,task,{...taskOptions("limit/one"),perTaskRequests:1,handles:host.handles,bindings:host.bindings});
    assert.equal(service.requests.length,1);assert.deepEqual(r.termination,{reason:"request_limit",turn:2,step:1,perTaskRequests:1});
    const r2=await runTask(host.runtime,task,{...taskOptions("limit/zero"),previousFailedRequests:100,handles:host.handles,bindings:host.bindings});
    assert.equal(service.requests.length,1);assert.equal(r2.usage.requests,0);
  } finally {await host.runtime.close();await service.close();}
});
test("T4 successful retry metadata contributes to physical request ceiling exactly like legacy",async()=>{
  const failed={id:"failed-1",reason:"transport_unknown",heldReferenceMicroUsd:1,apiMs:1,requestStartedAt:1,rateWaitMs:0,errorCategory:"test"};
  const service=await fake({ok:true,output:output("stop",{failedModelAttempts:[failed]})}),host=await localRuntime(await temporary(),service.url),task=await loadTask("multi_turn_base_0");
  try {
    const opts={...taskOptions("retry-limit"),perTaskRequests:2};
    const result=await runTask(host.runtime,task,{...opts,handles:host.handles,bindings:host.bindings});
    assert.equal(service.requests.length,1);assert.equal(result.physicalModelRequests,2);assert.deepEqual(result.failedModelAttempts,[failed]);
    const old=await oldExecute({tool:async()=>({}),infer:async()=>({result:{output:output("stop",{failedModelAttempts:[failed]})}})},task,opts.taskId,
      {mode:opts.mode,perTaskRequests:2,settings:{model:{model:opts.model,maxOutputTokens:opts.maxOutputTokens}}});
    assert.deepEqual(result,old);
  }finally{await host.runtime.close();await service.close();}
});
test("T4 debug full transcript and optional snapshot success/failure preserve old return shape",async()=>{
  const service=await fake({ok:true,output:output()}),host=await localRuntime(await temporary(),service.url),task=await loadTask("multi_turn_base_0");
  try {
    for(const failed of [false,true]) {
      const opts={...taskOptions(`debug/${failed}`),debug:true,snapshot:async()=>{if(failed)throw new Error("diagnostic failure");return {diagnostic:"snapshot"};}};
      const result=await runTask(host.runtime,task,{...opts,handles:host.handles,bindings:host.bindings});
      const old=await oldExecute({tool:async(_id:string,request:any)=>request.action==="snapshot"?opts.snapshot():{},infer:async()=>({result:{output:output()}})},task,opts.taskId,
        {debug:true,mode:opts.mode,perTaskRequests:100,settings:{model:{model:opts.model,maxOutputTokens:opts.maxOutputTokens}}});
      assert.deepEqual(result,old);assert.equal(result.transcriptFormat,"full");
    }
  }finally{await host.runtime.close();await service.close();}
});
for(const node of ["INFER.REASONING.SAMPLE","MEMORY.WRITE"])for(const status of ["failed","timeout","cancelled"])test(`T4 ${node} ${status} is runtime failure`,async()=>{
  const service=await fake({ok:true,output:output()}),host=await localRuntime(await temporary(),service.url,"Monolithic",{},(n,_i,r)=>n===node?{status,error:{message:`injected-${status}`}}:r);
  try {await assert.rejects(runTask(host.runtime,await loadTask("multi_turn_base_0"),{...taskOptions(`failure/${node}/${status}`),handles:host.handles,bindings:host.bindings}),e=>e instanceof TaskRunError&&e.executionOutcome==="runtime_failure"&&e.message.includes(`injected-${status}`));}
  finally{await host.runtime.close();await service.close();}
});
test("T4 endpoint run_stop propagates",async()=>{
  const service=await fake({ok:false,error:{kind:"run_stop",details:{message:"stop-run"}}}),host=await localRuntime(await temporary(),service.url);
  try{await assert.rejects(runTask(host.runtime,await loadTask("multi_turn_base_0"),{...taskOptions("run-stop"),handles:host.handles,bindings:host.bindings}),/BFCL_RUN_STOP/);}
  finally{await host.runtime.close();await service.close();}
});
for(const group of ["Monolithic","Uniform","Targeted"] as const)for(const mode of ["cancelled","limit","thrown"])test(`T4 cleanup ${group}/${mode}: no leftover task, other task preserved`,async()=>{
  const host=await localRuntime(await temporary(),undefined,group,{providerFactory:()=>({invoke:async()=>output() as any})});
  const taskId=`cleanup/${group}/${mode}`,otherId=taskId+"/other",c=host.bindings["bfcl-open"].load,a=host.bindings["bfcl-open"].init;
  const abort=new AbortController();let pid=0;
  const other:any=await host.runtime.invoke("INTERACTION.ACT.TOOL",{call:{id:"other-init",name:"bfcl_bridge",arguments:{taskId:otherId,request:{action:"init",case_id:"multi_turn_base_1"}}}},{workerId:a});
  const otherPid=other.structuredContent.pythonPid;
  await host.runtime.invoke("CONTEXT.LOAD",{scope:{sessionId:otherId},sources:[{id:"other",content:"other"}]},{workerId:c});
  try {
    await assert.rejects(runTask(host.runtime,await loadTask("multi_turn_base_0"),{...taskOptions(taskId),handles:host.handles,bindings:host.bindings,
      signal:abort.signal,maxIterations:mode==="limit"?1:undefined,onStage(s,o){if(s==="open"){pid=o.init.structuredContent.pythonPid;if(mode==="cancelled")abort.abort(new Error("cancelled-by-test"));if(mode==="thrown")throw new Error("thrown-by-test");}}}),mode==="limit"?/Loop iteration limit/:mode==="cancelled"?/cancelled-by-test/:/thrown-by-test/);
    assert(pid>0);assert(!alive(pid));assert(alive(otherPid));
    await assert.rejects(host.runtime.invoke("CONTEXT.LOAD",{scope:{sessionId:taskId}},{workerId:c}),/absent or expired/);
    const preserved:any=await host.runtime.invoke("CONTEXT.LOAD",{scope:{sessionId:otherId}},{workerId:c});assert.equal(preserved.items[0].content,"other");
    console.log(JSON.stringify({group,mode,pid,otherPid,taskPythonExited:true,taskContextAbsent:true,otherTaskPreserved:true}));
  } finally {await host.runtime.close();}assert(!alive(otherPid));
});
test("T4 primary and cleanup failures are both retained; every cleanup attempted",async()=>{
  const seen:number[]=[];
  await assert.rejects(withTaskCleanup("error-pair",async()=>{throw new Error("original");},[async()=>{seen.push(1);throw new Error("cleanup");},async()=>{seen.push(2);}]),e=>e instanceof TaskRunError&&e.errors.length===2&&e.message.includes("original")&&e.message.includes("cleanup"));assert.deepEqual(seen,[1,2]);
});
test("T4 wrong fixed capability is rejected by Ditto",async()=>{
  const host=await localRuntime(await temporary(),undefined,"Uniform",{providerFactory:()=>({invoke:async()=>output() as any})});
  try{await assert.rejects(runTask(host.runtime,await loadTask("multi_turn_base_0"),{...taskOptions("bad-binding"),handles:host.handles,bindings:createBindings("Uniform",{context:"Context",interaction:"Context",memory:"Memory"})}),/does not expose INTERACTION.ACT.TOOL/);}
  finally{await host.runtime.close();}
});
