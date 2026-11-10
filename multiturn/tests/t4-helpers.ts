import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createDitto, loadRuntimeConfig } from "@codesoul-co/ditto";
import { createAgentCoreWorker, CAPABILITIES, type AgentCoreInstanceHandle, type AgentCoreOptions } from "../src/ts/agent-core.ts";
import { createBindings, type Group } from "../src/ts/bindings.ts";
import { loadEgressConfig } from "../src/ts/egress/config.ts";
import type { TaskOptions } from "../src/ts/direct-task.ts";
import { MULTI_TURN_CATEGORIES } from "../src/ts/tool-actions.ts";

export const temporary = () => mkdtemp(join(tmpdir(),"t4-"));
/** miss_param_10 explicitly asks for the filename in turn 5; the user supplies it in turn 6. */
export function selectedCases(backend:"fixtures"|"replay",count:number) {
  if(!Number.isSafeInteger(count)||count<1||count>200)throw new Error("Invalid per-category sample size");
  return MULTI_TURN_CATEGORIES.flatMap(category=>{
    const indices=Array.from({length:count},(_,i)=>i);
    if(backend==="replay"&&category==="multi_turn_miss_param"&&!indices.includes(10))indices[count-1]=10;
    return indices.map(i=>`${category}_${i}`);
  });
}
export const python = process.env.T3_PYTHON ?? "E:/Anaconda3/python.exe";
export function alive(pid:number) { try {process.kill(pid,0);return true;} catch(error) {if((error as NodeJS.ErrnoException).code==="ESRCH")return false;throw error;} }
export const taskOptions=(taskId:string):TaskOptions=>({taskId,configId:"t4",model:"deepseek-flash",maxOutputTokens:65536,perTaskRequests:100,mode:"offline-reference"});
export async function localRuntime(directory:string,endpoint?:string,group:Group="Monolithic",extra:Partial<AgentCoreOptions>={},intercept?:(node:string,input:any,result:any)=>any,extraCopies=false) {
  const runtime=createDitto({config:loadRuntimeConfig({})});
  const handles=new Map<string,AgentCoreInstanceHandle>(),events:any[]=[];
  const ids=group==="Monolithic"?["all"]:["Context","Infer","Interaction","Memory"];
  if(extraCopies&&group!=="Monolithic")ids.push("Infer-2","Interaction-2");
  for(const id of ids) {
    const definition=createAgentCoreWorker({python,memoryDirectory:join(directory,id),inferenceTimeoutMs:30000,
      ...(endpoint?{modelEndpoint:endpoint}:{}),...extra,onInstance:h=>handles.set(id,h)});
    runtime.register({...definition,capabilities:id==="all"?definition.capabilities:CAPABILITIES[id.split("-")[0] as keyof typeof CAPABILITIES],instantiate(){
      const executor=definition.instantiate();
      return {dispose:()=>executor.dispose?.(),async execute(node,input,ctx){
        let result:any=await executor.execute(node,input,ctx);
        if(intercept) result=intercept(node,input,result);
        events.push({node,workerId:ctx.worker.workerId,execution:ctx.execution,input,result});
        return result;
      }};
    }},{id});
  }
  const bindings=createBindings(group,group==="Monolithic"?{worker:"all"}:{context:"Context",interaction:"Interaction",memory:"Memory"});
  return {runtime,handles,bindings,events};
}
export async function egress(backend:"fixtures"|"replay",directory:string) {
  await mkdir(directory,{recursive:true});
  const config=await loadEgressConfig("config/egress.offline.json",backend);
  config.replay!.failOnDifference=true;
  const path=join(directory,"config.json");await writeFile(path,JSON.stringify(config),{flag:"wx"});
  const child=spawn(process.execPath,["--import","./scripts/egress-offline-guard.mjs","--experimental-transform-types",
    "src/ts/egress/server.ts","--backend",backend,"--host","127.0.0.1","--port","0","--config",path,"--output",join(directory,"gateway")],
    {windowsHide:true,stdio:["ignore","pipe","pipe","ipc"],env:{...process.env,PYTHONDONTWRITEBYTECODE:"1"}});
  let stderr="",stdout="";child.stderr!.on("data",x=>stderr+=x);
  const exited=new Promise<number|null>(r=>child.once("exit",r));
  const ready=await new Promise<any>((yes,no)=>{
    child.once("error",no);child.once("exit",code=>no(new Error(`egress exited ${code}: ${stderr}`)));
    child.stdout!.on("data",x=>{stdout+=x;for(const line of stdout.split("\n").slice(0,-1)) {try{const r=JSON.parse(line);if(r.ready)yes(r);}catch{}}});
  });
  return {url:ready.url,pid:ready.pid,config,output:join(directory,"gateway"),async close(){
    child.send("shutdown");const code=await exited;
    await writeFile(join(directory,"server.log"),stdout+stderr+`\nEXIT_CODE=${code}\n`,{flag:"wx"});
    assert.equal(code,0,stderr);
  }};
}
export const legacyRoot=resolve("../../bfcl_direct/runs/multiturn-full800-001");
export async function legacy(caseId:string,kind="tasks") {
  return JSON.parse(await readFile(join(legacyRoot,"full",caseId.replace(/_\d+$/,""),"monolithic/monolithic-c1",kind,caseId+".json"),"utf8"));
}
