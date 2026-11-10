import assert from 'node:assert/strict';
import { mkdir,mkdtemp,readdir,readFile,cp,rm } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { docker } from '../src/ts/docker/common.ts';
import { scoreInContainer } from '../scripts/docker-score.ts';
import { command,python } from './t7-helpers.ts';
import { scoreDifference } from './t8b-score-diff.ts';
import { save } from '../src/ts/docker/common.ts';
const parent=join(tmpdir(),'t8b-scratch');await mkdir(parent,{recursive:true});const root=await mkdtemp(join(parent,'scoring-'));
const source=resolve(process.argv[2]);const imageId=JSON.parse((await docker(['image','inspect','ditto-sec1-bfcl:dev'])).stdout)[0].Id;
let count=0;
try{for(const config of await readdir(join(source,'configs'))){
  const tasks=join(source,'configs',config,'tasks');for(const name of await readdir(tasks)){
    const input=join(tasks,name),host=join(root,config+'-'+name),container=join(root,config+'-container-'+name);
    const result=await command(python,['-B','-X','utf8','src/python/score.py','--input',input,'--output',host],host+'.process.json');assert.equal(result.code,0,JSON.stringify(result));
    await scoreInContainer(imageId,input,container,join(root,'processes'));const diff=scoreDifference(await readFile(host),await readFile(container));await save(host+'.difference.json',diff);count++;
    console.log(JSON.stringify({input,hostExit:0,containerExit:0,diff}));
  }
}assert(count>0);console.log(JSON.stringify({scoredResults:count,imageId,allEqualExceptAcceptedNewlines:true}));
}finally{await cp(root,resolve('runs/offline/t8b-20261105/raw',root.split(/[\\/]/).at(-1)!),{recursive:true});await rm(root,{recursive:true});}
