import {registerHooks} from 'node:module';
import {appendFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
const cfg=JSON.parse(new URL(import.meta.url).searchParams.get('cfg'));
globalThis.__fix6Observe=kind=>appendFileSync(cfg.events,JSON.stringify({kind,pid:process.pid,tmpdir:tmpdir(),TEMP:process.env.TEMP,TMP:process.env.TMP,TMPDIR:process.env.TMPDIR,secret:process.env.SEC1_FAKE_SECRET??null})+'\n');
globalThis.__fix6Results=(id,results,ownsContext)=>{
  if(!ownsContext||!id.endsWith('/multi_turn_base_0'))return results;
  const errors=cfg.mode==='aggregate'?[new Error('context deletion failed'),new Error('memory release failed')]:
    cfg.mode==='nested'?[new AggregateError([new Error('Python release failed'),new Error('inflight drain failed')],'nested cleanup'),new Error('memory release failed')]:
    cfg.mode==='single'?[new Error('context deletion failed')]:[];
  // Replace actual cleanup slots so production can retain their provenance.
  for(const [i,reason] of errors.entries())results[[0,2][i]]={status:'rejected',reason};
  return results;
};
registerHooks({load(url,ctx,next){
  const r=next(url,ctx);let source=String(r.source);
  const replace=(a,b)=>{if(!source.includes(a))throw new Error('fix6 hook target missing '+a);source=source.replace(a,b);};
  if(cfg.baseline&&url.endsWith('/src/ts/config-main.ts'))replace('...aggregateDiagnostics(errors),','');
  if(cfg.observe){
    if(url.endsWith('/src/ts/config-main.ts'))replace('Object.assign(process.env,env);','Object.assign(process.env,env); globalThis.__fix6Observe("cli");');
    if(url.endsWith('/src/ts/worker-host.ts'))source+='\nglobalThis.__fix6Observe("worker");\n';
    if(url.endsWith('/src/ts/python-bridge.ts'))replace('["-B", "-X", "utf8", bridgePath]',`["-B", "-X", "utf8", ${JSON.stringify(cfg.wrapper)}, bridgePath]`);
  }
  if(cfg.mode&&url.endsWith('/src/ts/agent-core.ts')){
    replace('const errors = results.filter','const errors = globalThis.__fix6Results(taskId,results,Boolean(contextQueue)).filter');
    if(cfg.mode==='ordinary')replace('const target = executor(capability);','if(node==="CONTEXT.SELECT"&&input.scope.sessionId.endsWith("/multi_turn_base_0"))throw new Error("ordinary context failure"); const target = executor(capability);');
  }
  return {...r,source};
}});
