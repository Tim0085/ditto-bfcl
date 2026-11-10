import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {temporary,block,egress,launchBlock} from './t7-helpers.ts';
import {json} from '../src/ts/scheduler/io.ts';
const output=resolve(process.argv[2]??'runs/offline/t8c-fix1-20261106/empty-cleanup-'+process.pid);await mkdir(output,{recursive:true});const results=[];
for(const before of existsSync('before/src/ts/deploy.ts')?[true,false]:[false])for(const group of ['Direct','Monolithic','Uniform'] as const){
  const root=await temporary(),gateway=await egress(root,'replay'),dir=join(root,'case');await mkdir(dir);const events=join(dir,'events.jsonl');await writeFile(events,'');
  const hook=pathToFileURL(resolve('tests/t7-fix7-hook.mjs'));hook.searchParams.set('cfg',JSON.stringify({events,cleanup:{multi_turn_base_0:{memory:''}}}));
  const prior=process.env.NODE_OPTIONS;process.env.NODE_OPTIONS=[prior??'',...(before?['--import='+pathToFileURL(resolve('tests/t8c-fix1-before-deploy-hook.mjs')).href]:[]),'--import='+hook.href].join(' ');
  try{
    const run=await launchBlock(await block(dir,gateway.url,group,'empty-cleanup',1,['multi_turn_base_0','multi_turn_base_4'])),processResult=await run.done,summary=JSON.parse(await readFile(join(run.directory,'block-summary.json'),'utf8'));
    assert.equal(processResult.code,0,processResult.stderr);const oldBug=before&&group!=='Direct';assert.equal(summary.completed,oldBug?2:1);assert.equal(summary.skipped,oldBug?0:1);assert.equal(summary.interrupted,0);
    let failure=null;if(!oldBug){failure=JSON.parse(await readFile(join(run.directory,'failures/multi_turn_base_0.r1.json'),'utf8'));assert.equal(failure.failureType,'cleanup');assert.equal(failure.disposition,'skipped');}
    const result={before,group,root,summary,failure,processResult};results.push(result);json(join(output,'results.json'),results);console.log(JSON.stringify({before,group,completed:summary.completed,skipped:summary.skipped}));
  }finally{if(prior===undefined)delete process.env.NODE_OPTIONS;else process.env.NODE_OPTIONS=prior;await gateway.close();}
}
