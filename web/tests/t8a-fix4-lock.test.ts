import test from 'node:test';
import assert from 'node:assert/strict';
import {dirname,join} from 'node:path';
import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {acquireSchedulerLock,schedulerLock} from '../src/ts/scheduler/lock.ts';
import {scratch} from './t8a-helpers.ts';
test('F machine lock: fixed path, live refusal, dead owner archive, token protection',()=>{
 assert.equal(schedulerLock,process.env.SEC1_TEST_SCHEDULER_LOCK??'F:/Academic/Ditto/experiments/sec1/_machine/scheduler-lock/scheduler.lock');
 assert(!existsSync(schedulerLock),'Do not overwrite an existing machine lock');
 const root=scratch(),one=acquireSchedulerLock(root,'one');
 try{assert.throws(()=>acquireSchedulerLock(join(root,'another-copy'),'two'),/Another scheduler is active/);const own=JSON.parse(readFileSync(schedulerLock,'utf8'));writeFileSync(schedulerLock,JSON.stringify({...own,token:'different'}));assert.throws(()=>one.release(),/ownership changed/);assert(existsSync(schedulerLock));writeFileSync(schedulerLock,JSON.stringify(own));}finally{one.release();}
 writeFileSync(schedulerLock,JSON.stringify({pid:2147483647,token:'dead'}));
 const two=acquireSchedulerLock(root,'recovery');try{assert(two.archived);assert.equal(dirname(two.archived!),dirname(schedulerLock));assert.equal(JSON.parse(readFileSync(two.archived!,'utf8')).token,'dead');console.log(JSON.stringify({lock:schedulerLock,archived:two.archived,liveRejected:true,tokenProtected:true}));}finally{two.release();}
});
