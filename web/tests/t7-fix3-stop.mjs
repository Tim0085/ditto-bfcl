import assert from 'node:assert/strict';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
const {block,fakeServer,sampleOutput,command}=await import(pathToFileURL(resolve('tests/t7-helpers.ts')));
const root=resolve(process.argv[2]);await mkdir(root,{recursive:true});
const gateway=await fakeServer((body,res)=>res.end(JSON.stringify(body.caseId==='multi_turn_base_0'?{ok:false,error:{kind:'run_stop',details:{reason:'review forced stop'}}}:{ok:true,output:sampleOutput})));
const old=process.env.NODE_OPTIONS;
try{
 const b=await block(root,gateway.url,'Monolithic','stop',2,['multi_turn_base_0','multi_turn_base_4','multi_turn_miss_func_0']);b.copies={All:2};b.sampling.enabled=false;
 const config=join(root,'block.json');await writeFile(config,JSON.stringify(b));
 const hook=new URL('./t7-fix3-stop-hook.mjs',import.meta.url);hook.searchParams.set('out',join(root,'order.jsonl'));
 process.env.NODE_OPTIONS=(old??'')+' --import='+hook.href;
 const run=await command(process.execPath,['--import','./scripts/egress-offline-guard.mjs','--experimental-transform-types','src/ts/config-main.ts','--block',config],join(root,'process.json'));
 const dir=join(root,'configs','stop'),summary=JSON.parse(await readFile(join(dir,'block-summary.json'),'utf8'));
 const order=(await readFile(join(root,'order.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);
 console.log(JSON.stringify({run,summary,order}));assert.equal(run.code,1);assert.equal(summary.notStarted,1);assert.equal(summary.skipped,0);assert.equal(summary.interrupted,2);
 assert.equal(order.filter(e=>e.event==='start').length,2);console.log('PASS run_stop closes admission before asynchronous liveness');
}finally{if(old===undefined)delete process.env.NODE_OPTIONS;else process.env.NODE_OPTIONS=old;await gateway.close();}
