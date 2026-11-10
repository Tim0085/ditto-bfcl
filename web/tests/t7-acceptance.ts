import assert from "node:assert/strict";
import { mkdir,writeFile,readFile } from "node:fs/promises";
import { join,resolve } from "node:path";
import { deploy } from "../src/ts/deploy.ts";
import { deployTimeouts } from "../src/ts/deploy-timeouts.ts";
import { lines } from "../src/ts/step-log.ts";
import { block,egress,launchBlock,command,python,alive } from "./t7-helpers.ts";
const root=resolve(process.argv[2]);await mkdir(root,{recursive:true});
const cases=["multi_turn_base_0","multi_turn_base_4","multi_turn_miss_func_0","multi_turn_miss_func_4","multi_turn_miss_param_0","multi_turn_miss_param_36","multi_turn_long_context_0","multi_turn_long_context_121","multi_turn_miss_func_3"];
const casesFile=join(root,"cases.json");await writeFile(casesFile,JSON.stringify(cases),{flag:"wx"});
const gateway=await egress(root,"replay");
try{
  for(const [group,copies] of [
    ...[1,4,8].map(All=>["Monolithic",{All}]),
    ...[2,4,8].map(n=>["Uniform",{Context:n,Infer:n,Interaction:n,Memory:n}]),
    ...[5,4,8].map(Infer=>["Targeted",{Context:1,Infer,Interaction:1,Memory:1}]),
  ] as const){
    const b=await block(root,gateway.url),directory=join(root,"shapes",`${group}-${Object.values(copies).join("-")}`);await mkdir(directory,{recursive:true});
    const pool=await deploy({group:group as any,copies:copies as any,python,modelEndpoint:gateway.url,directory,timeouts:deployTimeouts(b.egress)});
    const workers=pool.runtime.workers();console.log(JSON.stringify({shape:group,copies,workers:workers.map(w=>({...w,pid:pool.units.find(u=>u.id===w.address.workerId)!.child.pid,concurrency:"unlimited"}))}));assert.equal(workers.length,Object.values(copies).reduce((a,b)=>a+b,0));
    await pool.close();assert(pool.units.every(u=>!alive(u.child.pid!)));
  }
  const configs=[
    {group:"Direct",id:"direct-c1",c:1},{group:"Direct",id:"direct-c8",c:8},
    {group:"Monolithic",id:"mono-1-c1",c:1},{group:"Monolithic",id:"mono-8-c8",c:8},
    {group:"Uniform",id:"uniform-8-c8",c:8},{group:"Uniform",id:"uniform-32-c8",c:8},
    {group:"Targeted",id:"targeted-8-c8",c:8},
  ] as const;
  for(const config of configs){
    const b=await block(root,gateway.url,config.group,config.id,config.c,cases);
    if(config.id==="uniform-32-c8")b.copies={Context:8,Infer:8,Interaction:8,Memory:8};
    const run=await launchBlock(b),result=await run.done;assert.equal(result.code,0,JSON.stringify(result));
    const steps=lines(join(run.directory,"steps.jsonl"));
    const lifecycle=JSON.parse(await readFile(join(run.directory,"lifecycle.json"),"utf8"));
    assert(lifecycle.processes.every((p:any)=>p.exited&&!alive(p.pid)));
    for(const step of steps){
      assert(step.taskId);assert(step.node);assert(step.pid);assert(step.started&&step.ended);assert(BigInt(step.started.ns)<=BigInt(step.ended.ns));
      if(b.group==="Direct"){assert.equal(step.workerId,null);assert.equal(step.ipcMs,null);assert.equal(step.queueMs,null);}
      else{assert.equal(step.match,"matched");assert(BigInt(step.sent.ns)<=BigInt(step.received.ns));assert(BigInt(step.received.ns)<=BigInt(step.started.ns));assert(BigInt(step.ended.ns)<=BigInt(step.returned.ns));}
    }
    for(const worker of lifecycle.processes){
      const own=steps.filter(s=>s.workerId===worker.id).sort((a,b)=>BigInt(a.started.ns)<BigInt(b.started.ns)?-1:1);
      for(let i=1;i<own.length;i++)assert(BigInt(own[i-1].ended.ns)<=BigInt(own[i].started.ns));
      const services=lines(join(run.directory,"services.jsonl")).filter(s=>s.workerId===worker.id);
      if(worker.role!=="All")assert(services.every(s=>s.capability===worker.role));
      if(worker.role!=="All"&&worker.role!=="Interaction")assert(own.every(s=>!s.pythonPid));
    }
    for(const caseId of cases){
      const path=join(run.directory,"tasks",caseId+".r1.json"),task=JSON.parse(await readFile(path,"utf8"));
      for(const step of steps.filter(s=>s.taskId===task.taskId)){
        if(b.group==="Monolithic")assert.equal(step.workerId,task.assignment.worker);
        if(b.group==="Uniform"||b.group==="Targeted"){
          if(step.node.startsWith("CONTEXT."))assert.equal(step.workerId,task.assignment.context);
          if(step.node==="INTERACTION.ACT.TOOL")assert.equal(step.workerId,task.assignment.interaction);
          if(step.node.startsWith("MEMORY."))assert.equal(step.workerId,task.assignment.memory);
        }
      }
      const output=join(root,`${config.id}-${caseId}.score.json`);
      const score=await command(python,["-B","-X","utf8","src/python/score.py","--input",path,"--output",output],output+".process.json");assert.equal(score.code,0,JSON.stringify(score));
      const value=JSON.parse(await readFile(output,"utf8"));assert.equal(value.officialScoring,caseId!=="multi_turn_miss_func_3");
      if(caseId==="multi_turn_miss_func_3")assert.equal(value.scoringStatus,"not_evaluated_incomplete");
    }
    const directOverlaps=b.group!=="Direct"||b.c===1?null:steps.some((a,i)=>steps.slice(i+1).some(z=>a.taskId!==z.taskId&&BigInt(a.started.ns)<BigInt(z.ended.ns)&&BigInt(z.started.ns)<BigInt(a.ended.ns)));
    if(b.group==="Direct"&&b.c===8)assert.equal(directOverlaps,true);
    console.log(JSON.stringify({configId:config.id,exitCode:result.code,tasks:cases.length,steps:steps.length,services:lines(join(run.directory,"services.jsonl")).length,scoreExit0:cases.length,directOverlaps}));
  }
}finally{await gateway.close();}
const comparison=await command(python,["-B","-X","utf8","scripts/compare.py","--new-run",root,"--old-run","../../bfcl_direct/runs/multiturn-full800-001","--cases",casesFile,"--output",root+"-comparison"],join(root,"comparison-process.json"));
console.log(comparison.stdout);assert.equal(comparison.code,0,comparison.stderr);
console.log("PASS: 9 deployment shapes; 7 configurations x 9 cases; direct scoring; four comparison gates and cross-deployment");
