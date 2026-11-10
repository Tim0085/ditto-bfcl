import test from "node:test";
import assert from "node:assert/strict";
import { mkdir,writeFile,readFile } from "node:fs/promises";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { deploy,verifyBindings,childEnvironment } from "../src/ts/deploy.ts";
import { deployTimeouts } from "../src/ts/deploy-timeouts.ts";
import { createIpcTransport } from "@codesoul-co/ditto/runtime";
import { mergeSteps,lines } from "../src/ts/step-log.ts";
import { parseProc,resourceSampler } from "../src/ts/resource-sampler.ts";
import { runTask } from "../src/ts/task-loop.ts";
import { loadTask } from "../src/ts/tool-actions.ts";
import { toContextItems } from "../src/ts/context-messages.ts";
import { temporary,block,fakeServer,sampleInput,sampleOutput,sleep,alive,python } from "./t7-helpers.ts";
test("T7 per-worker FIFO, delay attribution, round robin, acknowledged cleanup and stop drain",async()=>{
  const directory=await temporary();const server=await fakeServer((_b,res)=>setTimeout(()=>res.end(JSON.stringify({ok:true,output:sampleOutput})),120));
  const b=await block(directory,server.url,"Uniform"),pool=await deploy({group:"Uniform",copies:b.copies!,python,modelEndpoint:server.url,directory,timeouts:deployTimeouts(b.egress)});
  try{
    const jobs=Array.from({length:8},(_,i)=>pool.runtime.invoke("INFER.REASONING.SAMPLE",{...sampleInput,metadata:{...sampleInput.metadata,taskId:`q/${i}`}} as any));
    const results=await Promise.all(jobs);assert(results.every(r=>r.status==="success"));
    const steps=mergeSteps(directory,false).filter(s=>s.node==="INFER.REASONING.SAMPLE");
    assert.equal(steps.length,8);assert(steps.every(s=>s.workMs>=110));assert(steps.some(s=>s.queueMs>=300));
    for(const id of ["Infer-1","Infer-2"]){const own=steps.filter(s=>s.workerId===id);assert.equal(own.length,4);for(let i=1;i<own.length;i++)assert(BigInt(own[i].started.ns)>=BigInt(own[i-1].ended.ns));}
    const a=pool.attach("binding/test");verifyBindings("Uniform",a.assignment,a.bindings,pool.runtime.workers());
    const missing=structuredClone(a.bindings);delete (missing["bfcl-think"] as any).select;assert.throws(()=>verifyBindings("Uniform",a.assignment,missing,pool.runtime.workers()),/Invalid binding/);
    const wrong=structuredClone(a.bindings);(wrong["bfcl-open"] as any).init="Context-1";assert.throws(()=>verifyBindings("Uniform",a.assignment,wrong,pool.runtime.workers()),/Invalid binding/);pool.detach("binding/test");
    const wait=pool.runtime.invoke("INFER.REASONING.SAMPLE",sampleInput as any);await sleep(40);pool.stop("test stop");
    assert.equal((await wait).status,"success");await assert.rejects(pool.runtime.invoke("INFER.REASONING.SAMPLE",sampleInput as any),/test stop/);assert.equal(server.early,0);
    console.log(JSON.stringify({queueMs:steps.map(s=>s.queueMs),workMs:steps.map(s=>s.workMs),earlyDisconnects:server.early}));
  }finally{await pool.close();await server.close();}assert(pool.units.every(u=>!alive(u.child.pid!)));
});
test("T7 Uniform task cleanup: normal, cancellation, loop limit, thrown node; other task survives",async()=>{
  const directory=await temporary(),server=await fakeServer((_b,res)=>setTimeout(()=>res.end(JSON.stringify({ok:true,output:sampleOutput})),30));
  const b=await block(directory,server.url,"Uniform"),pool=await deploy({group:"Uniform",copies:{Context:1,Infer:1,Interaction:1,Memory:1},python,modelEndpoint:server.url,directory,timeouts:deployTimeouts(b.egress)});
  const task=await loadTask("multi_turn_base_0");
  try{
    const other="other";await pool.runtime.invoke("CONTEXT.LOAD",{scope:{sessionId:other},sources:[]} as any,{workerId:"Context-1"});
    const init:any=await pool.runtime.invoke("INTERACTION.ACT.TOOL",{call:{id:"other-init",name:"bfcl_bridge",arguments:{taskId:other,request:{action:"init",case_id:task.id}}}} as any,{workerId:"Interaction-1"});
    const otherPid=init.structuredContent.pythonPid;
    for(const mode of ["normal","cancel","limit","throw"]){
      const taskId=`cleanup/${mode}`,a=pool.attach(taskId),controller=new AbortController();
      const taskData=structuredClone(task);if(mode==="throw")taskData.question[0]=[{role:"user",content:"x".repeat(1_000_001)}] as any;
      const promise=runTask(pool.runtime,taskData,{taskId,configId:"probe",model:b.model,maxOutputTokens:b.maxOutputTokens,perTaskRequests:100,mode:b.mode,
        bindings:a.bindings,handles:pool.handles,signal:controller.signal,...(mode==="limit"?{maxIterations:1}:{}),
        onStage:stage=>{if(stage==="open"&&mode==="cancel")controller.abort(new Error("cancel probe"));}});
      if(mode==="normal")await promise;else await assert.rejects(promise);
      const again=await pool.handles.get("Context-1")!.releaseTask(taskId);assert.equal(again.contextDeleted,false);
      const tool=await pool.handles.get("Interaction-1")!.releaseTask(taskId);assert.equal(tool.pythonReleased,false);
      await pool.runtime.invoke("CONTEXT.SELECT",{scope:{sessionId:other},purpose:"infer"} as any,{workerId:"Context-1"});assert(alive(otherPid));
      const rows=mergeSteps(directory,false).filter(s=>s.taskId===taskId);for(const pid of rows.map(s=>s.pythonPid).filter(Boolean))assert(!alive(pid));
      if(mode==="throw")assert(rows.some(s=>/inline byte limit/.test(s.error??"")));
      console.log(JSON.stringify({mode,contextDeleted:true,pythonReleased:true,otherAlive:alive(otherPid)}));pool.detach(taskId);
    }
    await pool.handles.get("Context-1")!.releaseTask(other);await pool.handles.get("Interaction-1")!.releaseTask(other);assert(!alive(otherPid));
  }finally{await pool.close();await server.close();}
});
test("T7 cleanup queues behind previously received work; startup timeout reaps started workers",async()=>{
  const directory=await temporary(),server=await fakeServer((_b,res)=>setTimeout(()=>res.end(JSON.stringify({ok:true,output:sampleOutput})),180));
  const b=await block(directory,server.url,"Monolithic"),pool=await deploy({group:"Monolithic",copies:{All:1},python,modelEndpoint:server.url,directory,timeouts:deployTimeouts(b.egress)});
  try{
    const slow=pool.runtime.invoke("INFER.REASONING.SAMPLE",sampleInput as any);await sleep(40);
    const load=pool.runtime.invoke("CONTEXT.LOAD",{scope:{sessionId:"queue-clean"},sources:[]} as any);
    await sleep(25);let released=false;
    const cleanup=pool.handles.get("All-1")!.releaseTask("queue-clean").then(r=>{released=true;return r;});
    await sleep(30);assert.equal(released,false);await slow;await load;assert.equal((await cleanup).contextDeleted,true);
    assert.equal((await pool.handles.get("All-1")!.releaseTask("queue-clean")).contextDeleted,false);
  }finally{await pool.close();await server.close();}
  const failDir=await temporary();await assert.rejects(deploy({group:"Uniform",copies:{Context:8,Infer:8,Interaction:8,Memory:8},python,modelEndpoint:"http://127.0.0.1:1",directory:failDir,
    timeouts:{...deployTimeouts(b.egress),handshakeTimeoutMs:1,shutdownTimeoutMs:1000}}),/handshake|Worker/);
  const life=JSON.parse(await readFile(join(failDir,"lifecycle.json"),"utf8"));assert(life.processes.length>0);assert(life.processes.every((p:any)=>p.exited&&!alive(p.pid)));console.log(JSON.stringify({startupFailureReaped:life.processes.length}));
});
test("T7 fake cgroup/proc counters, quotas, Python owner, unavailable data",async()=>{
  const directory=await temporary(),cgroup=join(directory,"cgroup"),proc=join(directory,"proc");await mkdir(cgroup);await mkdir(proc);
  for(const [name,value]of Object.entries({"cpu.stat":"usage_usec 12345","memory.current":"4096","cpu.max":"200000 100000","memory.max":String(4*1024**3),"memory.swap.max":"0","cgroup.procs":"21\n22"}))await writeFile(join(cgroup,name),value);
  for(const [pid,ppid,cmd]of [[21,process.pid,"node worker-host.ts"],[22,21,"python -B bridge.py"]] as const){
    const dir=join(proc,String(pid));await mkdir(dir);const fields=Array(22).fill("0");fields[0]="S";fields[1]=String(ppid);fields[11]="20";fields[12]="30";
    await writeFile(join(dir,"stat"),`${pid} (name with space) ${fields.join(" ")}`);await writeFile(join(dir,"statm"),"10 3");await writeFile(join(dir,"cmdline"),cmd);
  }
  const b=await block(directory,"http://127.0.0.1:1"),path=join(directory,"resources.jsonl");
  const sampler=await resourceSampler(path,{...b.sampling,cgroupDirectory:cgroup,procDirectory:proc},()=>[{id:"Interaction-1",pid:21}],()=>assert.fail());await sampler.stop();
  const rows=lines(path),child=rows.find(r=>r.kind==="processes").rows.find((r:any)=>r.pid===22);
  assert.equal(child.workerId,"Interaction-1");assert.equal(child.cpuSeconds,.5);assert.equal(child.rssBytes,12288);assert.equal(child.role,"python");
  const missing=await resourceSampler(join(directory,"missing.jsonl"),{...b.sampling,cgroupDirectory:join(directory,"absent")},()=>[],()=>assert.fail());await missing.stop();assert.equal(lines(join(directory,"missing.jsonl"))[0].cpuUs,null);
  console.log(JSON.stringify({parsedPython:child,missing:lines(join(directory,"missing.jsonl"))[0]}));
});
test("T7 child and actual Python environment names use whitelist",async()=>{
  const directory=await temporary(),b=await block(directory,"http://127.0.0.1:1","Monolithic"),pool=await deploy({group:"Monolithic",copies:{All:1},python,modelEndpoint:b.modelEndpoint,directory,timeouts:deployTimeouts(b.egress)});
  try{
    const names=pool.units[0].ready.envNames;console.log(JSON.stringify({workerEnvNames:names}));
    const windowsDefaults=["HOMEDRIVE","HOMEPATH","LOGONSERVER","SYSTEMDRIVE","TEMP","USERDOMAIN","USERNAME","USERPROFILE","WINDIR"];
    assert(names.every((n:string)=>["PATH","SYSTEMROOT","NODE_OPTIONS","OFFLINE_GUARD_REPORT_DIR","TEMP","TMP","TMPDIR","PYTHONDONTWRITEBYTECODE","OFFLINE_GUARD_LAUNCH_ID",...windowsDefaults].includes(n.toUpperCase())));
    const child=spawn(python,["-B","-c","import os,json;print(json.dumps(sorted(os.environ.keys())))"],{windowsHide:true,env:childEnvironment(),stdio:["ignore","pipe","pipe"]});
    let out="";child.stdout.on("data",b=>out+=b);const code=await new Promise(r=>child.once("close",r));assert.equal(code,0);
    const pythonNames=JSON.parse(out);assert(!pythonNames.some((n:string)=>/KEY|TOKEN|SECRET|PASSWORD/.test(n)));
    console.log(JSON.stringify({workerEnvNames:names,pythonEnvNames:pythonNames}));
  }finally{await pool.close();}
});
test("T7 injected transport delay stays in IPC time, not node work",async()=>{
  const directory=await temporary(),b=await block(directory,"http://127.0.0.1:1","Monolithic");
  const pool=await deploy({group:"Monolithic",copies:{All:1},python,modelEndpoint:b.modelEndpoint,directory,timeouts:deployTimeouts(b.egress)},options=>{
    const transport=createIpcTransport(options);
    return {...transport,async invoke(envelope,options){await sleep(60);const result=await transport.invoke(envelope,options);await sleep(60);return result;}};
  });
  try{await pool.runtime.invoke("CONTEXT.LOAD",{scope:{sessionId:"delay"},sources:[]} as any);
    const row=mergeSteps(directory,false)[0];assert(row.ipcMs>=110);assert(row.workMs<row.ipcMs);console.log(JSON.stringify({injectedTransportMs:120,ipcMs:row.ipcMs,workMs:row.workMs,queueMs:row.queueMs}));
  }finally{await pool.close();}
});
