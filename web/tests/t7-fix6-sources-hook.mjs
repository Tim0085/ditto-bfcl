import {registerHooks} from 'node:module';
const cfg=JSON.parse(new URL(import.meta.url).searchParams.get('cfg'));
const shared=new Error('access denied');
globalThis.__fix6SourceShared=shared;
globalThis.__fix6SourceResults=(id,results,ownsContext)=>{
  if(cfg.identity){
    if(id.startsWith('single-'))results[Number(id.slice(7))]={status:'rejected',reason:shared};
    else for(const index of [0,2])results[index]={status:'rejected',reason:shared};
    return results;
  }
  if(!ownsContext||!id.endsWith('/multi_turn_base_0'))return results;
  const copy=[...results];
  for(const index of cfg.pair)copy[index]={status:'rejected',reason:new Error('access denied')};
  return copy;
};
registerHooks({load(url,ctx,next){
  const result=next(url,ctx);if(!url.endsWith('/src/ts/agent-core.ts'))return result;
  const source=String(result.source),needle='const errors = results.filter';
  if(!source.includes(needle))throw new Error('source hook missing cleanup results');
  return {...result,source:source.replace(needle,'const errors = globalThis.__fix6SourceResults(taskId,results,Boolean(contextQueue)).filter')};
}});
