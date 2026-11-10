import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {block,fakeServer,sampleOutput} from './t7-helpers.ts';
const root=resolve(process.env.SEC1_FIX4_EVIDENCE??'runs/offline/t8b-fix4-20261106','normal-'+process.pid);await mkdir(root,{recursive:true});
const hook=process.argv[2];assert(hook,'Pass absolute normal-hook.mjs path');
const bodies:any[]=[];let current:string[]=[];
const gateway=await fakeServer((body,res)=>{current.push(JSON.stringify(body));res.end(JSON.stringify({ok:true,output:sampleOutput}));});
const artifacts:Record<string,Buffer[]>={};
try{
  for(const mode of ['before','after']){
    current=[];const dir=join(root,mode);await mkdir(dir);const b=await block(dir,gateway.url,'Direct','normal');b.sampling.enabled=false;
    const file=join(dir,'block.json');await writeFile(file,JSON.stringify(b));const url=pathToFileURL(hook);url.searchParams.set('mode',mode);
    const args=['--import','./scripts/egress-offline-guard.mjs','--import',url.href,'--experimental-transform-types','src/ts/config-main.ts','--block',file];
    const child=spawn(process.execPath,args,{windowsHide:true,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
    const code=await new Promise<number|null>(r=>child.once('close',r));await writeFile(join(dir,'process.json'),JSON.stringify({command:['node',...args],code,stdout,stderr},null,2));assert.equal(code,0,stderr);
    artifacts[mode]=await Promise.all(['direct.steps.jsonl','steps.jsonl'].map(n=>readFile(join(dir,'configs','normal',n))));bodies.push(current);
  }
  assert.deepEqual(bodies[0],bodies[1]);
  for(let i=0;i<2;i++){
    assert(artifacts.before[i].equals(artifacts.after[i]));console.log(JSON.stringify({artifact:['direct.steps.jsonl','steps.jsonl'][i],rawBytesEqual:true,bytes:artifacts.before[i].length,sha256:createHash('sha256').update(artifacts.before[i]).digest('hex')}));
  }
  console.log('PASS: actual normal Direct steps before/after byte-identical under common fixed clock/PID/UUID/CPU/RSS fixture; request bodies byte-identical');
}finally{await gateway.close();}
