import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {errorMessages,aggregateDetails,cleanupReplyError,cleanupDiagnostics} from '../src/ts/step-log.ts';
import {temporary,block,egress,launchBlock,command} from './t7-helpers.ts';

test('fix7 classification sees nested/restored run-stop, handles cycles, and leaves error order and first origin intact',()=>{
  const stop=new Error('BFCL_RUN_STOP:{"message":"settlement stopped"}');
  const nested=new AggregateError([new Error('access denied'),new AggregateError([stop],'nested')],'按题清理失败');
  assert(errorMessages([nested]).some(message=>message.includes('BFCL_RUN_STOP:')));
  const restored=cleanupReplyError(nested.message,aggregateDetails(nested));
  assert.deepEqual(errorMessages([restored]),errorMessages([nested]));
  nested.errors.push(nested);assert(errorMessages([nested]).length<10);
  assert.deepEqual(nested.errors.slice(0,2).map(error=>error.message),['access denied','nested']);
  const shared=new Error('shared');
  assert.deepEqual(cleanupDiagnostics([shared,shared],[{error:shared,workerId:null,sources:['python']}]),{
    cleanupErrors:[{errorIndex:1,message:'shared',workerId:null,sources:['python']}]});
});

test('fix7 four concurrent singleton releases preserve frozen original objects and independent captures',async()=>{
  const root=await temporary(),hook=pathToFileURL(resolve('tests/t7-fix7-hook.mjs'));
  hook.searchParams.set('cfg',JSON.stringify({identity:true,events:join(root,'events.jsonl')}));
  const proc=await command(process.execPath,['--experimental-transform-types','--import',hook.href,'tests/t7-fix7-identity.ts'],join(root,'identity-process.json'));
  console.log(JSON.stringify({evidence:root,...proc}));assert.equal(proc.code,0,proc.stderr);
});

test('fix7 natural cross-Worker sources, nested stop, ordinary/limit controls, and pre-fix compatibility',async()=>{
  const root=await temporary();console.log(JSON.stringify({evidence:root}));
  const gateway=await egress(root,'replay'),outcomes:any[]=[];
  const baselineDirectory=process.env.T7_FIX7_BASELINE;
  const id='multi_turn_base_0',next='multi_turn_base_4',A='access denied';
  const groups=['Direct','Monolithic','Uniform','Targeted'] as const;
  type Group=typeof groups[number];
  async function run(group:Group,name:string,spec:Record<string,string>,extra:Record<string,unknown>={},before=false){
    const dir=join(root,`${group}-${name}-${before?'before':'after'}`);await mkdir(dir);
    const events=join(dir,'events.jsonl');await writeFile(events,'');
    const hook=pathToFileURL(resolve('tests/t7-fix7-hook.mjs'));
    hook.searchParams.set('cfg',JSON.stringify({events,cleanup:{[id]:spec},...extra,...(before?{baselineDirectory}:{})}));
    const old=process.env.NODE_OPTIONS;process.env.NODE_OPTIONS=`${old??''} --import=${hook.href}`;
    let running:Awaited<ReturnType<typeof launchBlock>>;
    // Same task identity for before/after; distinct gateway counters using a new gateway for comparisons.
    try{running=await launchBlock(await block(dir,gateway.url,group,`${group}-${name}-${before?'before':'after'}`,1,[id,next]));}
    finally{if(old===undefined)delete process.env.NODE_OPTIONS;else process.env.NODE_OPTIONS=old;}
    const proc=await running.done;
    const summary=JSON.parse(await readFile(join(running.directory,'block-summary.json'),'utf8'));
    const failure=JSON.parse(await readFile(join(running.directory,'failures',id+'.r1.json'),'utf8'));
    const shouldStop=Object.values(spec).some(message=>message.includes('BFCL_RUN_STOP:'));
    const expectedStop=shouldStop&&(!before||Object.keys(spec).length===1);
    assert.equal(proc.code,expectedStop?1:0,JSON.stringify({group,name,before,proc,summary}));
    assert.equal(summary.interrupted,expectedStop?1:0);assert.equal(summary.skipped,expectedStop?0:1);
    assert.equal(summary.notStarted,expectedStop?1:0);assert.equal(summary.completed,expectedStop?0:1);
    assert.equal(summary.stopCategory,expectedStop?'出口停止':null);assert.equal(summary.consecutiveFailure,null);
    assert.equal(failure.disposition,expectedStop?'interrupted':'skipped');
    assert.equal(failure.failureType,(extra.select as string[]|undefined)?.length?'context-error':'cleanup');
    assert.equal(failure.failureNode?.node??null,(extra.select as string[]|undefined)?.length?'CONTEXT.SELECT':null);
    assert.equal(failure.streak,expectedStop?0:1);
    if(!expectedStop){const task=JSON.parse(await readFile(join(running.directory,'tasks',next+'.r1.json'),'utf8'));assert.equal(task.status,'completed');assert.equal(task.executionOutcome,'completed');}
    if(!before&&Object.keys(spec).length){
      const sources=failure.cleanupErrors.flatMap((row:any)=>row.sources).sort();
      assert.deepEqual(sources,Object.keys(spec).map(source=>source==='drain'?'model-drain':source).sort());
      for(const row of failure.cleanupErrors){assert.equal(row.message,failure.errors[row.errorIndex]);
        if(group==='Direct')assert.equal(row.workerId,null);
        else for(const source of row.sources)assert.equal(row.workerId,group==='Monolithic'?'All-1':`${{context:'Context',python:'Interaction',memory:'Memory','model-drain':'Interaction'}[source as string]}-1`);
      }
    }
    const result={group,name,before,exit:proc.code,summary,failure,events:await readFile(events,'utf8')};outcomes.push(result);
    console.log(JSON.stringify({group,name,before,exit:proc.code,completed:summary.completed,skipped:summary.skipped,interrupted:summary.interrupted,notStarted:summary.notStarted,category:failure.category,streak:failure.streak,errors:failure.errors,cleanupErrors:failure.cleanupErrors}));
    return failure;
  }
  const shape=(value:any):any=>value===null?null:Array.isArray(value)?value.map(shape):typeof value==='object'?Object.fromEntries(Object.keys(value).sort().filter(key=>key!=='cleanupErrors').map(key=>[key,shape(value[key])])):typeof value;
  function compatible(before:any,after:any){
    assert.deepEqual(shape(after),shape(before));
    for(const key of ['caseId','round','assignment','category','error','disposition','failureType','streak','streakFailureType','failureNode','errors','realErrors','aggregateErrors'])assert.deepEqual(after[key],before[key],key);
    assert.equal(after.taskId.replace(after.configId,'CONFIG'),before.taskId.replace(before.configId,'CONFIG'));
    assert.deepEqual(after.workerLiveness.map((w:any)=>[w.workerId,w.alive,w.method]),before.workerLiveness.map((w:any)=>[w.workerId,w.alive,w.method]));
  }
  try{
    for(const group of groups){
      const a=await run(group,'ctx-mem',{context:A,memory:A});
      const b=await run(group,'ctx-py',{context:A,python:A});
      assert.notDeepEqual(a.cleanupErrors,b.cleanupErrors);
      await run(group,'triple',{context:A,python:A,memory:A});
    }
    for(const group of ['Direct','Monolithic','Uniform'] as const){
      const stop='BFCL_RUN_STOP:{"message":"settlement stopped"}';
      await run(group,'stop-pair',{context:A,drain:stop});
      await run(group,'stop-nested',{context:A,drain:stop},{nested:true});
      const single=await run(group,'stop-single',{drain:stop});
      if(baselineDirectory)compatible(await run(group,'stop-single',{drain:stop},{},true),single);
      for(const [name,marker] of [['input','BFCL_INPUT_LIMIT:{"inputBytes":10,"maxRequestBytes":1}'],['physical','BFCL_PHYSICAL_REQUEST_LIMIT:{"failedModelAttempts":[],"physicalModelRequests":100}']]){
        const pair=await run(group,name+'-pair',{context:A,drain:marker});
        const one=await run(group,name+'-single',{drain:marker});
        if(baselineDirectory){compatible(await run(group,name+'-pair',{context:A,drain:marker},{},true),pair);compatible(await run(group,name+'-single',{drain:marker},{},true),one);}
      }
      if(baselineDirectory)for(const [name,spec,extra] of [['single',{memory:A},{}],['ordinary',{}, {select:[id]}]] as [string,Record<string,string>,Record<string,unknown>][]){
        const before=await run(group,name,spec,extra,true),after=await run(group,name,spec,extra);compatible(before,after);
      }
    }
  }finally{await gateway.close();await writeFile(join(root,'outcomes.json'),JSON.stringify(outcomes,null,2));}
});
