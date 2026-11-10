import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDitto } from "@codesoul-co/ditto";
import type { ModelProvider } from "@codesoul-co/ditto/worker/infer";
import { createAgentCoreWorker, type AgentCoreInstanceHandle } from "../src/ts/agent-core.ts";
import { createDirectSteps } from "../src/ts/direct-steps.ts";
import { runBlock } from "../src/ts/config-main.ts";
import { runDirectTask, type TaskOptions } from "../src/ts/direct-task.ts";
import { runTask } from "../src/ts/task-loop.ts";
import { createBindings } from "../src/ts/bindings.ts";
import { categoryOf, loadActions, loadTask, loadTasks } from "../src/ts/tool-actions.ts";
import { catalog, profileNumbers } from "../src/ts/scheduler/plan.ts";
import { buildRequest, modelSystem, parseResponse, parseUsage } from "../src/ts/egress/model.ts";
import { offlineTransport } from "../src/ts/egress/offline.ts";
import { diffFields, positionKey, replayBackend } from "../src/ts/egress/backends/replay.ts";

const json=async(path:string)=>JSON.parse(await readFile(path,"utf8"));
const modelSource="data/replay/models", indexFile=join(modelSource,"index.json");
const python=process.platform==="win32"?"E:/Anaconda3/python.exe":"python3";
const settings=(await json("config/egress.offline.json")).settings;
Object.assign(settings.model,{model:"deepseek-flash",protocol:"chat-completions",reasoningEffort:"high",maxOutputTokens:65536});
const replayOptions={source:modelSource,index:indexFile,failOnDifference:false};
const options=(taskId:string,mode:"fixture"|"replay"):TaskOptions=>({
  taskId,configId:"test",model:settings.model.model,maxOutputTokens:settings.model.maxOutputTokens,
  perTaskRequests:100,mode:"offline-reference",debug:true,web:{mode}
});
const digest=(value:Buffer)=>createHash("sha256").update(value).digest("hex");
const parsed=(raw:any)=>({...parseResponse(raw,"chat-completions"),usage:parseUsage(raw,"chat-completions")});

test("100 Web tasks, initial config, profile IDs and first recorded wire requests",async()=>{
  const tasks=await loadTasks();
  assert.deepEqual(catalog(),tasks);
  assert.equal(tasks.length,100);
  assert.deepEqual(profileNumbers,[65,62,60,87,90,13,53,73,16,49,68,21]);
  assert.throws(()=>categoryOf("web_search_no_snippet_100"));
  for(const task of tasks) {
    assert.deepEqual(task.initial_config,{WebSearchAPI:{show_snippet:false}});
    assert.equal(task.question.length,1);
    assert.deepEqual((await loadActions(task.id)).map(a=>a.name),["search_engine_query","fetch_url_content"]);
  }
  const index=await json(indexFile);
  assert.equal(index.tasks.length,40);
  let compared=0;
  for(const caseId of index.tasks) {
    const task=await loadTask(caseId);
    const entry=index.records[positionKey(caseId,1,1)];
    const old=await json(join(modelSource,"model-records",entry.file));
    const body=buildRequest({messages:[modelSystem,...task.question[0]],actions:await loadActions(caseId),
      model:{model:settings.model.model}},settings);
    assert.deepEqual(body.messages,old.requestBody.messages);
    assert.deepEqual(diffFields(old.requestBody.tools,body.tools).map(d=>d.path),["$.0.function.strict","$.1.function.response","$.1.function.strict"]);
    compared++;
  }
  console.log(JSON.stringify({catalog:tasks.length,firstRequestsCompared:compared,messagesDiffs:0,toolDiffs:["tools[0].function.strict","tools[1].function.response","tools[1].function.strict"]}));
});

test("Web model fixture maintains strict complete request matching and drives both Python tools",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"web-fixture-"));
  const fixture=await offlineTransport(settings);
  const steps=createDirectSteps({python,memoryDirectory:dir,inferenceTimeoutMs:10000,
    providerFactory:()=>({async invoke(input,{signal}) {
      const body=buildRequest(input,settings);
      const caseId=String(input.metadata?.caseId);
      if(input.metadata?.step===1)await assert.rejects(fixture.invoke(caseId,{...body,max_tokens:1},signal),/不匹配/);
      return parsed(await fixture.invoke(caseId,body,signal));
    }})});
  try {
    const task=await loadTask("web_search_no_snippet_0");
    const result=await runDirectTask(steps,task,options("fixture","fixture"));
    assert.equal(result.executionOutcome,"completed");
    assert.deepEqual(result.completed.map((call:any)=>call.tool),["search_engine_query","fetch_url_content"]);
    assert.equal(result.completed[1].result.observation,'{"content":"Fixture webpage body."}');
  } finally {await steps.dispose();await rm(dir,{recursive:true,force:true});}
});

test("replay format, real stepped request comparison, and oversized observation across both drivers",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"web-replay-"));
  const index=await json(indexFile), selection=await json("config/web-replay-selection.json");
  const large="web_search_no_snippet_38";
  const chosen=[large,...selection.cases.filter((c:any)=>c.caseId!==large&&c.toolCalls>0).slice(0,4).map((c:any)=>c.caseId)];
  const report:any[]=[];
  try {
    const replay=await replayBackend(replayOptions,dir);
    const provider:ModelProvider={async invoke(input,{signal}) {
      const {caseId,step,configId}=input.metadata!;
      const position=positionKey(String(caseId),1,Number(step)), entry=index.records[position];
      assert(entry,"missing model replay "+position);
      const bytes=await readFile(join(modelSource,"model-records",entry.file));
      assert.equal(digest(bytes),entry.sha256);
      const old=JSON.parse(bytes.toString()), body=buildRequest(input,settings);
      const paths=diffFields(old.requestBody,body).map(diff=>diff.path);
      report.push({caseId,step,configId,paths});
      assert.deepEqual(paths,["$.parallel_tool_calls","$.tool_choice","$.tools.0.function.strict","$.tools.1.function.response","$.tools.1.function.strict"]);
      return parsed(await replay(input,body,signal));
    }};
    const direct=createDirectSteps({python,memoryDirectory:join(dir,"direct"),inferenceTimeoutMs:10000,providerFactory:()=>provider});
    const toolReplay=await json("data/replay/tools/"+large+".json");
    const largest=toolReplay.calls.reduce((max:number,c:any)=>Math.max(max,Buffer.byteLength(JSON.stringify(c.observation))),0);
    assert(largest>1_000_000);
    const allOutcomes:any[]=[];
    function validate(result:any, group:string) {
      assert.equal(result.executionOutcome,"input_limit");
      assert.equal(result.termination.source,"context");
      assert.equal(result.termination.maxRequestBytes,1_000_000);
      assert(result.termination.inputBytes>1_000_000);
      assert(result.messages.every((m:any)=>m.role!=="tool"||Buffer.byteLength(JSON.stringify(m.content))<=1_000_000));
      assert(!result.completed.some((c:any)=>c.id===result.termination.toolCallId));
      allOutcomes.push({group,...result.termination,completed:result.completed.length});
    }
    try {
      for(const caseId of chosen) {
        const result=await runDirectTask(direct,await loadTask(caseId),options("compare/"+caseId,"replay"));
        if(caseId===large)validate(result,"Direct");else assert.equal(result.executionOutcome,"completed");
      }
    } finally {await direct.dispose();}
    for(const group of ["Monolithic","Uniform","Targeted"] as const) {
      const runtime=createDitto();
      const handles=new Map<string,AgentCoreInstanceHandle>();
      const ids=group==="Monolithic"?["all"]:["c","a","m"];
      for(const id of ids)runtime.register(createAgentCoreWorker({python,memoryDirectory:join(dir,group,id),inferenceTimeoutMs:10000,
        providerFactory:()=>provider,onInstance:handle=>handles.set(id,handle)}),id);
      try {
        const bindings=createBindings(group,group==="Monolithic"?{worker:"all"}:{context:"c",interaction:"a",memory:"m"});
        const result=await runTask(runtime,await loadTask(large),{...options(group+"/"+large,"replay"),configId:group,handles,bindings});
        validate(result,group);
      } finally {await runtime.close();}
    }
    assert.equal(new Set(allOutcomes.map(o=>o.inputBytes)).size,1);
    console.log(JSON.stringify({cases:chosen,comparisons:report,inputLimit:allOutcomes}));
  } finally {await rm(dir,{recursive:true,force:true});}
});

test("Direct block publishes the context limit as a scored-denominator termination and proceeds to the next case",async()=>{
  const dir=await mkdtemp(join(tmpdir(),"web-limit-block-"));
  const index=await json(indexFile);
  const cases=["web_search_no_snippet_38","web_search_no_snippet_14"];
  const failures:unknown[]=[];
  const server=createServer(async(req,res)=>{
    try {
      assert.equal(req.url,"/v1/sample");
      const chunks:Buffer[]=[];
      for await(const chunk of req)chunks.push(Buffer.from(chunk));
      const {caseId,step}=JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const entry=index.records[positionKey(caseId,1,step)];
      const row=await json(join(modelSource,"model-records",entry.file));
      res.setHeader("content-type","application/json");
      res.end(JSON.stringify({ok:true,output:parsed(row.rawResponse)}));
    } catch(error) {failures.push(error);res.statusCode=500;res.end("test double failure");}
  });
  try {
    await new Promise<void>((ready,reject)=>{server.once("error",reject);server.listen(0,"127.0.0.1",ready);});
    const address=server.address();
    assert(address&&typeof address!=="string");
    const egress=await json("config/egress.offline.json");
    const summary=await runBlock({runId:"web-block",configId:"direct",group:"Direct",c:1,round:1,caseIds:cases,
      modelEndpoint:"http://127.0.0.1:"+address.port,model:settings.model.model,maxOutputTokens:65536,perTaskRequests:100,
      mode:"offline-reference",debug:true,python,outputRoot:dir,
      sampling:{enabled:false,strict:false,expected:{cpuMax:"",memoryMax:"",swapMax:""}},egress:{...egress,backend:"replay"}});
    assert.deepEqual(failures,[]);
    assert.equal(summary.completed,2);
    assert.equal(summary.failed,0);
    const first=join(dir,"configs","direct","tasks",cases[0]+".r1.json");
    const stopped=await json(first);
    const next=await json(join(dir,"configs","direct","tasks",cases[1]+".r1.json"));
    assert.equal(stopped.status,"terminated");
    assert.equal(stopped.executionOutcome,"input_limit");
    assert.equal(stopped.inputLimitEvents.length,1);
    assert.equal(stopped.inputLimitEvents[0].toolCallId,stopped.termination.toolCallId);
    assert.equal(next.executionOutcome,"completed");
    const scoreFile=join(dir,"score.json");
    const score=spawnSync(python,["-B","-X","utf8","src/python/score.py","--input",first,"--output",scoreFile],
      {encoding:"utf8",windowsHide:true});
    assert.equal(score.status,0,score.error?.message??score.stderr);
    const graded=await json(scoreFile);
    assert.equal(graded.valid,false);
    assert.equal(graded.officialScoring,false);
    assert.equal(graded.official_result,null);
    console.log(JSON.stringify({completed:summary.completed,failed:summary.failed,first:stopped.executionOutcome,
      second:next.executionOutcome,officialScoring:graded.officialScoring,inputLimitEvents:stopped.inputLimitEvents.length}));
  } finally {
    server.closeAllConnections();
    if(server.listening)await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
    await rm(dir,{recursive:true,force:true});
  }
});
