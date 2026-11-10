import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {control} from './control.ts';
import {read,json,maybe,ROOT,now,log,sleep} from './io.ts';
import type {RunUnitSpec} from '../run-unit.ts';
const spec=read<RunUnitSpec>(resolve(process.argv[2])),startedAt=now();
let stoppedByPlan=false,pending=false;
const channel=await control(spec.logDir,spec.runId+'/'+spec.unitId,()=>{
  stoppedByPlan=true;pending=true;
  if(process.listenerCount('SIGTERM')){pending=false;process.emit('SIGTERM');}
});
// This bridge survives environment narrowing; all state is in module closures.
const ready=setInterval(()=>{if(pending&&process.listenerCount('SIGTERM')){pending=false;process.emit('SIGTERM');}},20);ready.unref();
process.once('exit',exitCode=>{
  json(join(spec.logDir,'exit.json'),{exitCode,signal:null,killed:!!maybe(join(spec.logDir,'kill.json')),stoppedByPlan:stoppedByPlan||!!maybe(join(spec.logDir,'stop.json')),oomKilled:null,startedAt,endedAt:now(),summary:maybe(join(spec.outputRoot,'configs',String(spec.block.configId),'block-summary.json'))??null},true);
});
const target=join(ROOT,'src/ts/config-main.ts');
// A late control handshake after a launcher timeout must never start model work.
// A replacement scheduler can grant the same permit after authenticated adoption.
while(!maybe(join(spec.logDir,'start-permit.json')))await sleep(20);
process.argv=[process.execPath,target,'--block',join(spec.logDir,'block.json')];
log(join(spec.logDir,'shell.jsonl'),{at:now(),kind:'cli-import',pid:process.pid,target});
try{await import(pathToFileURL(target).href);}finally{clearInterval(ready);channel.close();}
