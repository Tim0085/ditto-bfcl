import assert from 'node:assert/strict';
import {mkdir,readFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {once} from 'node:events';
import {createServer} from 'node:net';
import {docker,labels,save,removeExited} from '../src/ts/docker/common.ts';
const root=resolve(process.env.SEC1_FIX4_EVIDENCE??'runs/offline/t8b-fix4-20261106','large-'+process.pid);await mkdir(root,{recursive:true});await mkdir(join(root,'guards'));
const tag=process.env.SEC1_FIX4_TAG??'test-t8b-fix4',imageId=JSON.parse((await docker(['image','inspect','ditto-sec1-bfcl:'+tag])).stdout)[0].Id,runId='t8b-fix4-large-'+process.pid;
const listener=createServer();listener.listen(0,'127.0.0.1');await once(listener,'listening');const port=(listener.address() as any).port;await new Promise<void>(r=>listener.close(()=>r()));
// Load the final image's actual Relay/Server definitions verbatim; omit only the
// config-main supervisor so it cannot exit before the raw upload stress finishes.
const python="source=open('/app/scripts/docker-entry.py').read();exec(source.split('runtime = ')[0]);print('ready',flush=True);Server(('127.0.0.1',18080),Relay).serve_forever()";
const args=['create','--pull=never',...labels(runId,'large'),'--mount',`type=bind,source=${root},target=/unit`,imageId,'python3','-B','-c',python,'--target',`host.docker.internal:${port}`];
const id=(await docker(args)).stdout.trim();
try{
  await docker(['start',id]);for(let i=0;;i++){if((await docker(['logs',id])).stdout.includes('ready'))break;assert(i<500);await new Promise(r=>setTimeout(r,20));}
  const probe=`import assert from 'node:assert/strict';import {request} from 'node:http';
const body=Buffer.alloc(8*1024*1024,120);for(let i=0;i<20;i++)await new Promise((resolve,reject)=>{
 const headers={'content-type':'application/json'};if(i<10)headers['content-length']=String(body.length);
 const r=request('http://127.0.0.1:18080/v1/sample',{method:'POST',agent:false,headers},res=>{let chunks=[];res.on('data',b=>chunks.push(b));res.on('error',reject);res.on('end',()=>{try{assert.equal(res.statusCode,502);assert.equal(res.headers['x-ditto-relay'],'upstream-not-connected-v1');assert.equal(res.headers['content-length'],'38');assert.equal(Buffer.concat(chunks).toString(),'DITTO_RELAY_UPSTREAM_NOT_CONNECTED_V1\\n');console.log(JSON.stringify({iteration:i+1,bytes:body.length,framing:i<10?'content-length':'chunked',status:res.statusCode,marker:res.headers['x-ditto-relay'],socketErrors:0}));resolve();}catch(e){reject(e);}});});r.on('error',reject);
 if(i<10)r.end(body);else {r.write(body.subarray(0,body.length/2));r.end(body.subarray(body.length/2));}
});`;
  const execArgs=['exec','-e','OFFLINE_GUARD_REPORT_DIR=/unit/guards',id,'node','--import=/app/scripts/egress-offline-guard.mjs','--input-type=module','-e',probe];
  const result=await docker(execArgs,true);await save(join(root,'process.json'),{command:['docker',...execArgs],...result});console.log(result.stdout,result.stderr);assert.equal(result.code,0);
  assert.equal((await readFile(join(root,'relay.jsonl'),'utf8')).trim().split('\n').length,20);
  console.log('PASS: 20/20 actual-image relay failures, 8 MiB uploads, 10 Content-Length + 10 chunked, zero ECONNRESET/EPIPE');
}finally{await docker(['kill',id]);await removeExited(id,runId,'large');await save(join(root,'create.json'),['docker',...args]);}
