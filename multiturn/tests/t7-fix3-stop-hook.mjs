import {registerHooks} from 'node:module';
import {appendFileSync} from 'node:fs';
const params=new URL(import.meta.url).searchParams,out=params.get('out');
globalThis.__reviewBarrier=new Promise(resolve=>globalThis.__reviewRelease=resolve);
globalThis.__reviewMark=(event,caseId)=>appendFileSync(out,JSON.stringify({event,caseId,ns:String(process.hrtime.bigint())})+'\n');
registerHooks({load(url,context,next){
 const r=next(url,context);let source=String(r.source);
 if(url.endsWith('/src/ts/config-main.ts')){
  source=source.replace('active++;maxActive','globalThis.__reviewMark("start",caseId);active++;maxActive');
  source=source.replace('const task=await loadTask(caseId)', 'if(caseId==="multi_turn_base_4")await globalThis.__reviewBarrier; const task=await loadTask(caseId)');
 }
 if(url.endsWith('/src/ts/deploy.ts'))source=source.replace('async function confirmAlive(workerIds:Iterable<string>) {','async function confirmAlive(workerIds:Iterable<string>) { globalThis.__reviewMark("confirm",null);globalThis.__reviewRelease();await new Promise(resolve=>setTimeout(resolve,3000));');
 return {...r,source};
}});
