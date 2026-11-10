import {spawn} from 'node:child_process';
import {join,resolve} from 'node:path';
import {mkdirSync,writeFileSync,existsSync} from 'node:fs';
import assert from 'node:assert/strict';
import {env,lines,sleep,json} from '../src/ts/scheduler/io.ts';
const root=resolve(process.argv[2]);mkdirSync(root,{recursive:true});const output=join(root,'host.jsonl'),stop=join(root,'stop');
const args=['-NoProfile','-NonInteractive','-File','tests/t8c-fix1-host.ps1','-Output',output,'-StopFile',stop,'-ParentPid',String(process.pid)],child=spawn('powershell.exe',args,{windowsHide:true,env:env(join(root,'guards')),stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',b=>stdout+=b);child.stderr.on('data',b=>stderr+=b);const done=new Promise<number|null>((yes,no)=>{child.once('error',no);child.once('close',yes);});
try{const end=Date.now()+30000;while(!existsSync(output)||lines(output).length<5){if(child.exitCode!==null||Date.now()>end)throw Error('Host monitor failed: '+stderr);await sleep(100);}}
finally{writeFileSync(stop,'stop');const code=await done;writeFileSync(join(root,'command.log'),'COMMAND: powershell.exe '+args.join(' ')+'\n'+stdout+'\n'+stderr+'\nEXIT_CODE='+code+'\n');assert.equal(code,0);}
const samples=lines(output);assert(samples.every(r=>Number.isFinite(r.availableMemoryBytes)&&r.availableMemoryBytes>0&&Number.isFinite(r.pagefileInUseBytes)&&r.pagefileInUseBytes>=0));json(join(root,'verification.json'),{status:'PASS',samples:samples.length,first:samples[0],last:samples.at(-1),readOnly:true,noThresholdActions:true});console.log(JSON.stringify({status:'PASS',samples:samples.length,first:samples[0]}));
