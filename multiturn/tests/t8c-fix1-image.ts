import assert from 'node:assert/strict';
import {join,resolve} from 'node:path';
import {writeFileSync,unlinkSync,existsSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {freezeLauncher} from '../src/ts/scheduler/launcher.ts';
import {imageContext} from '../src/ts/docker/image-context.ts';
import {docker} from '../src/ts/docker/common.ts';
import {json,ROOT} from '../src/ts/scheduler/io.ts';
import {stage} from './t8a-helpers.ts';
const out=resolve(process.argv[2]),marker=join(ROOT,'scripts/docker-t8c-fix1-real-marker.txt'),image=JSON.parse((await docker(['image','inspect','ditto-sec1-bfcl:dev'])).stdout)[0],before=(await imageContext(ROOT)).fingerprint;
assert.equal(image.Config.Labels['sec1.context'],before);assert(!existsSync(marker));let error='';
try{
 writeFileSync(marker,'temporary isolated acceptance input\n',{flag:'wx'});const changed=(await imageContext(ROOT)).fingerprint,s=stage('real-image-mismatch');s.launcher={kind:'docker',tag:'dev',runtime:{clockTicks:100,pageBytes:4096}};
 const old=await import(pathToFileURL(join(ROOT,'before/src/ts/scheduler/launcher.ts')).href);await old.freezeLauncher(structuredClone(s));
 try{await freezeLauncher(s);}catch(e){error=String(e);}assert(error.includes(before)&&error.includes(changed));json(join(out,'verification.json'),{status:'PASS',imageId:image.Id,before,changed,oldAccepted:true,afterRefused:true,error},true);console.log(JSON.stringify({status:'PASS',imageId:image.Id,error}));
}finally{if(existsSync(marker))unlinkSync(marker);assert.equal((await imageContext(ROOT)).fingerprint,before);}
