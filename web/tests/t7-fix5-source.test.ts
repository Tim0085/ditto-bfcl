import test from "node:test";
import assert from "node:assert/strict";
import {FailureTrace,ScoringTrace,failureScope,scoringScope,captureScoring,markFailure} from "../src/ts/step-log.ts";

test("first source is retained as a type/node pair across cleanup and scoring",()=>{
  const trace=new FailureTrace("t"),error=new Error("shared"),node={node:"CONTEXT.SELECT",workerId:"C"};
  trace.record(error,"context-error",node);
  node.node="changed outside trace";
  trace.record(error,"cleanup");trace.record(error,"scoring-trace",{node:"INTERACTION.ACT.TOOL"});
  assert.deepEqual(trace.source(error),{type:"context-error",node:{node:"CONTEXT.SELECT",workerId:"C"}});
  const fresh=new Error("fresh");trace.record(fresh,"cleanup");
  assert.deepEqual(trace.source(fresh),{type:"cleanup",node:null});
});

test("an explicit origin predating the task map survives later wrappers",()=>{
  const trace=new FailureTrace("t"),error=markFailure(new Error("checked"),"context-error",{node:"CONTEXT.SELECT"});
  trace.record(error,"cleanup");
  assert.deepEqual(trace.source(error),{type:"context-error",node:{node:"CONTEXT.SELECT"}});
});

for(const outcome of ["throw","success"] as const)test(`scoring ${outcome} catch cannot reclassify a reused error`,async()=>{
  const trace=new FailureTrace("t"),score=new ScoringTrace("t"),error=new Error("shared");
  await failureScope.run(trace,async()=>{
    await assert.rejects(captureScoring("CONTEXT.SELECT",{},{workerId:"C"},async()=>{throw error;}),e=>e===error);
    const first=trace.source(error);
    score.add=()=>{throw error;};
    await scoringScope.run(score,async()=>{
      await assert.rejects(captureScoring("INTERACTION.ACT.TOOL",{},{workerId:"I"},async()=>{
        if(outcome==="throw")throw error;return {status:"success"};
      }),e=>e===error);
    });
    assert.deepEqual(trace.source(error),first);
    if(outcome==="throw")assert.deepEqual(trace.precedingErrors.get(error),[error,error]);
  });
});

test("new scoring error keeps its own source and preserves the original tool error",async()=>{
  const trace=new FailureTrace("t"),score=new ScoringTrace("t"),tool=new Error("tool"),record=new Error("record");
  score.add=()=>{throw record;};
  await failureScope.run(trace,()=>scoringScope.run(score,async()=>{
    await assert.rejects(captureScoring("INTERACTION.ACT.TOOL",{},{workerId:"I"},async()=>{throw tool;}),e=>e===record);
  }));
  assert.equal(trace.source(tool).type,"tool-channel");
  assert.deepEqual(trace.source(record),{type:"scoring-trace",node:{node:"INTERACTION.ACT.TOOL",workerId:"I",status:undefined}});
  assert.deepEqual(trace.precedingErrors.get(record),[tool,record]);
});
