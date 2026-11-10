import {spawn} from 'node:child_process';
import {join} from 'node:path';
import {openSync,closeSync,writeFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {ROOT,env,json,sleep} from './io.ts';
export async function keepAwake(directory:string){
  if(process.platform!=='win32')return {stop:async()=>{}};
  const token=randomUUID(),stopFile=join(directory,'awake-'+token+'.stop'),stdout=join(directory,'awake-'+token+'.stdout.log'),stderr=join(directory,'awake-'+token+'.stderr.log');
  const out=openSync(stdout,'wx'),err=openSync(stderr,'wx');
  let child;try{child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',join(ROOT,'scripts/docker-awake.ps1'),'-StopFile',stopFile,'-ParentPid',String(process.pid)],{cwd:ROOT,windowsHide:true,env:env(join(directory,'guards','awake')),stdio:['ignore',out,err]});}finally{closeSync(out);closeSync(err);}
  let spawnError:unknown;child.once('error',e=>spawnError=e);
  const done=new Promise<number|null>(r=>child.once('close',r));
  json(join(directory,'awake.json'),{pid:child.pid,parentPid:process.pid,stopFile,stdout,stderr});
  // Readiness is the helper's own API success line, not merely a live PID.
  const {readFileSync}=await import('node:fs');
  const deadline=Date.now()+15000;
  while(!readFileSync(stdout,'utf8').includes('active')){
    if(spawnError||child.exitCode!==null||Date.now()>deadline){writeFileSync(stopFile,'stop');throw Error('Sleep-prevention helper did not start: '+String(spawnError??readFileSync(stderr,'utf8')));}
    await sleep(50);
  }
  return {async stop(){writeFileSync(stopFile,'stop');const result=await Promise.race([done,sleep(5000).then(()=>{throw Error('Sleep-prevention helper failed to release');})]);json(join(directory,'awake-exit-'+token+'.json'),{pid:child.pid,code:result});if(result!==0)throw Error('Sleep-prevention helper exited '+result);}};
}
