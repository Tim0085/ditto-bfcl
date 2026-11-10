import {registerHooks} from 'node:module';
import {appendFileSync} from 'node:fs';
import {ModelTransportError} from '../src/ts/egress/model.ts';
const o=JSON.parse(new URL(import.meta.url).searchParams.get('options')??'{}');
let calls=0;
globalThis.__fix5Wait=async signal=>{
 const n=++calls;if(n>3)return;
 const start=Date.now();appendFileSync(o.trace,JSON.stringify({n,start})+'\n');
 try{
  if(n<3)await new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(new ModelTransportError('scaled timeout','fetch',signal.reason)),{once:true}));
  else await new Promise(r=>setTimeout(r,o.thirdMs));
 }finally{appendFileSync(o.trace,JSON.stringify({n,end:Date.now()})+'\n');}
};
registerHooks({load(url,context,next){const r=next(url,context);let source=String(r.source);
 if(url.endsWith('/src/ts/egress/backends/replay.ts'))source=source.replace('signal.throwIfAborted();','signal.throwIfAborted();await globalThis.__fix5Wait(signal);');
 if(url.endsWith('/src/ts/egress/retry.ts'))source=source.replace('30000*2**attempt,120000','100*2**attempt,400');
 return {...r,source};
}});
