import assert from 'node:assert/strict';
import {createAgentCoreSteps} from '../src/ts/agent-core.ts';
import {FailureTrace,aggregateDetails} from '../src/ts/step-log.ts';
const error=(globalThis as any).__fix6SourceShared as Error;
assert(error instanceof Error);const keys=Object.getOwnPropertyNames(error);
const trace=new FailureTrace('identity');trace.record(error,'tool-channel',{node:'INTERACTION.ACT.TOOL'});
const core=createAgentCoreSteps({python:'unused',memoryDirectory:process.env.TEMP!,inferenceTimeoutMs:1000});
try{
  for(let i=0;i<4;i++)await assert.rejects(core.releaseTask('single-'+i),actual=>{
    assert.equal(actual,error);trace.record(actual,'cleanup');assert.equal(trace.classify(actual),'tool-channel');return true;
  });
  await assert.rejects(core.releaseTask('shared-two'),actual=>{
    assert(actual instanceof AggregateError);assert.equal(actual.message,'按题清理失败');assert.equal(actual.errors[0],error);assert.equal(actual.errors[1],error);
    assert.deepEqual(aggregateDetails(actual)?.children,[{message:'access denied',source:'context'},{message:'access denied',source:'memory'}]);return true;
  });
  assert.deepEqual(Object.getOwnPropertyNames(error),keys);
  console.log(JSON.stringify({singleIdentityPreserved:4,originalClassification:'tool-channel',sharedAggregateChildrenPreserved:true,originalErrorNotMutated:true}));
}finally{await core.dispose();}
