import assert from 'node:assert/strict';
import {createAgentCoreSteps} from '../src/ts/agent-core.ts';
import {cleanupScope,FailureTrace,type CleanupCapture} from '../src/ts/step-log.ts';
const shared=(globalThis as any).__fix7Shared;
const core=createAgentCoreSteps({python:'unused',memoryDirectory:process.env.TEMP!,inferenceTimeoutMs:1000});
const trace=new FailureTrace('identity');trace.record(shared,'tool-channel',{node:'INTERACTION.ACT.TOOL'});
try{
  const captures=await Promise.all(['context','python','memory','model-drain'].map(async(source,index)=>{
    const capture:CleanupCapture={};
    await assert.rejects(cleanupScope.run(capture,()=>core.releaseTask('identity-'+index)),error=>{
      assert.equal(error,shared);trace.record(error,'cleanup');assert.equal(trace.classify(error),'tool-channel');return true;
    });
    assert.deepEqual(capture.sources,[source]);return capture;
  }));
  assert(Object.isFrozen(shared));console.log(JSON.stringify({frozenOriginalPreserved:true,concurrentCaptures:captures,classification:trace.classify(shared)}));
}finally{await core.dispose();}
