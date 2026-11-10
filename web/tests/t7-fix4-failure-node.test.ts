import test from "node:test";
import assert from "node:assert/strict";
import {FailureTrace,ScoringTrace,failureScope,scoringScope,captureScoring} from "../src/ts/step-log.ts";
import {checkContext,selectedMessages,STAGES} from "../src/ts/graphs.ts";

test("failureNode follows the exact failed invocation even after later successful work",async()=>{
  const trace=new FailureTrace("t"),primary=new Error("primary");
  await failureScope.run(trace,async()=>{
    await assert.rejects(captureScoring("INTERACTION.ACT.TOOL",{},{workerId:"Interaction-1"},async()=>{throw primary;}));
    await captureScoring("CONTEXT.UPDATE",{},{workerId:"Context-2"},async()=>({items:[]}));
  });
  assert.deepEqual(trace.source(primary),{type:"tool-channel",node:{node:"INTERACTION.ACT.TOOL",workerId:"Interaction-1",status:undefined}});
  assert.deepEqual(trace.source(new Error("publish")),{type:"other",node:null});
});
test("output checks use their output's producer, not the latest invocation; missing outputs retain declared node",async()=>{
  const trace=new FailureTrace("t");
  await failureScope.run(trace,async()=>{
    for(const node of ["CONTEXT.LOAD","CONTEXT.UPDATE"]){
      const output=await captureScoring(node,{},{workerId:"Context-1"},async()=>({items:[{id:"bad",metadata:{sequence:-1}}]}));
      await captureScoring("INTERACTION.ACT.TOOL",{},{workerId:"Interaction-2"},async()=>({status:"success"}));
      assert.throws(()=>checkContext(output),e=>{
        assert.deepEqual(trace.source(e),{type:"context-error",node:{node,workerId:"Context-1",status:undefined}});return true;
      });
    }
    const selected=await captureScoring("CONTEXT.SELECT",{},{workerId:"Context-3"},async()=>({context:{items:[]},selectedItemIds:[]}));
    await captureScoring("MEMORY.WRITE",{},{workerId:"Memory-2"},async()=>({status:"success"}));
    assert.throws(()=>selectedMessages(selected,1),e=>trace.source(e).node?.node==="CONTEXT.SELECT"&&trace.source(e).node?.workerId==="Context-3");
    for(const [step,node,type] of [[STAGES.open[1],"CONTEXT.LOAD","context-error"],[STAGES.turn[0],"CONTEXT.UPDATE","context-error"],[STAGES.think[0],"CONTEXT.SELECT","context-error"],[STAGES.think[1],"INFER.REASONING.SAMPLE","sample-not-success"],[STAGES.save[0],"MEMORY.WRITE","memory-not-success"],[STAGES.action[1],"INTERACTION.OBSERVE","other"]] as const){
      assert.throws(()=>step.validateOutput(undefined),e=>{
        assert.equal(trace.source(e).type,type);assert.equal(trace.source(e).node?.node,node);return true;
      });
    }
  });
});
test("non-success status and first-cause scoring chains keep the originating node and status",async()=>{
  const trace=new FailureTrace("t");
  await failureScope.run(trace,async()=>{
    for(const [node,step,type] of [["INFER.REASONING.SAMPLE",STAGES.think[1],"sample-not-success"],["MEMORY.WRITE",STAGES.save[0],"memory-not-success"]] as const)
      for(const status of ["failed","cancelled","timeout"]){
        const output=await captureScoring(node,{},{workerId:"W"},async()=>({status,error:{message:"same"}}));
        await captureScoring("CONTEXT.LOAD",{},{workerId:"other"},async()=>({items:[]}));
        assert.throws(()=>step.validateOutput(output),e=>{
          assert.deepEqual(trace.source(e),{type,node:{node,workerId:"W",status}});return true;
        });
      }
    const score=new ScoringTrace("t");score.add=()=>{throw new Error("record failed");};
    await scoringScope.run(score,async()=>{
      await assert.rejects(captureScoring("INTERACTION.ACT.TOOL",{},{workerId:"Interaction-1"},async()=>({status:"success"})),e=>{
        assert.equal(trace.source(e).type,"scoring-trace");
        assert.deepEqual(trace.source(e).node,{node:"INTERACTION.ACT.TOOL",workerId:"Interaction-1",status:undefined});
        return true;
      });
      await assert.rejects(captureScoring("INFER.REASONING.SAMPLE",{},{workerId:"Infer-1"},async()=>({status:"failed",error:{message:"model failed"}})),e=>{
        const chain=trace.precedingErrors.get(e)!;
        assert.equal(trace.source(chain[0]).type,"sample-not-success");
        assert.deepEqual(trace.source(chain[0]).node,{node:"INFER.REASONING.SAMPLE",workerId:"Infer-1",status:"failed"});
        assert.equal(trace.source(chain[1]).type,"scoring-trace");return true;
      });
    });
    const cleanup=new Error("cleanup");trace.causes.set(cleanup,"cleanup");
    const aggregateCheck=new Error("trace validate");trace.causes.set(aggregateCheck,"scoring-trace");
    assert.equal(trace.source(cleanup).node,null);assert.equal(trace.source(aggregateCheck).node,null);
  });
});
