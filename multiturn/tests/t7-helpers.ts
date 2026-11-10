import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import assert from "node:assert/strict";
import type { Block } from "../src/ts/config-main.ts";
import { childEnvironment } from "../src/ts/deploy.ts";
export const python="E:/Anaconda3/python.exe";
export const temporary=()=>mkdtemp(join(tmpdir(),"t7-"));
export const alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch{return false;}};
export const sleep=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
export async function block(root:string,endpoint:string,group:Block["group"]="Direct",id="test",c=1,cases=["multi_turn_base_0"]):Promise<Block>{
  const egress=JSON.parse(await readFile("config/egress.offline.json","utf8"));
  return {runId:"t7",configId:id,group,c,round:1,...(group==="Direct"?{}:{copies:group==="Monolithic"?{All:c}:group==="Uniform"?{Context:2,Infer:2,Interaction:2,Memory:2}:{Context:1,Infer:5,Interaction:1,Memory:1}}),
    caseIds:cases,modelEndpoint:endpoint,model:"deepseek-flash",maxOutputTokens:65536,perTaskRequests:100,mode:"offline-reference",debug:true,python,outputRoot:root,
    sampling:{enabled:true,strict:false,expected:{cpuMax:"200000 100000",memoryMax:String(4*1024**3),swapMax:"0"}},egress};
}
export async function command(file:string,args:string[],output:string){
  const child=spawn(file,args,{windowsHide:true,stdio:["ignore","pipe","pipe"],env:childEnvironment()});
  let stdout="",stderr="";child.stdout.on("data",b=>stdout+=b);child.stderr.on("data",b=>stderr+=b);
  const code=await new Promise<number|null>((yes,no)=>{child.once("error",no);child.once("close",yes);});
  await writeFile(output,JSON.stringify({command:[file,...args],code,stdout,stderr},null,2),{flag:"wx"});
  return {code,stdout,stderr};
}
export async function launchBlock(b:Block){
  const path=join(b.outputRoot,b.configId+".block.json");await mkdir(b.outputRoot,{recursive:true});await writeFile(path,JSON.stringify(b),{flag:"wx"});
  const child=spawn(process.execPath,["--import","./scripts/egress-offline-guard.mjs","--experimental-transform-types","src/ts/config-main.ts","--block",path],
    {windowsHide:true,stdio:["ignore","pipe","pipe"],env:childEnvironment()});
  let stdout="",stderr="";child.stdout.on("data",b=>stdout+=b);child.stderr.on("data",b=>stderr+=b);
  const done=new Promise<{code:number|null;stdout:string;stderr:string}>((yes,no)=>{child.once("error",no);child.once("close",async code=>{
    const result={code,stdout,stderr};await writeFile(join(b.outputRoot,b.configId+".process.json"),JSON.stringify(result,null,2),{flag:"wx"});yes(result);
  });});
  return {child,done,directory:join(b.outputRoot,"configs",b.configId)};
}
export async function egress(root:string,backend:"fixtures"|"replay"){
  const config=JSON.parse(await readFile("config/egress.offline.json","utf8"));config.replay.failOnDifference=true;
  const path=join(root,"egress-config.json");await writeFile(path,JSON.stringify(config),{flag:"wx"});
  const child=spawn(process.execPath,["--import","./scripts/egress-offline-guard.mjs","--experimental-transform-types","src/ts/egress/server.ts","--backend",backend,"--host","127.0.0.1","--port","0","--config",path,"--output",join(root,"egress")],
    {windowsHide:true,stdio:["ignore","pipe","pipe","ipc"],env:childEnvironment()});
  let stdout="",stderr="";child.stderr!.on("data",b=>stderr+=b);
  const ended=new Promise<number|null>(yes=>child.once("close",yes));
  const ready=await new Promise<any>((yes,no)=>{
    child.once("error",no);child.once("exit",code=>no(new Error(`Egress ${code}: ${stderr}`)));
    child.stdout!.on("data",b=>{stdout+=b;for(const line of stdout.split("\n").slice(0,-1)){try{const r=JSON.parse(line);if(r.ready)yes(r);}catch{}}});
  });
  return {url:ready.url,async close(){child.send("shutdown");const code=await ended;await writeFile(join(root,"egress-process.json"),JSON.stringify({code,stdout,stderr},null,2));assert.equal(code,0,stderr);}};
}
export const sampleInput={messages:[{role:"user",content:"test"}],actions:[],model:{provider:"configured",model:"deepseek-flash"},generation:{maxTokens:65536},metadata:{taskId:"probe/task",caseId:"multi_turn_base_0",configId:"probe",turn:1,step:1}};
export const sampleOutput={message:{role:"assistant",content:"done"},finishReason:"stop",actionRequests:[],usage:{inputTokens:1,outputTokens:1,totalTokens:2}};
export async function fakeServer(handler:(body:any,res:ServerResponse)=>void){
  let early=0,requests=0;
  const server=createServer(async(req,res)=>{
    const chunks:Buffer[]=[];for await(const c of req)chunks.push(Buffer.from(c));requests++;
    res.once("close",()=>{if(!res.writableEnded)early++;});handler(JSON.parse(Buffer.concat(chunks).toString()),res);
  });
  server.requestTimeout=0;server.timeout=0;server.listen(0,"127.0.0.1");await once(server,"listening");
  return {url:`http://127.0.0.1:${(server.address() as any).port}`,get early(){return early;},get requests(){return requests;},async close(){server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}};
}
