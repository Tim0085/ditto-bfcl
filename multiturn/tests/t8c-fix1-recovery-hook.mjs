import fs from 'node:fs';
import {registerHooks,syncBuiltinESMExports} from 'node:module';
const o=JSON.parse(new URL(import.meta.url).searchParams.get('o'));
function block(path){const deadline=Date.now()+30000;while(!fs.existsSync(path)){if(Date.now()>deadline)throw Error('Recovery barrier timed out: '+path);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}}
if(o.role==='A'){
  const native=fs.renameSync;fs.renameSync=function(from,to){if(String(from).replaceAll('\\','/').endsWith('/egress/gateway.lock')){fs.writeFileSync(o.readyA,'A read stale owner; before archive');block(o.releaseA);}return native.call(this,from,to);};
}
if(o.role==='B'&&!o.afterOpen){
  const native=fs.writeSync;fs.writeSync=function(...args){const result=native.apply(this,args);if(typeof args[1]==='string'&&args[1].includes('"kind":"recovery"')){fs.writeFileSync(o.readyB,'B holds live gateway lock');block(o.releaseB);}return result;};
}
if(o.role==='B'&&o.afterOpen){
  globalThis.__t8cf1RecoveryOpened=async pending=>{fs.writeFileSync(o.readyB,JSON.stringify({pid:process.pid,pending}));while(!fs.existsSync(o.releaseB))await new Promise(r=>setTimeout(r,10));};
  registerHooks({load(url,context,next){const result=next(url,context);if(url.endsWith('/src/ts/scheduler/egress.ts')){const source=String(result.source),at='const before=ledger.snapshot(),unknown=';if(!source.includes(at))throw Error('Recovery after-open anchor missing');return {...result,source:source.replace(at,'await globalThis.__t8cf1RecoveryOpened(ledger.pending.size);'+at)};}return result;}});
}
if(o.role==='transport'){
  globalThis.__t8cf1Hold=async()=>{fs.writeFileSync(o.entered,'request admitted and reserved');await new Promise(()=>{});};
  registerHooks({load(url,context,next){const result=next(url,context);if(url.endsWith('/src/ts/egress/backends/replay.ts')){const source=String(result.source),at='signal.throwIfAborted();';if(!source.includes(at))throw Error('Transport anchor missing');return {...result,source:source.replace(at,at+'await globalThis.__t8cf1Hold();')};}return result;}});
}
syncBuiltinESMExports();
