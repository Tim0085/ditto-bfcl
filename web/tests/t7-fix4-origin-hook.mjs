// Faults occur inside the loading/checking operation, never inside the classifier.
import {registerHooks,syncBuiltinESMExports} from 'node:module';
import fs from 'node:fs';
const cfg=JSON.parse(new URL(import.meta.url).searchParams.get('cfg')??'{}');
const loads=new Map();
if(cfg.publish){
  const link=fs.linkSync;
  fs.linkSync=function(from,to,...rest){
    const path=String(to).replaceAll('\\','/');
    const chosen=cfg.publish.cases.some(id=>path.endsWith('/'+id+'.r1.json'));
    if(chosen&&(path.includes('/tasks/')||(cfg.publish.failures&&path.includes('/failures/'))))
      throw Object.assign(new Error('injected result publication failure'),{code:'EACCES'});
    return link.call(this,from,to,...rest);
  };
  syncBuiltinESMExports();
}
globalThis.__fix4Load=caseId=>{
  const f=cfg.load;
  if(!f||!f.cases.includes(caseId)||(f.scope==='worker'&&!process.send)||(f.scope==='main'&&process.send))return;
  const n=(loads.get(caseId)??0)+1;loads.set(caseId,n);
  if(n===f.nth)throw new Error('injected task data load failure');
};
globalThis.__fix4Context=(node,input,result)=>{
  const taskId=input?.scope?.sessionId;
  const f=cfg.context?.find(x=>taskId?.endsWith('/'+x.caseId)&&node===(x.node??'CONTEXT.SELECT'));
  if(!f)return result;
  if(f.type==='throw')throw new Error('injected context');
  const r=structuredClone(result),context=node==='CONTEXT.SELECT'?r.context:r;
  if(f.type==='drop'){
    context.items.pop();
    if(r.selectedItemIds)r.selectedItemIds=context.items.map(x=>x.id);
  }else if(f.type==='bad-sequence')context.items[0].metadata.sequence=-1;
  else if(f.type==='bad-envelope')context.items[0].metadata.dittoModelMessage={version:999};
  return r;
};
registerHooks({load(url,context,next){
  const r=next(url,context);let s=String(r.source);
  if(url.endsWith('/src/ts/tool-actions.ts')&&cfg.load){
    // Inject into the operation's try, equivalent to a read/parse/validation failure.
    const needle='const task = await loadTask(caseId);';
    if(!s.includes(needle))throw new Error('loading hook target missing');
    s=s.replace(needle,'globalThis.__fix4Load(caseId); '+needle);
  }
  if(url.endsWith('/src/ts/agent-core.ts')&&cfg.context){
    const needle='return target.execute(node,input,ctx);';
    if(!s.includes(needle))throw new Error('context hook target missing');
    s=s.replace(needle,'return globalThis.__fix4Context(node,input,await target.execute(node,input,ctx));');
  }
  return {...r,source:s};
}});
