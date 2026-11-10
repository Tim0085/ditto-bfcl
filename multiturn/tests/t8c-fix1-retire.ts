import assert from 'node:assert/strict';
import {resolve,join} from 'node:path';
import {readFileSync} from 'node:fs';
import {read,json,sleep} from '../src/ts/scheduler/io.ts';
import {launcherFor} from '../src/ts/scheduler/launcher.ts';
import {interruptHungEgress,recoverEgress,inFlight} from '../src/ts/scheduler/egress.ts';
const root=resolve(process.argv[2]);assert(root.replaceAll('\\','/').startsWith('F:/Academic/Ditto/experiments/sec1/_tmp/scratch/t8c-fix1/'));
const plan=read(join(root,'plan.json'));assert.equal(plan.runId,'t8c-hung-flight');const launcher=launcherFor(root,plan),units=[];
for(const id of await launcher.list(plan.runId)){const unit=await launcher.adopt(plan.runId,id);if(unit)units.push(unit);}
assert(units.length>0);assert(inFlight(root)>0);const before=readFileSync(join(root,'egress/ledger.jsonl'));
const interruption=await interruptHungEgress(root,'Authorized offline fixture cleanup: confirmed held synthetic request after an invalid test barrier; interrupt only its owned egress and retain every unknown liability');
for(const unit of units){const end=Date.now()+90000;while(await unit.isAlive()){if(Date.now()>end)throw Error('Own test unit did not notice the disconnected egress; preserve it');await sleep(100);}const exit=await unit.wait();assert.equal(exit.killed,false);}
while(Date.now()-read(join(root,'egress/status.json')).at<=5000)await sleep(100);
const recovery=await recoverEgress(root,'Authorized offline fixture retirement: reconcile only this failed synthetic acceptance root; do not clear unknown fees');assert(readFileSync(join(root,'egress/ledger.jsonl')).subarray(0,before.length).equals(before));assert.equal(recovery.before.reservedMicroUsd+recovery.before.retainedMicroUsd,recovery.after.reservedMicroUsd+recovery.after.retainedMicroUsd);assert.deepEqual(await launcher.list(plan.runId),[]);
json(join(root,'retirement.json'),{status:'INVALID_FIXTURE_RETIRED',notAcceptancePass:true,interruption,recovery,unitKills:0,unknownLiabilitiesPreserved:true,ownerContainersForRun:0});console.log(JSON.stringify({status:'INVALID_FIXTURE_RETIRED',unitKills:0,unknownLiabilitiesPreserved:true,ownerContainersForRun:0}));
