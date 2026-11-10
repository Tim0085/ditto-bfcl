import { spawn } from 'node:child_process';
import { mkdtemp,mkdir,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
const parent=join(tmpdir(),'t8b-scratch');await mkdir(parent,{recursive:true});
const root=await mkdtemp(join(parent,'awake-')),stop=join(root,'stop');
async function read(args){console.log('COMMAND:',JSON.stringify(['powercfg',...args]));const p=spawn('powercfg',args,{windowsHide:true});const buffers=[];p.stdout.on('data',b=>buffers.push(b));p.stderr.on('data',b=>buffers.push(b));const code=await new Promise(r=>p.once('close',r));const bytes=Buffer.concat(buffers),utf8=bytes.toString('utf8'),out=utf8.includes('\ufffd')?new TextDecoder('gbk').decode(bytes):utf8;console.log(out,'EXIT CODE:',code);const denied=args[0]==='/requests'&&code===1&&out.includes('管理员');assert(code===0||denied,'Unexpected powercfg failure');return {code,out,denied};}
const before=await read(['/requests']);
await read(['/qh','SCHEME_CURRENT','SUB_BUTTONS','LIDACTION']);
const p=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File','scripts/docker-awake.ps1','-StopFile',stop],{windowsHide:true,stdio:['ignore','pipe','pipe']});
let stdout='',stderr='',during;const ended=new Promise(r=>p.once('close',r));p.stderr.on('data',b=>stderr+=b);
try{
  await new Promise((yes,no)=>{p.stdout.on('data',b=>{stdout+=b;if(stdout.includes('active'))yes();});p.once('error',no);p.once('exit',code=>no(Error(`helper exit ${code}: ${stderr}`)));});
  console.log('HELPER:',stdout);during=await read(['/requests']);
}finally{await writeFile(stop,'stop');assert.equal(await ended,0,stderr);await rm(root,{recursive:true});}
const after=await read(['/requests']);
console.log(JSON.stringify({apiCallSucceeded:true,helperExitCode:0,systemRequestRecordsVisible:[before,during,after].every(r=>r.code===0),powercfgExitCodes:[before.code,during.code,after.code],elevationRequested:false,powerSettingsChanged:false,requirement:'keep laptop lid open for approximately 20 hours'}));
