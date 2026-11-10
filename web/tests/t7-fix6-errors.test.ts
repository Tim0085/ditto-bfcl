import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {aggregateDetails,aggregateDiagnostics,cleanupReplyError,errorText,FailureTrace} from '../src/ts/step-log.ts';
import {temporary,block,egress,launchBlock} from './t7-helpers.ts';

test('fix6 diagnostics preserve ordinary errors, first origin, nested messages and bounded cycles',()=>{
  for(const e of [new Error('single'),null,'text',42])assert.deepEqual(aggregateDiagnostics([e]),{});
  const first=new Error('first'),aggregate=new AggregateError([first,new AggregateError([new Error('Python'),null],'nested')],'cleanup');
  const trace=new FailureTrace('id');trace.record(aggregate,'cleanup');trace.record(first,'other');
  assert.deepEqual(aggregateDiagnostics([first,aggregate]),{aggregateErrors:[{errorIndex:1,message:'cleanup',children:[{message:'first'},{message:'nested',children:[{message:'Python'},{message:'null'}]}]}]});
  assert.equal(errorText(aggregate),'cleanup');assert.equal(trace.source(aggregate).type,'cleanup');
  const reply=cleanupReplyError(aggregate.message,aggregateDetails(aggregate));
  assert.deepEqual(aggregateDetails(reply),aggregateDetails(aggregate));
  assert.equal(cleanupReplyError('single').constructor,Error);
  aggregate.errors.push(aggregate);assert.doesNotThrow(()=>JSON.stringify(aggregateDiagnostics([aggregate])));
});

// Compare every field's shape; clock stamps, process IDs, UUIDs and performance values vary per run.
function shape(v:any):any{if(v===null)return null;if(Array.isArray(v))return v.map(shape);if(typeof v==='object')return Object.fromEntries(Object.keys(v).sort().map(k=>[k,shape(v[k])]));return typeof v;}
test('fix6 real cleanup aggregates, nested aggregates and ordinary-record compatibility',async()=>{
  const root=await temporary();console.log(JSON.stringify({evidence:root}));
  async function run(group:'Direct'|'Monolithic'|'Uniform',mode:string,baseline=false){
    const dir=join(root,`${group}-${mode}-${baseline?'before':'after'}`);await mkdir(dir);
    // Keep comparable task IDs, but give each run its own request counters.
    const gateway=await egress(dir,'replay');try{
    const hook=pathToFileURL(resolve('tests/t7-fix6-hook.mjs'));hook.searchParams.set('cfg',JSON.stringify({mode,baseline}));
    const old=process.env.NODE_OPTIONS;process.env.NODE_OPTIONS=`${old??''} --import=${hook.href}`;
    let running:Awaited<ReturnType<typeof launchBlock>>;
    try{running=await launchBlock(await block(dir,gateway.url,group,'errors',1,['multi_turn_base_0','multi_turn_base_4','multi_turn_miss_func_0']));}
    finally{if(old===undefined)delete process.env.NODE_OPTIONS;else process.env.NODE_OPTIONS=old;}
    const result=await running.done;assert.equal(result.code,0,result.stderr);
    const summary=JSON.parse(await readFile(join(running.directory,'block-summary.json'),'utf8'));
    assert.equal(summary.skipped,1);assert.equal(summary.completed,2);assert.equal(summary.interrupted,0);assert.equal(summary.consecutiveFailure,null);
    const continued=[];for(const id of ['multi_turn_base_4','multi_turn_miss_func_0']){
      const task=JSON.parse(await readFile(join(running.directory,'tasks',id+'.r1.json'),'utf8'));
      assert.equal(task.status,'completed',id);assert.equal(task.executionOutcome,'completed',id);continued.push(id);
    }
    const failure=JSON.parse(await readFile(join(running.directory,'failures','multi_turn_base_0.r1.json'),'utf8'));
    assert.equal(failure.failureType,mode==='ordinary'?'context-error':'cleanup');assert.equal(failure.disposition,'skipped');assert.equal(failure.streak,1);
    if(mode!=='ordinary')assert.equal(failure.failureNode,null);
    console.log(JSON.stringify({group,mode,baseline,summary,continued,errors:failure.errors,aggregateErrors:failure.aggregateErrors}));return failure;
    }finally{await gateway.close();}
  }
  for(const group of ['Direct','Monolithic','Uniform'] as const){
    for(const mode of ['aggregate','nested']){
      const f=await run(group,mode);assert.deepEqual(f.errors,['按题清理失败']);assert.equal(f.error,'按题清理失败');
      assert.deepEqual(f.aggregateErrors,[{errorIndex:0,message:'按题清理失败',children:mode==='aggregate'?[{message:'context deletion failed',source:'context'},{message:'memory release failed',source:'memory'}]:[{message:'nested cleanup',source:'context',children:[{message:'Python release failed'},{message:'inflight drain failed'}]},{message:'memory release failed',source:'memory'}]}]);
    }
    for(const mode of ['single','ordinary']){
      const before=await run(group,mode,true),after=await run(group,mode);
      assert.deepEqual(shape(after),shape(before));assert(!('aggregateErrors' in after));
      for(const key of ['caseId','taskId','configId','round','assignment','category','error','disposition','failureType','streak','streakFailureType','failureNode','errors'])assert.deepEqual(after[key],before[key],key);
      await writeFile(join(root,`${group}-${mode}-compatibility.json`),JSON.stringify({before,after,allFieldShapesEqual:true,stableFieldsEqual:true},null,2));
    }
  }
});
