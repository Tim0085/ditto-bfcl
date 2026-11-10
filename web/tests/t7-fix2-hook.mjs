// Test-only in-memory source injection, inherited by this test's own Worker children.
import { registerHooks } from 'node:module';
const faults=JSON.parse(new URL(import.meta.url).searchParams.get('faults')??'[]');
globalThis.__t7Fix2Fault=async function(node,input,clean=false){
  const taskId=typeof input==='string'?input:input?.scope?.sessionId??input?.metadata?.taskId??input?.call?.arguments?.taskId??input?.memories?.[0]?.metadata?.taskId;
  const f=faults.find(f=>taskId?.endsWith('/'+f.caseId));
  if(!f)return;
  if(clean){if(f.type==='cleanup'||f.extraCleanup)throw new Error('injected cleanup');return;}
  if(node==='CONTEXT.SELECT'&&f.delay)await new Promise(r=>setTimeout(r,f.delay));
  if(node==='CONTEXT.SELECT'&&f.type==='context-error')throw new Error('injected context');
  if(node==='CONTEXT.SELECT'&&f.type==='context-invalid')return {value:{context:{items:[{id:'bad',metadata:{sequence:-1}}]}}};
  if(node==='INTERACTION.ACT.TOOL'&&input.call.arguments.request?.action==='call'&&f.type==='tool-channel')throw new Error('injected tool channel');
  if((node==='INFER.REASONING.SAMPLE'&&f.type==='sample-not-success')||(node==='MEMORY.WRITE'&&f.type==='memory-not-success'))return {value:{status:f.status??'failed',error:{message:'opaque failure'}}};
};
registerHooks({load(url,context,next){
  const r=next(url,context);
  if(!url.endsWith('/src/ts/agent-core.ts'))return r;
  let source=String(r.source);
  const needle='const target = executor(capability);';
  if(!source.includes(needle))throw new Error('Fault hook target missing');
  source=source.replace(needle,needle+' const injected=await globalThis.__t7Fix2Fault(node,input); if(injected)return injected.value;');
  source=source.replace('const errors = results.filter',"await globalThis.__t7Fix2Fault(null,taskId,true); const errors = results.filter");
  return {...r,source};
}});
