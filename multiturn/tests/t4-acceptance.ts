// Explicit evidence runner. Ordinary tests never write inside the package.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, readFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { egress, localRuntime, legacy, taskOptions, temporary, python, selectedCases } from "./t4-helpers.ts";
import { loadTask, MULTI_TURN_CATEGORIES } from "../src/ts/tool-actions.ts";
import { createDirectSteps } from "../src/ts/direct-steps.ts";
import { runDirectTask } from "../src/ts/direct-task.ts";
import { runTask } from "../src/ts/task-loop.ts";
import { graphManifest, graphFingerprint } from "../src/ts/graphs.ts";

const backend=process.argv[2] as "replay"|"fixtures";
if(!["replay","fixtures"].includes(backend))throw new Error("replay or fixtures required");
const count=Number(process.argv[3]??(backend==="replay"?3:25));
const root=process.argv[4]??await temporary();await mkdir(root,{recursive:true});
const output=await mkdtemp(join(root,backend+"-"));
const gateway=await egress(backend,join(output,"egress"));
const host=await localRuntime(join(output,"memory"),gateway.url);
const direct=createDirectSteps({python,memoryDirectory:join(output,"direct-memory"),inferenceTimeoutMs:30000,modelEndpoint:gateway.url});
const selection=selectedCases(backend,count);
await writeFile(join(output,"selection.json"),JSON.stringify(selection,null,2));
await writeFile(join(output,"graphs.json"),JSON.stringify({fingerprint:graphFingerprint(),manifest:graphManifest()},null,2));
let requests=0,tools=0,scores=0,missingToolTurn=false,clarification=false;
async function score(result:any) {
  // score.py candidate mode directly evaluates executeTask's return format.
  const p=spawn(python,["-B","-X","utf8","src/python/score.py","--candidate"],{windowsHide:true,stdio:["pipe","pipe","pipe"]});
  let stdout="",stderr="";p.stdout.on("data",x=>stdout+=x);p.stderr.on("data",x=>stderr+=x);
  const exited=new Promise<number|null>(r=>p.once("exit",r));p.stdin.end(JSON.stringify(result));assert.equal(await exited,0,stderr);
  await writeFile(join(output,result.caseId+".score-output.log"),stdout+stderr,{flag:"wx"});
  const actual=JSON.parse(stdout),old=await legacy(result.caseId,"scores");
  for(const key of ["caseId","valid","official_result","irrelevance_result","decoded_calls","bfclCommit","checkerSha256"])assert.deepEqual(actual[key],old[key],`${result.caseId} score ${key}`);
  scores++;
}
try {
  for(const caseId of selection) {
    const task=await loadTask(caseId),id=`t4/Monolithic/r1/${caseId}`,opts=taskOptions(id);
    const graphs:any[]=[];
    const result=await runTask(host.runtime,task,{...opts,handles:host.handles,bindings:host.bindings,onGraph:e=>graphs.push(e)});
    await writeFile(join(output,caseId+".json"),JSON.stringify(result));
    await writeFile(join(output,caseId+".graphs.json"),JSON.stringify(graphs));
    if(backend==="replay") {
      const old=await legacy(caseId);
      for(const key of ["completed","executionOutcome","completedTurns","termination"])assert.deepEqual(result[key],old[key],`${caseId} ${key}`);
      const directResult=await runDirectTask(direct,task,{...opts,taskId:`t4/Direct/r1/${caseId}`});
      for(const key of ["completed","executionOutcome","completedTurns","termination","usage"])assert.deepEqual(directResult[key],result[key],`${caseId} Direct ${key}`);
      await writeFile(join(output,caseId+".direct.json"),JSON.stringify(directResult));
      await score(result);
      missingToolTurn ||= !!task.missed_function && Object.keys(task.missed_function).some(t=>task.question[Number(t)].length===0);
      if(caseId==="multi_turn_miss_param_10") {
        const asking=old.modelSteps.filter((s:any)=>s.turn===5);
        assert.equal(asking.length,1);assert.equal(asking[0].output.finishReason,"stop");
        assert.equal(old.completed.filter((c:any)=>c.turn===5).length,0);
        assert.match(asking[0].output.message.content,/Which file would you like me to count characters in/);
        assert.match(task.question[5][0].content as string,/summary\.txt/);
        const proof={caseId,askTurn:5,answerTurn:6,question:asking[0].output.message.content,userReply:task.question[5],toolCallsOnAskTurn:0};
        await writeFile(join(output,"clarification.json"),JSON.stringify(proof,null,2));console.log(JSON.stringify(proof));clarification=true;
      }
    }
    requests+=result.usage.requests;tools+=result.completed.length;
    console.log(JSON.stringify({backend,caseId,requests:result.usage.requests,tools:result.completed.length,outcome:result.executionOutcome,completedTurns:result.completedTurns,legacyAndDirectMatched:backend==="replay"}));
    host.events.length=0;
  }
  if(backend==="replay") {
    let positions=0;const graphBodies=new Map<string,any>();
    for await(const line of createInterface({input:createReadStream(join(gateway.output,"requests.jsonl")),crlfDelay:Infinity})) {
      const row=JSON.parse(line);assert.equal(row.differences.length,0);positions++;
      if(row.taskId.includes("/Monolithic/"))graphBodies.set(row.position,row.requestBody);
      else assert.deepEqual(row.requestBody,graphBodies.get(row.position));
    }
    assert.equal(positions,2*requests);assert(missingToolTurn);assert(clarification);
  }
  const summary={backend,cases:selection.length,requests,tools,scores,requestMismatches:0,missingToolTurn,clarification,output};
  await writeFile(join(output,"summary.json"),JSON.stringify(summary,null,2));console.log(JSON.stringify(summary));
} finally {await direct.dispose();await host.runtime.close();await gateway.close();}
