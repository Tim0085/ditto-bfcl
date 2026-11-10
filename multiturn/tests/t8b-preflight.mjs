// Fail closed on the two platform prerequisites before implementing the launcher.
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import assert from 'node:assert/strict';
const evidence = resolve('runs/offline/t8b-20261105');
const scratchParent = join(tmpdir(), 't8b-scratch');
await mkdir(scratchParent, { recursive: true });
const scratch = await mkdtemp(join(scratchParent, 'preflight-'));
const run = 't8b-preflight-' + process.pid;
async function command(args) {
  console.log('COMMAND:', JSON.stringify(['docker', ...args]));
  const child = spawn('docker', args, { windowsHide:true, stdio:['ignore','pipe','pipe'] });
  let stdout='', stderr='';
  child.stdout.on('data', b=>stdout+=b); child.stderr.on('data', b=>stderr+=b);
  const code = await new Promise((yes,no)=>{child.once('error',no); child.once('close',yes);});
  console.log(stdout,stderr,'EXIT CODE:',code);
  return { code,stdout,stderr };
}
const image='node@sha256:d8e448a56fc63242f70026718378bd4b00f8c82e78d20eefb199224a4d8e33d8';
const server=createServer((req,res)=>res.end('t8b-local-egress'));
server.listen(0,'127.0.0.1');await once(server,'listening');
const port=server.address().port;
console.log('Host listener:',server.address());
const common=['run','--pull=never','--label','sec1.owner=ditto-sec1-bfcl','--label',`sec1.run=${run}`,'--label','sec1.unit=preflight','--user','1000:1000','--cap-drop=ALL','--security-opt','no-new-privileges','--cpus=2','--memory=4g','--memory-swap=4g','--pids-limit=128'];
try {
  const hardlink=await command([...common,'--name',`sec1-${run}-hardlink`,'--network','none','--mount',`type=bind,source=${scratch},target=/output`,image,'node','--input-type=module','-e',`import fs from 'node:fs';fs.writeFileSync('/output/temp','test',{flag:'wx'});fs.linkSync('/output/temp','/output/final');fs.unlinkSync('/output/temp');if(fs.readFileSync('/output/final','utf8')!=='test')throw Error('bad content');console.log('PASS: bind mount same-directory hard-link publication');`]);
  await writeFile(join(evidence,'preflight-hardlink.json'),JSON.stringify(hardlink,null,2));
  assert.equal(hardlink.code,0,'Design blocker: bind-mount hard link unavailable');
  const connection=await command([...common,'--name',`sec1-${run}-egress`,image,'node','--input-type=module','-e',`const response=await fetch('http://host.docker.internal:${port}',{signal:AbortSignal.timeout(10000)});const text=await response.text();if(text!=='t8b-local-egress')throw Error(text);console.log('PASS: host loopback-only egress reachable');`]);
  await writeFile(join(evidence,'preflight-egress.json'),JSON.stringify(connection,null,2));
  assert.equal(connection.code,0,'Design blocker: host loopback-only egress unreachable');
} finally {
  const found=await command(['ps','-aq','--filter','label=sec1.owner=ditto-sec1-bfcl','--filter',`label=sec1.run=${run}`]);
  for(const id of found.stdout.trim().split(/\s+/).filter(Boolean)) {
    const inspected=await command(['inspect',id]);
    const info=JSON.parse(inspected.stdout)[0];
    assert.equal(info.Config.Labels['sec1.run'],run);
    assert.equal(info.State.Running,false);
    await command(['rm',id]);
  }
  server.closeAllConnections();await new Promise(r=>server.close(r));
  assert(scratch.startsWith(scratchParent+ '\\') || scratch.startsWith(scratchParent+'/'));
  await rm(scratch,{recursive:true});
}
