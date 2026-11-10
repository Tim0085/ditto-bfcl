// Publish container item: runs tests/web-c-worker-ipc.test.ts inside the image under test, with the container settings of
// the segment C IPC check (runs/offline/web-c-20261109/ipc-fix/run-tests.ps1): no network, 2 CPU, 4 GiB, no swap, offline
// guard (paths relative to the image WORKDIR /app: the host guard reads file: URLs in child arguments as Windows paths). The image carries no tests/, so this package's tests/ is copied in before the start. The container is removed after.
// Image: ditto-sec1-bfcl-web:dev (the publish source tag), or WEB_C_IPC_IMAGE.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {join} from 'node:path';
import {ROOT} from '../src/ts/scheduler/io.ts';
import {SEC1_OWNER,SEC1_IMAGE_REPOSITORY} from '../src/ts/run-unit.ts';
const image=process.env.WEB_C_IPC_IMAGE??`${SEC1_IMAGE_REPOSITORY}:dev`;
function docker(args:string[],timeoutMs:number,echo=false){return new Promise<{code:number|null;stdout:string;stderr:string}>((yes,no)=>{
  const child=spawn('docker',args,{cwd:ROOT,windowsHide:true,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';
  child.stdout.on('data',b=>{stdout+=b;if(echo)process.stdout.write(b);});child.stderr.on('data',b=>{stderr+=b;if(echo)process.stderr.write(b);});
  const timer=setTimeout(()=>child.kill(),timeoutMs);child.once('error',e=>{clearTimeout(timer);no(e);});child.once('close',code=>{clearTimeout(timer);yes({code,stdout,stderr});});});}
const owner=JSON.parse((await docker(['image','inspect','--format','{{json .Config.Labels}}',image],15000)).stdout||'{}');
assert.equal(owner?.['sec1.owner'],SEC1_OWNER,'image '+image+' is not an owned package image');
const created=await docker(['create','--pull=never','--network','none','--init','--cpus=2','--memory=4g','--memory-swap=4g','--pids-limit=1024','--cap-drop=ALL',
  '--security-opt','no-new-privileges','--restart=no','--label',`sec1.owner=${SEC1_OWNER}`,'--label',`sec1.run=web-c-ipc-publish-${process.pid}`,image,
  'node','--import','./scripts/egress-offline-guard.mjs','--experimental-transform-types','--test','--test-isolation=none','--test-timeout=240000','tests/web-c-worker-ipc.test.ts'],15000);
const id=created.stdout.trim();assert.equal(created.code,0,created.stderr);assert.match(id,/^[0-9a-f]{64}$/);
try{
  const copied=await docker(['cp',join(ROOT,'tests'),`${id}:/app/tests`],120000);assert.equal(copied.code,0,copied.stderr);
  const run=await docker(['start','-a',id],900000,true);
  const state=(await docker(['inspect','--format','{{.State.ExitCode}} {{.State.OOMKilled}} {{.State.Running}}',id],15000)).stdout.trim();
  assert.equal(run.code,0,'web-c-worker-ipc failed in the container');assert.equal(state,'0 false false');
  console.log(JSON.stringify({webCWorkerIpcContainer:'PASS',image,container:id}));
}finally{
  const removed=await docker(['rm','-f',id],15000);if(removed.code!==0)console.error('container not removed: '+id+' '+removed.stderr);
}
