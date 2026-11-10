import {resolve,join} from 'node:path';
import {read} from '../src/ts/scheduler/io.ts';
import {LocalProcessLauncher} from '../src/ts/scheduler/local-process.ts';
import {runSchedule} from '../src/ts/scheduler/scheduler.ts';
const root=resolve(process.argv[2]),options=read(process.argv[3]);
console.log(JSON.stringify(await runSchedule(root,new LocalProcessLauncher(join(root,'scheduler','units'),options.unitImports??[]),{egressImports:options.egressImports??[],resumeAuthorization:options.authorization})));
