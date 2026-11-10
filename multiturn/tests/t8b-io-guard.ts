import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,readFile,cp,rm,readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { docker,labels,inspect,removeExited,save } from '../src/ts/docker/common.ts';
import { containerName } from '../src/ts/docker/launcher.ts';
const parent=join(tmpdir(),'t8b-scratch');await mkdir(parent,{recursive:true});const root=await mkdtemp(join(parent,'io-'));
const imageId=JSON.parse((await docker(['image','inspect','ditto-sec1-bfcl:dev'])).stdout)[0].Id;
const runId='t8b-io-'+process.pid;
const commands:any[]=[];
async function probe(unitId:string,args:string[],network='none'){
  const cmd=['create','--pull=never','--name',containerName(runId,unitId),...labels(runId,unitId),'--network',network,'--init','--cpus=2','--memory=4g','--memory-swap=4g','--pids-limit=128','--cap-drop=ALL','--security-opt','no-new-privileges','--mount',`type=bind,source=${root},target=/output`,...args];
  commands.push(cmd);const id=(await docker(cmd)).stdout.trim();await docker(['start',id]);return {id,unitId};
}
async function collect(unit:{id:string;unitId:string}){await docker(['wait',unit.id]);const info=await inspect(unit.id),logs=await docker(['logs',unit.id]);await save(join(root,unit.unitId+'.process.json'),{info,logs});await removeExited(unit.id,runId,unit.unitId);return {info,logs};}
try{
  for(const n of [1,18]){
    const units=await Promise.all(Array.from({length:n},async(_,i)=>{const id=`write-${n}-${i}`;const source=`import fs from 'node:fs';const id=${JSON.stringify(id)},marker='/output/start-${n}';while(!fs.existsSync(marker))await new Promise(r=>setTimeout(r,20));const start=performance.now();const line=JSON.stringify({payload:'x'.repeat(1000)})+'\\n';for(let j=0;j<1000;j++)fs.appendFileSync('/output/'+id+'.jsonl',line);fs.writeFileSync('/output/'+id+'.tmp','atomic',{flag:'wx'});fs.linkSync('/output/'+id+'.tmp','/output/'+id+'.final');fs.unlinkSync('/output/'+id+'.tmp');if(fs.readFileSync('/output/'+id+'.final','utf8')!=='atomic')throw Error('hardlink');console.log(JSON.stringify({id,writes:1000,bytes:1000*line.length,elapsedMs:performance.now()-start}));`;
      return probe(id,[imageId,'node','--input-type=module','-e',source]);}));
    const start=Date.now();await writeFile(join(root,`start-${n}`),'start');const results=await Promise.all(units.map(collect));assert(results.every(r=>r.info.State.ExitCode===0));
    const times=results.map(r=>JSON.parse(r.logs.stdout));console.log(JSON.stringify({parallelContainers:n,wallMs:Date.now()-start,results:times}));
  }
  await mkdir(join(root,'guards'));
  const rejected=await probe('guard-external',['-e','OFFLINE_GUARD_REPORT_DIR=/output/guards',imageId,'node','--import=/app/scripts/egress-offline-guard.mjs','--input-type=module','-e',`try{await fetch('http://203.0.113.1/')}catch(e){if(!String(e).includes('OFFLINE_GUARD'))throw e;console.log('PASS: external destination rejected before socket');process.exit(0)}throw Error('guard failed')`]);
  const rejectedResult=await collect(rejected);assert.equal(rejectedResult.info.State.ExitCode,0);console.log(rejectedResult.logs.stdout);
  const reports=await readdir(join(root,'guards'));assert.equal(reports.length,1);assert.equal(JSON.parse(await readFile(join(root,'guards',reports[0]),'utf8')).deniedOperations,1);
  const invalid=await probe('relay-invalid',[imageId,'python3','-B','scripts/docker-entry.py','--target','example.invalid:80']);const result=await collect(invalid);assert.equal(result.info.State.ExitCode,2);assert(result.logs.stderr.includes('only the host egress destination'));console.log('PASS: relay refuses other destination before resolving or connecting');
}finally{await save(join(root,'commands.json'),commands);await cp(root,resolve('runs/offline/t8b-20261105/raw',root.split(/[\\/]/).at(-1)!),{recursive:true});await rm(root,{recursive:true});}
