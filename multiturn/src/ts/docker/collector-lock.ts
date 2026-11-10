import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, rmdir, appendFile } from 'node:fs/promises';
import { publish } from './common.ts';
import { join } from 'node:path';

const occupied=()=>Object.assign(Error('Another live process is collecting this unit / 另一方正在收集这个单元'),{code:'EEXIST'});
// This short-lived directory serializes *all* lock creation, takeover and release.
// Never reclaim this guard automatically: a crash here requires operator verification.
async function guarded<T>(path:string,work:()=>Promise<T>):Promise<T>{
  const guard=path+'.guard';
  try{await mkdir(guard);}catch(e:any){if(e.code==='EEXIST')throw occupied();throw e;}
  try{return await work();}finally{await rmdir(guard);}
}
async function read(path:string){try{return await readFile(path,'utf8');}catch(e:any){if(e.code==='ENOENT')return undefined;throw e;}}
export async function acquireCollector(logDir:string,containerId:string){
  const path=join(logDir,'collector.lock'),token=randomUUID();
  // Optimistic read can be stale. Only the re-read under the guard authorizes takeover.
  const observed=await read(path);
  await guarded(path,async()=>{
    const current=await read(path);
    if(current!==observed)throw occupied();
    if(current!==undefined){
      const lock=JSON.parse(current);
      if(lock.containerId!==containerId)throw Error('Collector identity mismatch');
      if(!Number.isSafeInteger(lock.pid)||lock.pid<=0)throw Error('Invalid collector PID');
      try{process.kill(lock.pid,0);throw occupied();}catch(e:any){if(e.code!=='ESRCH')throw e;}
      await rm(path);
    }
    await publish(path,JSON.stringify({pid:process.pid,containerId,token}),true);
  });
  const release=async()=>{
    await guarded(path,async()=>{
      const current=await read(path),lock=current===undefined?undefined:JSON.parse(current);
      if(lock?.token===token&&lock.containerId===containerId)await rm(path);
      else await appendFile(join(logDir,'collector-lock-events.jsonl'),JSON.stringify({
        at:new Date().toISOString(),event:'release-token-mismatch',expectedToken:token,
        actualToken:lock?.token??null,containerId,action:'preserved-lock'
      })+'\n');
    });
  };
  return async()=>{
    const deadline=Date.now()+5000;
    for(;;){
      try{return await release();}catch(e:any){
        if(e.code!=='EEXIST')throw e;
        if(Date.now()>=deadline){
          // Collection is complete. A busy/abandoned guard must not turn its result
          // into failure or authorize deletion outside the guard.
          await appendFile(join(logDir,'collector-lock-events.jsonl'),JSON.stringify({
            at:new Date().toISOString(),event:'release-deferred',expectedToken:token,
            containerId,action:'preserved-lock-and-guard',reason:'guard busy for 5 seconds'
          })+'\n');
          return;
        }
        await new Promise(resolve=>setTimeout(resolve,25));
      }
    }
  };
}
