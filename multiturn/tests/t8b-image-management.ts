import assert from 'node:assert/strict';
import { mkdir,mkdtemp,readFile,writeFile,rename,copyFile,rm } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { docker,labels,removeExited } from '../src/ts/docker/common.ts';
import { DockerLauncher } from '../src/ts/docker/launcher.ts';
const workspace=resolve('.'),evidence=resolve('runs/offline/t8b-20261105','image-final-'+process.pid);await mkdir(evidence);
const parent=join(tmpdir(),'t8b-scratch');await mkdir(parent,{recursive:true});const source=await mkdtemp(join(parent,'image-source-'));
const runId='t8b-image-check-'+process.pid;
async function execute(script:string,args:string[],name:string,cwd=workspace){
  const command=[process.execPath,'--experimental-transform-types',resolve(workspace,script),...args];
  const child=spawn(command[0],command.slice(1),{cwd,windowsHide:true,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
  const code=await new Promise<number|null>((yes,no)=>{child.once('error',no);child.once('close',yes);});
  await writeFile(join(evidence,name+'.log'),`COMMAND: ${JSON.stringify(command)}\nCWD: ${cwd}\n${stdout}\n${stderr}\nEXIT CODE: ${code}\n`);console.log(stdout,stderr);assert.equal(code,0);return stdout;
}
const imageA=JSON.parse((await docker(['image','inspect','ditto-sec1-bfcl:dev'])).stdout)[0].Id;
const cid=(await docker(['create','--pull=never','--network','none',...labels(runId,'source'),imageA])).stdout.trim();
try{
  await docker(['cp',`${cid}:/app/.`,source]);await removeExited(cid,runId,'source');
  await mkdir(join(source,'docker'));for(const name of ['Dockerfile','.dockerignore'])await copyFile(join(source,name),join(source,'docker',name));
  const before=(await docker(['image','ls','-aq','--no-trunc'])).stdout.trim().split('\n').sort();
  const reused=await execute('scripts/docker-build.ts',['--verify-reuse'],'01-identical-content',source);assert(reused.includes('"sameFrozenContextReused":true'));
  assert.equal(JSON.parse((await docker(['image','inspect','ditto-sec1-bfcl:dev'])).stdout)[0].Id,imageA);
  assert.deepEqual((await docker(['image','ls','-aq','--no-trunc'])).stdout.trim().split('\n').sort(),before);
  const file=join(source,'docker','Dockerfile'),original=await readFile(file);await writeFile(file,Buffer.concat([original,Buffer.from('\n# Isolated one-file content-change acceptance fixture.\n')]));
  await execute('scripts/docker-build.ts',[],'02-one-file-change',source);const imageB=JSON.parse((await docker(['image','inspect','ditto-sec1-bfcl:dev'])).stdout)[0].Id;assert.notEqual(imageA,imageB);
  await writeFile(file,original);const restored=await execute('scripts/docker-build.ts',['--verify-reuse'],'03-reuse-historical-A',source);assert(restored.includes('"devMoved":true'));assert.equal(JSON.parse((await docker(['image','inspect','ditto-sec1-bfcl:dev'])).stdout)[0].Id,imageA);
  await assert.rejects(new DockerLauncher(imageB,{clockTicks:100,pageBytes:4096}).verifyImage(),/Image tag changed/);
  const fixture=resolve('runs',runId+'-protection-plan.json');await writeFile(fixture,JSON.stringify({runId,imageId:imageB}));
  try{const text=await execute('scripts/docker-gc.ts',[`--run=${runId}`],'04-protected-preview');const rows=text.trim().split('\n').map(l=>JSON.parse(l));assert(!rows.some(r=>r.candidate==='image'&&r.id===imageB));assert(rows.find(r=>Array.isArray(r.protectedPlanImages))?.protectedPlanImages.includes(imageB));}
  finally{await copyFile(fixture,join(evidence,'protection-plan.retired.txt'));await rm(fixture);}
  const cleaned=await execute('scripts/docker-gc.ts',['--apply',`--run=${runId}`],'05-delete-unused-B');assert(cleaned.includes(imageB));assert.notEqual((await docker(['image','inspect',imageB],true)).code,0);
  assert.equal(JSON.parse((await docker(['image','inspect','ditto-sec1-bfcl:dev'])).stdout)[0].Id,imageA);
  const owned=(await docker(['image','ls','--all','-q','--no-trunc','--filter','label=sec1.owner=ditto-sec1-bfcl'])).stdout.trim().split('\n').filter(Boolean);let untagged=0;
  for(const id of new Set(owned)){const info=JSON.parse((await docker(['image','inspect',id])).stdout)[0];if(!info.RepoTags?.length)untagged++;}
  assert.equal(untagged,0);console.log(JSON.stringify({imageA,imageB,sameContentReused:true,oneFileChangesImage:true,historicalAReuseRestoresDev:true,tagMismatchRejected:true,planReferenceProtected:true,unusedBDeleted:true,ownedUntaggedAll:untagged}));
}finally{
  const remaining=await docker(['inspect',cid],true);if(remaining.code===0)await removeExited(cid,runId,'source');
  assert(source.startsWith(parent));await rm(source,{recursive:true});
}
