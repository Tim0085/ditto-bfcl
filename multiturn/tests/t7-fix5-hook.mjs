// Test-only faults. The normal Python kill/timeout paths never manufacture Error objects.
import {registerHooks} from 'node:module';
import {appendFileSync} from 'node:fs';
const cfg=JSON.parse(new URL(import.meta.url).searchParams.get('cfg'));
const shared=new Map();
const selected=(taskId,list=[])=>list.find(id=>taskId?.endsWith('/'+id));
const record=event=>appendFileSync(cfg.events,JSON.stringify({nodePid:process.pid,...event})+'\n');
globalThis.__fix5StartPython=(start,python,bridge,caseId)=>{
  const faulty=cfg.pythonCases.includes(caseId);
  const result=start(python,faulty?cfg.wrapper:bridge,faulty?cfg.timeoutMs:10000);
  if(faulty)record({event:'owned-python',pid:result.pid,caseId,timeoutMs:cfg.timeoutMs});
  return result;
};
globalThis.__fix5Shared=(node,input)=>{
  const taskId=input?.scope?.sessionId;
  if(node!=='CONTEXT.SELECT'||!selected(taskId,cfg.sharedCases))return;
  let error=shared.get(taskId);
  if(!error){error=new Error('fix5 shared context and cleanup');shared.set(taskId,error);}
  record({event:'shared-primary',taskId,node});throw error;
};
globalThis.__fix5Cleanup=taskId=>{
  if(shared.has(taskId)){record({event:'shared-cleanup',taskId});throw shared.get(taskId);}
  if(selected(taskId,cfg.cleanupCases)){record({event:'new-cleanup',taskId});throw new Error('fix5 new cleanup failure');}
};
registerHooks({load(url,context,next){
  const result=next(url,context);let source=String(result.source);
  if(url.endsWith('/src/ts/tool-service.ts')){
    const needle='startPython(python,bridgePath)';
    if(!source.includes(needle))throw new Error('fix5 bridge hook target missing');
    source=source.replace(needle,'globalThis.__fix5StartPython(startPython,python,bridgePath,request.case_id)');
  }
  if(url.endsWith('/src/ts/agent-core.ts')){
    const invoke='const target = executor(capability);',cleanup='const errors = results.filter';
    if(!source.includes(invoke)||!source.includes(cleanup))throw new Error('fix5 core hook target missing');
    source=source.replace(invoke,invoke+' globalThis.__fix5Shared(node,input);');
    source=source.replace(cleanup,'globalThis.__fix5Cleanup(taskId); '+cleanup);
  }
  return {...result,source};
}});
