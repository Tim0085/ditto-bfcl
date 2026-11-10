// T9 unit fault hook, mounted as /unit/hook.mjs. fail: {caseId: node} throws when that case reaches that node;
// waitCase pauses the case at its first node (Direct calls INTERACTION.ACT.TOOL for a snapshot first) until /unit/release appears.
import {registerHooks} from 'node:module';
import fs from 'node:fs';
const options=JSON.parse(fs.readFileSync('/unit/fault.json','utf8'));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const waited=new Set();
globalThis.__t9Auth=async(node,input)=>{
  const taskId=input?.scope?.sessionId??input?.metadata?.taskId??input?.call?.arguments?.taskId;
  if(!taskId)return;
  const caseId=String(taskId).split('/').at(-1);
  if(options.waitCase===caseId&&!waited.has(caseId)){waited.add(caseId);fs.writeFileSync('/unit/wait-entered',caseId);while(!fs.existsSync('/unit/release'))await sleep(25);}
  if(options.fail?.[caseId]===node)throw Error('t9 fixture failure at '+node);
};
registerHooks({load(url,context,next){const result=next(url,context);const source=String(result.source);
  if(url.endsWith('/src/ts/agent-core.ts')){const at='const target = executor(capability);';if(!source.includes(at))throw Error('t9 hook target missing');return {...result,source:source.replace(at,at+' await globalThis.__t9Auth(node,input);')};}
  return result;
}});
