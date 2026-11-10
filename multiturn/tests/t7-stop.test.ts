import test from "node:test";
import assert from "node:assert/strict";
import { writeFile,mkdir,readFile,readdir } from "node:fs/promises";
import { join } from "node:path";
import { block,fakeServer,sampleOutput,temporary,launchBlock,command,python,sleep,alive } from "./t7-helpers.ts";
import { lines } from "../src/ts/step-log.ts";
test("T7 four task terminals continue and HTTP rejected SAMPLE is separated for direct scoring",async()=>{
  for(const [kind,group] of ["output_limit","request_limit","input_limit","model_output"].flatMap(k=>(["Direct","Uniform"] as const).map(g=>[k,g] as const))){
    const root=await temporary(),reply=kind==="input_limit"?{ok:false,error:{kind,message:"fixture input limit",details:{inputBytes:1001,maxRequestBytes:1000}}}:
      kind==="request_limit"?{ok:false,error:{kind,message:"fixture request limit",details:{physicalModelRequests:1,failedModelAttempts:[{id:"simulated-attempt",reason:"transport_unknown",heldReferenceMicroUsd:1,apiMs:1,requestStartedAt:1,rateWaitMs:0,errorCategory:"probe"}]}}}:
      {ok:true,output:{...sampleOutput,finishReason:kind==="output_limit"?"length":"error",message:{...sampleOutput.message,metadata:kind==="model_output"?{bfclTaskFailure:{reason:"model_output",code:"content_filter"}}:{rawFinishReason:"length"}}}};
    const server=await fakeServer((_b,res)=>res.end(JSON.stringify(reply)));
    try{
      const b=await block(root,server.url,group,kind,1,["multi_turn_base_0","multi_turn_base_4"]);b.perTaskRequests=1;
      const run=await launchBlock(b),done=await run.done;assert.equal(done.code,0,JSON.stringify(done));
      for(const caseId of b.caseIds){const path=join(run.directory,"tasks",caseId+".r1.json"),result=JSON.parse(await readFile(path,"utf8"));
        assert.equal(result.executionOutcome,kind);assert.equal(result.status,"terminated");
        if(kind==="input_limit"||kind==="request_limit"){assert.equal(result[kind==="input_limit"?"inputLimitEvents":"requestLimitEvents"].length,1);assert.equal(result.workerEvents.filter((e:any)=>e.kind==="infer").length,0);}
        if(group==="Direct"&&(kind==="input_limit"||kind==="request_limit")){
          const steps=lines(join(run.directory,"steps.jsonl")).filter(s=>s.taskId===result.taskId);
          assert(steps.filter(s=>s.node==="INFER.REASONING.SAMPLE").every(s=>s.graphId==="bfcl-think"&&s.step==="sample"));
          assert(steps.filter(s=>s.action==="release").every(s=>s.graphId==="bfcl-close"&&s.step==="release"));
        }
        const score=await command(python,["-B","-X","utf8","src/python/score.py","--input",path,"--output",join(root,caseId+".score.json")],join(root,caseId+".score-process.json"));assert.equal(score.code,0,JSON.stringify(score));
      }assert.equal(server.requests,2);console.log(JSON.stringify({kind,group,tasks:2,continued:true,scoreExit0:2}));
    }finally{await server.close();}
  }
});
test("T7 immediate stops and consecutive runtime failures do not retry",async()=>{
  for(const mode of ["run_stop","runtime","kill","context-error"]){
    const root=await temporary();let killed=false;
    const server=await fakeServer((body,res)=>{
      if(mode==="kill"){
        void (async()=>{
          if(!killed){killed=true;const parent=lines(join(root,"configs",mode,"parent.steps.jsonl"));const worker=parent.find(p=>p.workerId==="Interaction-1");assert(worker);process.kill(worker.pid,"SIGKILL");}
          await sleep(120);res.end(JSON.stringify({ok:true,output:sampleOutput}));
        })();
      }else res.end(JSON.stringify(mode==="context-error"?{ok:true,output:{...sampleOutput,message:{role:"assistant",content:"x".repeat(1_000_001)}}}:mode==="run_stop"?{ok:false,error:{kind:"run_stop",details:{reason:"probe stop"}}}:{ok:false,error:{kind:"invalid"}}));
    });
    try{
      const b=await block(root,server.url,"Uniform",mode,1,["multi_turn_base_0","multi_turn_base_4"]);
      if(mode==="runtime")b.python="Z:/missing-python-for-t7.exe";
      const run=await launchBlock(b),done=await run.done;assert.equal(done.code,1,JSON.stringify(done));
      const immediate=mode==="kill"||mode==="run_stop";
      const summary=JSON.parse(await readFile(join(run.directory,"block-summary.json"),"utf8"));assert.equal(summary.notStarted,immediate?1:0);assert.equal(summary.failed,immediate?1:2);
      assert.equal((await readdir(join(run.directory,"tasks"))).length,0);const failures=await readdir(join(run.directory,"failures"));assert.equal(failures.length,immediate?1:2);
      if(mode==="context-error"){const failure=JSON.parse(await readFile(join(run.directory,"failures",failures[0]),"utf8"));assert(failure.realErrors.some((s:string)=>s.includes("inline byte limit")));assert.equal(failure.location.nodeId,"note");}
      const life=JSON.parse(await readFile(join(run.directory,"lifecycle.json"),"utf8"));assert(life.processes.every((p:any)=>p.exited&&!alive(p.pid)));
      const pythonPids=lines(join(run.directory,"steps.jsonl")).map(s=>s.pythonPid).filter(Boolean);await sleep(150);assert(pythonPids.every(p=>!alive(p)));
      assert(server.requests<=(immediate?1:2));console.log(JSON.stringify({mode,summary,earlyDisconnects:server.early}));
    }finally{await server.close();}
  }
});
test("T7 SIGTERM handler drains in-flight model without cancellation; auxiliary failure continues; result write stops",async()=>{
  for(const mode of ["sigterm","recording","task-write"]){
    const root=await temporary();const server=await fakeServer((_body,res)=>{
      void writeFile(join(root,"signal-ready"),"");setTimeout(()=>res.end(JSON.stringify({ok:true,output:sampleOutput})),100);
    });
    try{
      const b=await block(root,server.url,"Monolithic",mode,1,["multi_turn_base_0","multi_turn_base_4"]),path=join(root,"block.json");await writeFile(path,JSON.stringify(b));
      const done=await command(process.execPath,["--import","./scripts/egress-offline-guard.mjs","--experimental-transform-types","tests/t7-fault-runner.ts",path,mode],join(root,"fault-process.json"));
      assert.equal(done.code,mode==="recording"?0:1,JSON.stringify(done));assert.equal(server.early,0);
      const summary=JSON.parse(await readFile(join(root,"configs",mode,"block-summary.json"),"utf8"));
      if(mode==="recording"){assert.equal(summary.completed,2);assert(Object.values(summary.recordingFailures).some((v:any)=>v.count>0));}
      else{assert.equal(summary.notStarted,mode==="sigterm"?1:0);assert.equal(summary.failed,mode==="sigterm"?1:2);}
      console.log(JSON.stringify({mode,summary,earlyDisconnects:server.early}));
    }finally{await server.close();}
  }
});
