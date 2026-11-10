import {registerHooks} from 'node:module';
import {existsSync,writeFileSync,appendFileSync,readFileSync} from 'node:fs';
const options=JSON.parse(new URL(import.meta.url).searchParams.get('options')??'{}');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let entered=false,seen=0;
// T9: "<configId>/<caseId>" -> release file. The request waits inside the replay backend, so it counts as in flight.
const holds=options.holds?JSON.parse(readFileSync(options.holds,'utf8')):{};
globalThis.__t8cReplay=async(input)=>{
  if(options.disabled&&existsSync(options.disabled))return;
  if(options.freezeAfter&&++seen===options.freezeAfter){writeFileSync(options.entered,'frozen at '+input.metadata.configId);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}
  const hold=holds[input.metadata.configId+'/'+input.metadata.caseId];if(hold)while(!existsSync(hold))await sleep(25);
  if(options.stopConfig===input.metadata.configId&&existsSync(options.stopArmed))throw Error('t9 deliberate fake-egress stop');
  if(options.barriers){const category=String(input.metadata.caseId).replace(/_\d+$/,'');while(!existsSync(options.barriers+'/release-'+category))await sleep(25);}
  if(options.stop)throw Error('t8c deliberate fake-egress stop');
  if(options.entered&&!entered){entered=true;writeFileSync(options.entered,'entered');
    if(options.blockHeartbeatForever){appendFileSync(options.entered,' heartbeat blocked permanently');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}
    if(options.blockHeartbeatMs){appendFileSync(options.entered,' heartbeat blocked');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,options.blockHeartbeatMs);}
  }
  if(options.release)while(!existsSync(options.release))await sleep(25);
  if(options.delayMs)await sleep(options.delayMs);
};
registerHooks({load(url,context,next){const r=next(url,context);if(url.endsWith('/src/ts/egress/backends/replay.ts')){
  const source=String(r.source),at='signal.throwIfAborted();';if(!source.includes(at))throw Error('Egress fixture hook target missing');
  return {...r,source:source.replace(at,at+'await globalThis.__t8cReplay(input);')};
}return r;}});
