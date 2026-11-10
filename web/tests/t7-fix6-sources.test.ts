import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {temporary,block,egress,launchBlock,command} from './t7-helpers.ts';

test('fix6 all four singleton cleanup errors preserve identity and same-object multi failures keep per-slot sources',async()=>{
  const root=await temporary(),hook=pathToFileURL(resolve('tests/t7-fix6-sources-hook.mjs'));hook.searchParams.set('cfg',JSON.stringify({identity:true}));
  const result=await command(process.execPath,['--experimental-transform-types','--import',hook.href,'tests/t7-fix6-source-identity.ts'],join(root,'identity-process.json'));
  console.log(JSON.stringify({evidence:root,...result}));assert.equal(result.code,0,result.stderr);
});

test('fix6 identical messages identify distinct cleanup pairs through all four deployments',async()=>{
  const root=await temporary();console.log(JSON.stringify({evidence:root}));const gateway=await egress(root,'replay');
  const names=['context','python','memory','model-drain'],outcomes:any[]=[];
  try{for(const group of ['Direct','Monolithic','Uniform','Targeted'] as const){
    const records:any[]=[];
    for(const pair of [[0,2],[1,3]]){
      const dir=join(root,`${group}-${pair.join('-')}`);await mkdir(dir);
      const hook=pathToFileURL(resolve('tests/t7-fix6-sources-hook.mjs'));hook.searchParams.set('cfg',JSON.stringify({pair}));
      const old=process.env.NODE_OPTIONS;process.env.NODE_OPTIONS=`${old??''} --import=${hook.href}`;
      let run:Awaited<ReturnType<typeof launchBlock>>;
      try{run=await launchBlock(await block(dir,gateway.url,group,`source-${group}-${pair.join('-')}`,1,['multi_turn_base_0','multi_turn_base_4','multi_turn_miss_func_0']));}
      finally{if(old===undefined)delete process.env.NODE_OPTIONS;else process.env.NODE_OPTIONS=old;}
      const proc=await run.done;assert.equal(proc.code,0,proc.stderr);
      const summary=JSON.parse(await readFile(join(run.directory,'block-summary.json'),'utf8'));
      const failure=JSON.parse(await readFile(join(run.directory,'failures','multi_turn_base_0.r1.json'),'utf8'));
      assert.equal(summary.completed,2);assert.equal(summary.skipped,1);assert.equal(summary.interrupted,0);assert.equal(summary.consecutiveFailure,null);
      const continued=[];for(const id of ['multi_turn_base_4','multi_turn_miss_func_0']){
        const task=JSON.parse(await readFile(join(run.directory,'tasks',id+'.r1.json'),'utf8'));
        assert.equal(task.status,'completed',id);assert.equal(task.executionOutcome,'completed',id);continued.push(id);
      }
      assert.equal(failure.failureType,'cleanup');assert.equal(failure.failureNode,null);assert.equal(failure.disposition,'skipped');assert.equal(failure.streak,1);
      assert.deepEqual(failure.errors,['按题清理失败']);assert.deepEqual(failure.aggregateErrors,[{errorIndex:0,message:'按题清理失败',children:pair.map(index=>({message:'access denied',source:names[index]}))}]);
      records.push(failure.aggregateErrors);outcomes.push({group,pair,summary,failure,continued});console.log(JSON.stringify({group,pair,diagnostic:failure.aggregateErrors,continued}));
    }
    assert.notDeepEqual(records[0],records[1],group+' distinct cleanup pairs');
  }}finally{await gateway.close();await writeFile(join(root,'outcomes.json'),JSON.stringify(outcomes,null,2));}
});
