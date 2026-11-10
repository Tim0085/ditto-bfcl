import {registerHooks} from 'node:module';
import {appendFileSync,readFileSync} from 'node:fs';
const cfg=JSON.parse(new URL(import.meta.url).searchParams.get('cfg'));
const shared=Object.freeze(new Error('access denied'));
globalThis.__fix7Shared=shared;
let hasTool=false;
const caseOf=id=>typeof id==='string'?id.split('/').at(-1):undefined;
const event=row=>appendFileSync(cfg.events,JSON.stringify({pid:process.pid,worker:Boolean(process.send),...row})+'\n');
function fault(source,id){
  const spec=cfg.cleanup?.[caseOf(id)],message=spec?.[source];
  if(message===undefined)return;
  event({source,caseId:caseOf(id)});
  return cfg.nested&&source==='drain'?new AggregateError([new Error(message)],'nested settlement'):new Error(message);
}
globalThis.__fix7Fail=(source,id)=>{const error=fault(source,id);if(error)throw error;};
globalThis.__fix7Drain=id=>{
  if(!hasTool)return;
  const error=fault('drain',id);if(error)return Promise.reject(error);
};
globalThis.__fix7Tool=()=>{hasTool=true;};
globalThis.__fix7Before=(node,input)=>{
  const id=input?.scope?.sessionId;
  if(node==='CONTEXT.SELECT'&&(cfg.select??[]).includes(caseOf(id))){event({source:'select',caseId:caseOf(id)});throw new Error('ordinary CONTEXT.SELECT failure');}
};
globalThis.__fix7Results=(id,results)=>{
  if(id.startsWith('identity-'))results[Number(id.slice(9))]={status:'rejected',reason:shared};
  return results;
};
registerHooks({load(url,context,next){
  const result=next(url,context);if(!url.includes('/src/ts/'))return result;
  const name=url.split('/src/ts/')[1].split('?')[0];let source=String(result.source);
  if(cfg.baselineDirectory&&['agent-core.ts','worker-host.ts','deploy.ts','step-log.ts','config-main.ts'].includes(name))source=readFileSync(cfg.baselineDirectory+'/'+name,'utf8');
  const replace=(a,b)=>{if(!source.includes(a))throw new Error('fix7 hook anchor missing '+name+': '+a);source=source.replace(a,b);};
  if(name==='agent-core.ts'){
    if(cfg.identity)replace('const errors = results.filter','const errors = globalThis.__fix7Results(taskId,results).filter');
    else {
      replace('const target = executor(capability);','globalThis.__fix7Before(node,input); const target = executor(capability);');
      replace('drainModelCalls(taskId),','(globalThis.__fix7Drain(taskId) ?? drainModelCalls(taskId)),');
    }
  }
  if(name==='context-store.ts')replace('async delete(scope, call = {}) { call.signal?.throwIfAborted(); return entries.delete(contextScopeKey(scope)); },','async delete(scope, call = {}) { call.signal?.throwIfAborted(); globalThis.__fix7Fail("context",scope.sessionId); return entries.delete(contextScopeKey(scope)); },');
  if(name==='memory-store.ts')replace('releaseTask(taskId) { return serial(async () => { writtenTasks.delete(taskId); }); },','releaseTask(taskId) { return serial(async () => { globalThis.__fix7Fail("memory",taskId); writtenTasks.delete(taskId); }); },');
  if(name==='tool-service.ts'){
    replace('async function releaseTask(taskId: string): Promise<boolean> {','async function releaseTask(taskId: string): Promise<boolean> { globalThis.__fix7Fail("python",taskId);');
    replace('export function createToolService(python: string, bridgePath = fileURLToPath(new URL("../python/bridge.py", import.meta.url))) {','export function createToolService(python: string, bridgePath = fileURLToPath(new URL("../python/bridge.py", import.meta.url))) { globalThis.__fix7Tool();');
  }
  return {...result,source};
}});
