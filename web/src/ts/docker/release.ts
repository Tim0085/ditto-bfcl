import {mkdir,readFile,rmdir,writeFile} from 'node:fs/promises';
import {resolve,join,dirname,relative} from 'node:path';
import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {docker,json,save} from './common.ts';
import {imageContext,testFingerprint,bases} from './image-context.ts';
import {SEC1_OWNER,SEC1_IMAGE_REPOSITORY} from '../run-unit.ts';
export async function readLedger(path:string):Promise<any[]>{
  const value=await json(path);
  if(!Array.isArray(value)||value.some(r=>!r||typeof r.version!=='string'||!/^sha256:[a-f0-9]{64}$/.test(r.imageId)))throw Error('Invalid image ledger; refusing to proceed');
  return value;
}
export async function publishImage(options:{version:string;ledger?:string;tests?:string;logs?:string;sourceTag?:string}){
  const {version}=options,root=resolve('.'),ledger=resolve(options.ledger??'docker/images.json');
  if(!/^(\d+\.\d+\.\d+|exp\d+-v\d+)$/.test(version))throw Error('Formal version must be x.y.z or expN-vN and cannot be dev');
  const sourceTag=options.sourceTag??'dev';
  if(!/^(dev|test-[a-z0-9-]+)$/.test(sourceTag))throw Error('Source must be dev or a test-* image');
  if(sourceTag!=='dev'&&ledger===resolve('docker/images.json'))throw Error('Test images require a separate test ledger');
  const manifest=resolve(options.tests??'docker/publish-tests.json');
  const logs=resolve(options.logs??join('runs/offline','docker-publish-'+Date.now()+'-'+randomUUID()));
  await mkdir(dirname(ledger),{recursive:true});
  const lock=ledger+'.lock';await mkdir(lock);
  try{
    const rows=await readLedger(ledger),target=`${SEC1_IMAGE_REPOSITORY}:${version}`;
    if(rows.some(r=>r.version===version))throw Error('Version already exists in ledger');
    const tagState=await docker(['image','inspect',target],true);
    if(tagState.code===0)throw Error('Version tag already exists');
    if(!/No such (image|object)/i.test(tagState.stderr))throw Error(tagState.stderr);
    const image=JSON.parse((await docker(['image','inspect',`${SEC1_IMAGE_REPOSITORY}:${sourceTag}`])).stdout)[0],labels=image.Config.Labels??{};
    if(labels['sec1.owner']!==SEC1_OWNER||labels['sec1.complete']!=='true')throw Error('Not a complete owned image');
    const before=await imageContext(root);
    if(before.fingerprint!==labels['sec1.context'])throw Error('Image fingerprint differs from current worktree');
    const baseImages=[];
    for(const [i,ref] of bases.entries()){
      const kind=i===0?'node':'python',info=JSON.parse((await docker(['image','inspect',ref])).stdout)[0];
      if(labels[`sec1.base.${kind}.id`]!==info.Id||labels[`sec1.base.${kind}.digest`]!==ref.split('@')[1])throw Error('Missing/mismatched base image identity');
      baseImages.push({kind,id:info.Id,digest:ref.split('@')[1],reference:ref,repoDigests:info.RepoDigests??[]});
    }
    if(typeof labels['sec1.builtAt']!=='string'||!Number.isFinite(Date.parse(labels['sec1.builtAt'])))throw Error('Missing build time');
    const frozenTests=await testFingerprint(root,manifest,before.fingerprint),suite=await json(manifest);
    if(!Array.isArray(suite)||!suite.length)throw Error('No publish tests specified');
    for(const t of suite){
      if(!t||typeof t.name!=='string'||!Array.isArray(t.command)||t.command[0]!=='node'||t.command.some((v:any)=>typeof v!=='string')
        ||typeof t.log!=='string'||!t.log||/^(?:[a-z]:|[\\/])|\.\./i.test(t.log))throw Error('Invalid publish test definition');
      const command=t.command.join(' ');
      if(/egress-guard\.test|\*\.test|\bnpm\b/i.test(command))throw Error('Forbidden publish test (guard/npm/glob)');
    }
    await mkdir(logs,{recursive:true});
    const passed=[];
    const unchanged=async()=>{
      const now=await imageContext(root);
      if(now.fingerprint!==before.fingerprint||await testFingerprint(root,manifest,now.fingerprint)!==frozenTests)throw Error('Worktree changed while running publish tests');
    };
    for(const t of suite){
      await unchanged();
      const path=join(logs,t.log);await mkdir(dirname(path),{recursive:true});
      const command=[process.execPath,'--import','./scripts/egress-offline-guard.mjs',...t.command.slice(1)];
      const child=spawn(command[0],command.slice(1),{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe'],
        env:{...process.env,OFFLINE_GUARD_REPORT_DIR:join(logs,'guards',t.name)}});
      let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
      const code=await new Promise<number|null>((yes,no)=>{child.once('error',no);child.once('close',yes);});
      await writeFile(path,`COMMAND: ${JSON.stringify(command)}\nCWD: ${root}\nFINGERPRINT: ${before.fingerprint}\n${stdout}\n${stderr}\nEXIT_CODE=${code}\n`,{flag:'wx'});
      passed.push({name:t.name,command:t.command,log:relative(root,path).replaceAll('\\','/'),exitCode:code});
      await save(join(logs,'test-results.json'),{fingerprint:before.fingerprint,testFingerprint:frozenTests,tests:passed});
      await unchanged();
      if(code!==0)throw Error(`Publish test failed: ${t.name} (${code})`);
    }
    await unchanged();
    const current=JSON.parse((await docker(['image','inspect',`${SEC1_IMAGE_REPOSITORY}:${sourceTag}`])).stdout)[0];
    if(current.Id!==image.Id)throw Error('Source image tag changed during tests');
    const last=await docker(['image','inspect',target],true);
    if(last.code===0)throw Error('Version tag appeared during tests');
    if(!/No such (image|object)/i.test(last.stderr))throw Error(last.stderr);
    const row={version,tag:target,imageId:image.Id,fingerprint:before.fingerprint,baseImages,
      builtAt:labels['sec1.builtAt'],publishedAt:new Date().toISOString(),testFingerprint:frozenTests,tests:passed};
    await docker(['tag',image.Id,target]);
    try{await save(ledger,[...rows,row]);}catch(error){await docker(['image','rm','--no-prune',target]);throw error;}
    console.log(JSON.stringify({published:row,ledger}));return row;
  }finally{await rmdir(lock);}
}
