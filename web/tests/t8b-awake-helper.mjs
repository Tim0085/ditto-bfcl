import { spawn } from 'node:child_process';
import { mkdtemp,mkdir,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const parent=join(tmpdir(),'t8b-scratch');await mkdir(parent,{recursive:true});const root=await mkdtemp(join(parent,'awake-helper-')),stop=join(root,'stop');
const args=['-NoProfile','-ExecutionPolicy','Bypass','-File','scripts/docker-awake.ps1','-StopFile',stop];console.log('COMMAND:',JSON.stringify(['powershell.exe',...args]));
const child=spawn('powershell.exe',args,{windowsHide:true,stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);const ended=new Promise(r=>child.once('close',r));
try{await new Promise((yes,no)=>{child.stdout.on('data',()=>{if(output.includes('active'))yes();});child.once('error',no);child.once('exit',code=>no(Error(`Early exit ${code}: ${output}`)));});console.log(output);console.log('SetThreadExecutionState returned success; powercfg system-level verification remains separately blocked by elevation.');}
finally{await writeFile(stop,'stop');const code=await ended;console.log('HELPER EXIT CODE:',code);assert.equal(code,0,output);await rm(root,{recursive:true});}
