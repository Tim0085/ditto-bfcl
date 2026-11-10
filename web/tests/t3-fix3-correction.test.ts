import test from "node:test";
import assert from "node:assert/strict";
import fsp, { mkdtemp, readFile, writeFile, readdir, cp, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { createMemoryStore } from "../src/ts/memory-store.ts";
import { createDirectSteps } from "../src/ts/direct-steps.ts";
import { loadTask } from "../src/ts/tool-actions.ts";
import { runDirectTask } from "../src/ts/direct-task.ts";
import { runTask } from "../src/ts/task-loop.ts";
import { localRuntime, taskOptions } from "./t4-helpers.ts";
import { block, launchBlock, fakeServer, sampleInput, sampleOutput, python, sleep } from "./t7-helpers.ts";
import { childEnvironment } from "../src/ts/deploy.ts";
import { startEgress } from "../src/ts/egress/server.ts";
import { loadEgressConfig } from "../src/ts/egress/config.ts";
import { mockResponse } from "../src/ts/egress/mock.ts";
const root = () => mkdtemp(join(process.env.T3_FIX3_EVIDENCE ?? tmpdir(), "correction-"));
const absent = async (path: string) => { await assert.rejects(access(path), (e: any) => e.code === "ENOENT"); };

test("M1 one canonical JSON: old before commit, current attempt only after commit, copied attempt separate", async () => {
  const dir = await root(), oldDir = join(dir, "attempt-1"), currentDir = join(dir, "attempt-2");
  const oldStore = createMemoryStore(oldDir);
  await oldStore.write({ memories: [1,2].map(turn => ({key: "task/turn-" + turn, content: {attempt: "old", turn}})) });
  const file = (await readdir(oldDir))[0], oldBytes = await readFile(join(oldDir, file), "utf8");
  await cp(oldDir, currentDir, {recursive:true});
  for (const target of [currentDir, oldDir]) {
    const store = createMemoryStore(target, {restartOnFirstWrite:true}), canonical = join(target,file);
    await assert.rejects(store.write({memories:[{key:"task/turn-1",content:{invalid:undefined}}]}), /JSON/);
    assert.equal(await readFile(canonical,"utf8"),oldBytes);
    let reached!: () => void, release!: () => void;
    const ready = new Promise<void>(r=>reached=r), gate = new Promise<void>(r=>release=r);
    const rename = fsp.rename; let tempPath = "";
    fsp.rename = async (from,to) => { if(String(to)===canonical){tempPath=String(from);reached();await gate;} await rename(from,to); };
    syncBuiltinESMExports();
    const first = store.write({memories:[{key:"task/turn-1",content:{attempt:"new",turn:1}}]});
    let during: any;
    try {
      await ready;
      const files=await readdir(target), independent=await createMemoryStore(target).query({});
      assert.equal(await readFile(canonical,"utf8"),oldBytes);
      assert.equal(files.filter(n=>n.endsWith(".json")).length,1);
      assert.equal(files.filter(n=>n.endsWith(".tmp")).length,1);
      assert.deepEqual(independent.items.map(x=>(x.content as any).attempt),["old","old"]);
      assert.equal(JSON.parse(await readFile(tempPath,"utf8")).memories[0].content.attempt,"new");
      during={files,canonicalRecords:2,canonicalAttempt:"old",temporaryRecords:1,temporaryAttempt:"new",queryRecords:independent.items.length};
    } finally { release();fsp.rename=rename;syncBuiltinESMExports(); }
    await first;
    const firstBytes=await readFile(canonical,"utf8");
    await assert.rejects(store.write({memories:[{key:"task/turn-1",content:"duplicate"}]}),/已存在/);
    assert.equal(await readFile(canonical,"utf8"),firstBytes);
    for(const turn of [2,3,4])await store.write({memories:[{key:"task/turn-"+turn,content:{attempt:"new",turn}}]});
    const after=JSON.parse(await readFile(canonical,"utf8")),files=await readdir(target);
    assert.equal(after.memories.length,4);assert(after.memories.every((x:any)=>x.content.attempt==="new"));
    assert.deepEqual(files,[file]);
    if(target===currentDir)assert.equal(await readFile(join(oldDir,file),"utf8"),oldBytes);
    const proof={target,during,after:{files,records:4,attempts:after.memories.map((x:any)=>x.content.attempt)},duplicate:"rejected"};
    await writeFile(join(dir,target===currentDir?"new-directory.json":"same-directory.json"),JSON.stringify(proof,null,2));
    console.log(JSON.stringify(proof));
  }
});

async function service() {
  const dir=await root(),config=await loadEgressConfig("config/egress.offline.json","live");
  config.retryPolicy.maxRetries=0;
  let arrived!:()=>void,release!:()=>void,calls=0;
  const ready=new Promise<void>(r=>arrived=r),gate=new Promise<void>(r=>release=r);
  const remote=await fakeServer((_body,res)=>{const first=++calls===1;if(first)arrived();
    void(first?gate:Promise.resolve()).then(()=>res.end(JSON.stringify(mockResponse(sampleOutput as any,"deepseek-flash","chat-completions",0))));});
  const output=join(dir,"egress"),egress=await startEgress(config,output,{testUrl:remote.url});
  let disconnected=0;
  egress.server.on("request",(_req,res)=>res.once("close",()=>{if(!res.writableEnded)disconnected++;}));
  return {dir,ready,release,egress,output,get disconnected(){return disconnected;},get calls(){return calls;},
    async checkPending(){assert.equal(disconnected,0);assert.equal(egress.gateway.stopped,false);assert.equal(egress.gateway.ledger.snapshot().settled,0);await absent(join(output,"stopped.json"));},
    async close(){release();await egress.close();await remote.close();}};
}

for(const group of ["Direct","Monolithic"] as const)test(`corrected #5 planned stop ${group}: drain and other configuration completes`,async()=>{
  const s=await service(),b=await block(s.dir,s.egress.url,group,"planned-"+group,1,["multi_turn_base_0","multi_turn_base_4"]);
  const path=join(s.dir,"block.json");await writeFile(path,JSON.stringify(b));
  const args=["--import","./scripts/egress-offline-guard.mjs","--experimental-transform-types","tests/t3-fix3-planstop-child.ts",path];
  const child=spawn(process.execPath,args,{windowsHide:true,stdio:["ignore","pipe","pipe","ipc"],env:childEnvironment()});
  let stdout="",stderr="",exited=false;
  child.stdout!.on("data",b=>stdout+=b);child.stderr!.on("data",b=>stderr+=b);
  const done=new Promise<number|null>((r,j)=>{child.once("error",j);child.once("close",c=>{exited=true;r(c);});});
  try {
    await s.ready;
    const applied=new Promise<void>(r=>child.on("message",m=>{if(m==="planned-stop-applied")r();}));
    child.send("planned-stop");await applied;
    await sleep(200);await s.checkPending();assert.equal(exited,false);
    const during={waitMs:200,requests:s.calls,disconnected:s.disconnected,stoppedFile:false,settled:0,configExited:exited};
    s.release();const code=await done;
    await writeFile(join(s.dir,"planned-process.json"),JSON.stringify({command:[process.execPath,...args],code,stdout,stderr},null,2));
    assert.equal(code,1,stderr);
    const summary=JSON.parse(await readFile(join(s.dir,"configs",b.configId,"block-summary.json"),"utf8"));
    assert.equal(summary.interrupted,1);assert.equal(summary.notStarted,1);assert.equal(summary.completed,0);
    assert.equal(s.egress.gateway.ledger.snapshot().settled,1);await absent(join(s.output,"stopped.json"));
    const other=await block(s.dir,s.egress.url,group,"other-"+group,1,["multi_turn_base_0"]),run=await launchBlock(other),result=await run.done;
    assert.equal(result.code,0,JSON.stringify(result));
    const task=JSON.parse(await readFile(join(run.directory,"tasks","multi_turn_base_0.r1.json"),"utf8"));
    assert.equal(task.executionOutcome,"completed");assert.equal(task.completedTurns,4);
    assert.equal(s.egress.gateway.ledger.snapshot().settled,5);assert.equal(s.disconnected,0);await absent(join(s.output,"stopped.json"));
    console.log(JSON.stringify({dir:s.dir,group,during,summary,otherConfigCompletedTurns:task.completedTurns,settled:5,disconnected:0,stoppedFile:false}));
  } finally {s.release();await done;await s.close();}
});

for(const group of ["Direct","Uniform"] as const)test(`M2 ${group}: inspect real egress throughout cancelled-task wait`,async()=>{
  const s=await service(),task=await loadTask("multi_turn_base_0"),ctrl=new AbortController();
  const direct=group==="Direct"?createDirectSteps({python,modelEndpoint:s.egress.url,memoryDirectory:join(s.dir,"memory"),inferenceTimeoutMs:5000}):undefined;
  const graph=group==="Uniform"?await localRuntime(join(s.dir,"workers"),s.egress.url,"Uniform"):undefined;
  const options={...taskOptions("cancel-wait/"+group),signal:ctrl.signal};
  let returned=false;
  const pending=(direct?runDirectTask(direct,task,options):runTask(graph!.runtime,task,{...options,bindings:graph!.bindings,handles:graph!.handles}))
    .then(result=>{returned=true;return {result,error:undefined};},error=>{returned=true;return {result:undefined,error};});
  try {
    await s.ready;ctrl.abort(new Error("task cancellation"));await sleep(200);
    await s.checkPending();assert.equal(returned,false);
    const during={waitMs:200,returned,disconnected:s.disconnected,stoppedFile:false,settled:0};
    s.release();const outcome=await pending;assert.match(String(outcome.error),/task cancellation/);
    assert.equal(s.egress.gateway.ledger.snapshot().settled,1);assert.equal(s.disconnected,0);await absent(join(s.output,"stopped.json"));
    console.log(JSON.stringify({dir:s.dir,group,during,after:{settled:1,disconnected:0,stoppedFile:false,error:String(outcome.error)}}));
  } finally {s.release();await pending;if(direct)await direct.dispose();else await graph!.runtime.close();await s.close();}
});
