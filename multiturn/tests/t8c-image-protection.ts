import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {resolve,join} from 'node:path';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {docker} from '../src/ts/docker/common.ts';
const workspace=resolve('.'),evidence=resolve(process.argv[2]),actualPlan=resolve(process.argv[3]);mkdirSync(evidence,{recursive:true});
const retainedRelease=process.argv.includes('--retained-release');
const bytes=readFileSync(actualPlan),plan=JSON.parse(bytes.toString()),imageA=plan.stage.launcher.imageId;
const imageB=JSON.parse((await docker(['image','inspect','ditto-sec1-bfcl:dev'])).stdout)[0].Id;
assert.notEqual(imageA,imageB,'A real rebuild must already have moved dev away from the actual experiment plan image');
const old=JSON.parse((await docker(['image','inspect',imageA])).stdout)[0];assert.equal(old.Config.Labels['sec1.owner'],'ditto-sec1-bfcl');
if(retainedRelease){assert(old.RepoTags.includes('ditto-sec1-bfcl:exp1-v1'),'The task requires the first release tag to be retained');assert(readFileSync('docker/images.json','utf8').includes(imageA));}
else assert.equal(old.RepoTags.length,0,'The actual old plan image must genuinely be untagged');
async function execute(script:string,args:string[],name:string){
  const command=['--experimental-transform-types',script,...args],child=spawn(process.execPath,command,{cwd:workspace,windowsHide:true,stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);
  const code=await new Promise<number|null>((yes,no)=>{child.once('error',no);child.once('close',yes);});writeFileSync(join(evidence,name+'.json'),JSON.stringify({command:['node',...command],cwd:workspace,code,stdout,stderr},null,2));assert.equal(code,0,stdout+stderr);return stdout;
}
const preview=await execute('scripts/docker-gc.ts',['--image='+imageA],'protected-preview'),applied=await execute('scripts/docker-gc.ts',['--image='+imageA,'--apply'],'protected-apply');
for(const output of [preview,applied]){const rows=output.split('\n').filter(s=>s.startsWith('{')).map(s=>JSON.parse(s));assert(rows.some(r=>r.protectedPlanImages?.includes(imageA)));assert(!rows.some(r=>r.candidate==='image'&&r.id===imageA));}
assert.equal((await docker(['image','inspect',imageA],true)).code,0);assert(readFileSync(actualPlan).equals(bytes));assert.equal(JSON.parse((await docker(['image','inspect','ditto-sec1-bfcl:dev'])).stdout)[0].Id,imageB);
writeFileSync(join(evidence,'verification.json'),JSON.stringify({status:'PASS',actualPlan,planHash:plan.hash,sourceSha256:createHash('sha256').update(bytes).digest('hex'),actualPlanBytesUnchanged:true,imageA,imageB,devMovedByRealSourceRebuild:true,oldUntaggedImageProtected:!retainedRelease,retainedFirstReleaseProtected:retainedRelease,previewAndApplyPreservedOldImage:true,currentDevUnchanged:true},null,2));
console.log(JSON.stringify({realPlanProtection:'PASS',planHash:plan.hash,imageA,imageB}));
