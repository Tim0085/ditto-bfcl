import assert from 'node:assert/strict';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {ROOT,files,read} from '../src/ts/scheduler/io.ts';
import {freeze} from '../src/ts/scheduler/plan.ts';
import {runSchedule} from '../src/ts/scheduler/scheduler.ts';
import {LocalProcessLauncher} from '../src/ts/scheduler/local-process.ts';
import {stage} from './t8a-helpers.ts';
const hook=pathToFileURL(join(ROOT,'tests/t8-fix3-window-hook.mjs')).href;
await import(hook);
for(let i=0;i<3;i++){
 const root=join(resolve(process.argv[2]),String(i));freeze(stage('window-'+i),root);
 const report=await runSchedule(root,new LocalProcessLauncher(join(root,'scheduler','units'),[hook]));
 assert.equal(report.status,'complete');const all=files(root);
 for(const name of ['start-permit.json','exit.json','collected.json']){const records=all.filter(p=>p.endsWith(name));assert(records.length);for(const p of records)assert(read(p));}
 console.log(JSON.stringify({iteration:i,report,collected:all.filter(p=>p.endsWith('collected.json')),delayMs:500,status:'PASS'}));
}
