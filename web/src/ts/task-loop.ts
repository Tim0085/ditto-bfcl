import { graphStep, ExecutionGraph } from "@codesoul-co/ditto";
import type { DittoRuntime, LoopRunOptions, AsyncGraphPlan } from "@codesoul-co/ditto/runtime";
import type { AgentCoreInstanceHandle } from "./agent-core.ts";
import type { Task } from "./tool-actions.ts";
import { createGraphs } from "./graphs.ts";
import { cleanupOwners } from "./bindings.ts";
import { leastQueuedRoute } from "./least-queued.ts";
import { bindWebToolInit, taskPlan, withTaskCleanup, type TaskOptions } from "./direct-task.ts";
export interface LoopTaskOptions extends TaskOptions {
  bindings: NonNullable<LoopRunOptions["workers"]>;
  handles: ReadonlyMap<string,AgentCoreInstanceHandle>;
  onGraph?: LoopRunOptions["onGraph"];
  maxIterations?: number;
}
// No invented tool-count cap: a JS array has at most 2^32-1 elements.
export function taskGraphLimit(turns:number,requests=100) {
  const value=2+2*turns+requests*2**32;
  if(!Number.isSafeInteger(value)||value<1)throw new Error("Loop 次数上界无效");
  return value;
}
export async function runTask(runtime:DittoRuntime,task:Task,options:LoopTaskOptions) {
  const owners=cleanupOwners(options.bindings);
  const handles=owners.map(id=>{const h=options.handles.get(id);if(!h)throw new Error(`缺少清理句柄：${id}`);return h;});
  const graphs=createGraphs(),route=leastQueuedRoute(runtime);
  // Keep the seven graph shapes and node bindings. A think graph drains an
  // admitted model request, but cancellation must still prevent its next node
  // (especially SAMPLE after SELECT) from starting.
  // T11: right after bind, Ditto routes synchronously; set the copies it may see
  // (unbound SAMPLE/OBSERVE: only the least-queued one; bound steps: all).
  for (const stage of Object.keys(graphs) as (keyof typeof graphs)[]) {
    const plan=graphs[stage],bound=options.bindings[plan.id]??{};
    graphs[stage] = ExecutionGraph.fromTasks(plan.id, plan.tasks.map(step => ({
      ...step, bind(input, dependencies) {
        if (stage === "think") options.signal?.throwIfAborted();
        const value = bindWebToolInit(stage,step.id,step.bind(input, dependencies),options);
        route?.before(step.node, bound[step.id]);
        return value;
      },
    })));
  }
  // Keep the old optional diagnostic outside the seven experiment graphs.
  options={...options,snapshot:options.snapshot??(async taskId=>{
    route?.before("INTERACTION.ACT.TOOL",options.bindings["bfcl-open"].init);
    const result=await runtime.invoke("INTERACTION.ACT.TOOL",{call:{id:`${taskId}/snapshot`,name:"bfcl_bridge",arguments:{taskId,request:{action:"snapshot"}}}},
      {workerId:options.bindings["bfcl-open"].init,signal:options.signal});
    if(result.status!=="success")throw new Error(result.error?.message??"snapshot failed");
    return (result.structuredContent as any).data;
  })};
  return withTaskCleanup(options.taskId,()=>runtime.loop({id:`bfcl-task/${options.taskId}`,
    maxIterations:options.maxIterations??taskGraphLimit(task.question.length,options.perTaskRequests),
    async *plan():AsyncGraphPlan<any> {
      const iterator=taskPlan(task,options);
      try {
        let next=await iterator.next();
        while(!next.done) {
          options.signal?.throwIfAborted();
          const {stage,input}=next.value;
          let output:Record<string,any>;
          // The enclosing SDK Loop replaces errors with its abort reason.
          // Apply cancellation at our boundaries; an admitted think graph must
          // finish accounting first. Other graphs keep their abort signal.
          try {output=yield* graphStep(graphs[stage],input,stage==="think"?{}:{signal:options.signal});}
          catch(error) {
            if (!String(error).includes("BFCL_RUN_STOP:")) options.signal?.throwIfAborted();
            next=await iterator.throw(error);continue;
          }
          options.signal?.throwIfAborted();
          options.onStage?.(stage,output);
          next=await iterator.next(output);
        }
        options.signal?.throwIfAborted();
        return next.value;
      } finally {await iterator.return(undefined);}
    },
  },undefined,{workers:options.bindings,onGraph:options.onGraph}),handles.map(h=>()=>h.releaseTask(options.taskId)));
}
