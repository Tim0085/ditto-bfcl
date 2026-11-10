import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { temporary, egress, localRuntime, taskOptions, alive } from "./t4-helpers.ts";
import { loadTask } from "../src/ts/tool-actions.ts";
import { runTask } from "../src/ts/task-loop.ts";

for(const group of ["Monolithic","Uniform","Targeted"] as const)test(`T4 ${group}: two full fixture tasks, actual Ditto execution scopes match bindings`,async()=>{
  const directory=await temporary(),gateway=await egress("fixtures",join(directory,"egress"));
  const host=await localRuntime(join(directory,"memory"),gateway.url,group,{},undefined,true);
  try {
    for(const caseId of ["multi_turn_base_0","multi_turn_miss_func_0"]) {
      const taskId=`route/${group}/${caseId}`,before=host.events.length;
      const result=await runTask(host.runtime,await loadTask(caseId),{...taskOptions(taskId),debug:true,handles:host.handles,bindings:host.bindings});
      assert.equal(result.executionOutcome,"completed");
      assert(result.snapshot);assert.deepEqual(result.recordingWarnings,[]);
      const events=host.events.slice(before),pids=new Set<number>();
      for(const event of events) {
        // The old debug snapshot is a diagnostic outside the seven graphs.
        if(!event.execution){assert.equal(event.input.call.arguments.request.action,"snapshot");assert.equal(event.workerId,host.bindings["bfcl-open"].init);continue;}
        const {graphId,nodeId,runId}=event.execution;assert(runId);
        const fixed=host.bindings[graphId][nodeId];
        if(fixed)assert.equal(event.workerId,fixed);
        else assert(["INFER.REASONING.SAMPLE","INTERACTION.OBSERVE"].includes(event.node));
        if(event.node.startsWith("CONTEXT."))assert.deepEqual(event.input.scope,{sessionId:taskId});
        const pid=event.result.structuredContent?.pythonPid??event.result.metadata?.pythonPid;if(pid)pids.add(pid);
      }
      for(const pid of pids)assert(!alive(pid));
      await assert.rejects(host.runtime.invoke("CONTEXT.LOAD",{scope:{sessionId:taskId}},{workerId:host.bindings["bfcl-open"].load}),/absent or expired/);
      assert(events.some(e=>e.execution?.graphId==="bfcl-close"));
      console.log(JSON.stringify({group,caseId,nodes:events.length,trace:events.map(e=>({node:e.node,workerId:e.workerId,...e.execution})),pythonExited:[...pids],contextDeleted:true}));
    }
    if(group!=="Monolithic")for(const node of ["INFER.REASONING.SAMPLE","INTERACTION.OBSERVE"])assert.equal(new Set(host.events.filter(e=>e.node===node).map(e=>e.workerId)).size,2);
  }finally{await host.runtime.close();await gateway.close();}
});
