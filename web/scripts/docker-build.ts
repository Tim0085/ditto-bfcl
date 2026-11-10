import { mkdtemp,mkdir,rm,realpath } from "node:fs/promises";
import { join,resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { docker,save,labels,removeExited } from "../src/ts/docker/common.ts";
import { containerName } from '../src/ts/docker/launcher.ts';
import { SEC1_LABELS,SEC1_OWNER,SEC1_IMAGE_REPOSITORY } from "../src/ts/run-unit.ts";
import {imageContext,bases} from '../src/ts/docker/image-context.ts';
const tag=process.argv.find(a=>a.startsWith('--tag='))?.slice(6)??'dev';
if(tag!=='dev'&&!/^test-[a-z0-9-]+$/.test(tag))throw Error('Build only accepts dev or test-*; formal tags require docker-publish.ts');
const root=resolve('.'),scratch=process.env.SEC1_DOCKER_SCRATCH??tmpdir();
await mkdir(scratch,{recursive:true});
const staging=await mkdtemp(join(scratch,'t8b-build-')),context=join(staging,'payload');
await mkdir(context);
async function copyNodeArchive(from:string,to:string){
  // A tar stream preserves the executable bit across the Windows host; no extraction/repacking.
  const args1=['cp',`${from}:/usr/local/bin/node`,'-'],args2=['cp','-',`${to}:/usr/local/bin/`];
  console.log(JSON.stringify({binaryTransfer:[['docker',...args1],['docker',...args2]]}));
  const a=spawn('docker',args1,{windowsHide:true,stdio:['ignore','pipe','pipe']}),b=spawn('docker',args2,{windowsHide:true,stdio:['pipe','pipe','pipe']});
  let errors='',bytes=0;b.stdin.on('error',e=>errors+=String(e));a.stdout.on('data',data=>bytes+=data.length);a.stdout.pipe(b.stdin);
  a.stderr.on('data',data=>errors+=data);b.stderr.on('data',data=>errors+=data);b.stdout.resume();
  let timer:ReturnType<typeof setTimeout>|undefined;
  const finished=Promise.all([a,b].map(child=>new Promise<number|null>((yes,no)=>{child.once('error',no);child.once('close',yes);})));
  let codes:(number|null)[];
  try{codes=await Promise.race([finished,new Promise<never>((_,reject)=>{timer=setTimeout(()=>{
    a.kill();b.kill();a.stdout.destroy();a.stderr.destroy();b.stdin.destroy();b.stdout.destroy();b.stderr.destroy();
    reject(Error('Local Docker Node archive copy timed out after 120000ms; build container contents are unknown'));
  },120000);})]);}finally{clearTimeout(timer);}
  if(codes.some(code=>code!==0)||errors)throw Error(`Node archive transfer failed: ${codes} ${errors}`);
  console.log(JSON.stringify({binaryTransferBytes:bytes,exitCodes:codes}));
}
try{
  const baseIds:string[]=[];for(const base of bases)baseIds.push(JSON.parse((await docker(['image','inspect',base])).stdout)[0].Id);
  const {fingerprint,files}=await imageContext(root,context);
  const manifestIndex=process.argv.indexOf('--manifest');
  if(manifestIndex!==-1){if(!process.argv[manifestIndex+1])throw Error('--manifest requires a path');await save(resolve(process.argv[manifestIndex+1]),{fingerprint,bases,baseIds,files});}
  console.log(JSON.stringify({fingerprint,files:files.length,bytes:files.reduce((n,f)=>n+f.size,0),bases,baseIds}));
  async function buildOrReuse(){
  const ids=(await docker(['image','ls','--all','-q','--no-trunc','--filter',`label=${SEC1_LABELS.owner}=${SEC1_OWNER}`,'--filter',`label=${SEC1_LABELS.context}=${fingerprint}`,'--filter','label=sec1.complete=true'])).stdout.trim().split(/\s+/).filter(Boolean);
  if(ids.length){
    const current=await docker(['image','inspect',`${SEC1_IMAGE_REPOSITORY}:${tag}`],true);
    const devMoved=current.code!==0||JSON.parse(current.stdout)[0].Id!==ids[0];
    if(devMoved)await docker(['tag',ids[0],`${SEC1_IMAGE_REPOSITORY}:${tag}`]);
    console.log(JSON.stringify({reused:true,imageId:ids[0],fingerprint,devMoved}));return ids[0];
  }
  else {
    // No docker build invocation exists here: neither BuildKit nor the legacy builder is used.
    const runId='t8b-build-'+randomUUID(),containers:{id:string;unit:string}[]=[];
    try{
      for(const [i,unit] of ['node','python'].entries()){
        // Build containers have their own marker; do not bake run/unit identity into an image.
        const args=['create','--pull=never','--network','none','--name',containerName(runId,unit),'--label',`sec1.owner=${SEC1_OWNER}`,'--label',`sec1.builder=${runId}`,'--cap-drop=ALL','--security-opt','no-new-privileges',baseIds[i]];
        console.log(JSON.stringify({command:['docker',...args]}));const result=await docker(args);console.log(result.stdout);containers.push({id:result.stdout.trim(),unit});
      }
      await copyNodeArchive(containers[0].id,containers[1].id);
      const copied=await docker(['cp',context,`${containers[1].id}:/app`]);console.log(JSON.stringify({command:['docker','cp',context,`${containers[1].id}:/app`],...copied}));
      const changes=['WORKDIR /app','ENV PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=/app/vendor/python BFCL_PYTHON=python3','USER 1000:1000',
        `LABEL sec1.owner=${SEC1_OWNER} sec1.context=${fingerprint} sec1.complete=true sec1.build=local-commit sec1.builtAt=${new Date().toISOString()} sec1.base.node.id=${baseIds[0]} sec1.base.node.digest=${bases[0].split('@')[1]} sec1.base.python.id=${baseIds[1]} sec1.base.python.digest=${bases[1].split('@')[1]}`,'ENTRYPOINT []','CMD ["python3", "-B", "scripts/docker-entry.py", "--help"]'];
      // Both build containers are created but never started; default commit pause is a no-op.
      const args=['commit',...changes.flatMap(change=>['--change',change]),containers[1].id,`${SEC1_IMAGE_REPOSITORY}:${tag}`];
      console.log(JSON.stringify({command:['docker',...args]}));const result=await docker(args);console.log(result.stdout,result.stderr);
      if(/pull|auth|registry/i.test(result.stdout+result.stderr))throw Error('Unexpected network-related commit output');
    }finally{for(const container of containers.reverse())await removeExited(container.id);}
    for(const [i,base] of bases.entries())if(JSON.parse((await docker(['image','inspect',base])).stdout)[0].Id!==baseIds[i])throw Error('Base image ID changed; stop');
    const info=JSON.parse((await docker(['image','inspect',`${SEC1_IMAGE_REPOSITORY}:${tag}`])).stdout)[0];
    console.log(JSON.stringify({reused:false,route:'local-create-cp-commit',imageId:info.Id,fingerprint,bases,baseIds}));
    return info.Id as string;
  }
  }
  const first=await buildOrReuse();
  if(process.argv.includes('--verify-reuse')){
    const before=(await docker(['image','ls','--all','--no-trunc','--format','{{.ID}} {{.Repository}} {{.Tag}}'])).stdout.trim().split('\n').sort();
    const second=await buildOrReuse();
    const after=(await docker(['image','ls','--all','--no-trunc','--format','{{.ID}} {{.Repository}} {{.Tag}}'])).stdout.trim().split('\n').sort();
    if(first!==second||JSON.stringify(before)!==JSON.stringify(after))throw Error('Identical frozen context created an image or tag');
    console.log(JSON.stringify({sameFrozenContextReused:true,imageId:first,imageAndTagInventoryUnchanged:true}));
  }
}finally{
  const actual=await realpath(staging);if(!actual.startsWith((await realpath(scratch))+'\\')&&!actual.startsWith((await realpath(scratch))+'/')||!actual.includes('t8b-build-'))throw Error('Unsafe context cleanup');
  await rm(staging,{recursive:true});
}
