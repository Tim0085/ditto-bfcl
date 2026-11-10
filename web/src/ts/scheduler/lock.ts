import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {mkdirSync,existsSync,openSync,closeSync,writeFileSync,renameSync,unlinkSync,rmdirSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {read,now} from './io.ts';
// Independent of package, run root and TEMP on Windows; all copies share this lock.
export const schedulerLock='F:/Academic/Ditto/experiments/sec1/_machine/scheduler-lock/scheduler.lock';
function dead(pid:number){if(!Number.isInteger(pid)||pid<=0)throw new Error('Invalid scheduler lock owner; manual inspection required');try{process.kill(pid,0);return false;}catch(e){if((e as NodeJS.ErrnoException).code==='ESRCH')return true;throw e;}}
export function acquireSchedulerLock(root:string,runId:string){
 mkdirSync(join(schedulerLock,'..'),{recursive:true});
 // Serialize stale-owner inspection with acquisition; a crashed inspection fails closed.
 const gate=schedulerLock+'.acquiring';try{mkdirSync(gate);}catch{throw new Error('Scheduler lock acquisition busy; inspect .acquiring if its owner crashed');}
 const token=randomUUID();let archived:string|null=null;
 try{
  const legacy=join(tmpdir(),'t8a-scratch','scheduler.lock');
  if(existsSync(legacy)&&!dead(read(legacy).pid))throw new Error('Another scheduler is active (legacy lock)');
  if(existsSync(schedulerLock)){const old=read(schedulerLock);if(!dead(old.pid))throw new Error('Another scheduler is active');archived=schedulerLock+'.stale-'+randomUUID()+'.json';renameSync(schedulerLock,archived);}
  const fd=openSync(schedulerLock,'wx');try{writeFileSync(fd,JSON.stringify({pid:process.pid,root,runId,token,at:now()}));}finally{closeSync(fd);}
 }finally{rmdirSync(gate);}
 return {archived,release(){if(read(schedulerLock).token!==token)throw new Error('Scheduler lock ownership changed');unlinkSync(schedulerLock);}};
}
