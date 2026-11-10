import { spawn } from 'node:child_process';
import { mkdtemp,mkdir,cp,rm } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
const parent=join(tmpdir(),'t8b-scratch');await mkdir(parent,{recursive:true});const root=await mkdtemp(join(parent,'resource-regression-'));
const args=['--experimental-transform-types','--test','--test-name-pattern=T7 fake cgroup|T7 fix M2','tests/t7-deploy.test.ts','tests/t7-fix.test.ts'];console.log('COMMAND:',JSON.stringify([process.execPath,...args]));
try{const child=spawn(process.execPath,args,{windowsHide:true,env:{...process.env,TEMP:process.env.TEMP,TMP:process.env.TMP},stdio:['ignore','pipe','pipe']});child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);const code=await new Promise((yes,no)=>{child.once('error',no);child.once('close',yes);});assert.equal(code,0);}
finally{await cp(root,resolve('runs/offline/t8b-20261105/raw',root.split(/[\\/]/).at(-1)),{recursive:true});await rm(root,{recursive:true});}
