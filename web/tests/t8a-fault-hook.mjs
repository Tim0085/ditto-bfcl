// Offline test injection only; no source files are modified.
import {registerHooks} from 'node:module';
import {existsSync,writeFileSync} from 'node:fs';
const options=JSON.parse(new URL(import.meta.url).searchParams.get('options')??'{}');
globalThis.__t8Fault=async(node,input)=>{
 const taskId=input?.scope?.sessionId??input?.metadata?.taskId??input?.call?.arguments?.taskId??input?.memories?.[0]?.metadata?.taskId;
 if(!taskId||options.configId&&!taskId.includes('/'+options.configId+'/')||options.caseId&&!taskId.endsWith('/'+options.caseId)||options.disableFile&&existsSync(options.disableFile))return;
 if(options.hangTool&&node==='INTERACTION.ACT.TOOL'&&input?.call?.arguments?.request?.action==='call'){
   if(options.signalFile)writeFileSync(options.signalFile,JSON.stringify({pid:process.pid,taskId}));
   await new Promise(()=>{setInterval(()=>{},1000);});
 }
 if(options.skip&&node==='CONTEXT.SELECT')throw new Error('t8a injected context failure');
};
globalThis.__t8EgressDelay=async(signal)=>{
 if(options.disableFile&&existsSync(options.disableFile))return;
 if(options.stopEgress)throw new Error('t8a fake egress stop');
 if(options.delayMs)await new Promise((yes,no)=>{const timer=setTimeout(yes,options.delayMs);signal.addEventListener('abort',()=>{clearTimeout(timer);no(signal.reason);},{once:true});});
};
registerHooks({load(url,context,next){const r=next(url,context);let source=String(r.source);
 if(url.endsWith('/src/ts/agent-core.ts')){const needle='const target = executor(capability);';if(!source.includes(needle))throw new Error('Hook target missing');source=source.replace(needle,needle+' await globalThis.__t8Fault(node,input);');}
 if(url.endsWith('/src/ts/egress/backends/replay.ts'))source=source.replace('signal.throwIfAborted();','signal.throwIfAborted();await globalThis.__t8EgressDelay(signal);');
 return {...r,source};
}});
