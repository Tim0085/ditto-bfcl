import assert from 'node:assert/strict';
import {constants} from 'node:buffer';
import {join,resolve} from 'node:path';
import {readdirSync,statSync} from 'node:fs';
import {read,json} from '../src/ts/scheduler/io.ts';
import {jsonRows,fileEqual,fileHash} from '../src/ts/scheduler/export-stream.ts';
const root=resolve(process.argv[2]),input=read(join(root,'input-proof.json')),a=join(root,'export-1'),b=join(root,'export-2');
assert.equal(input.tasks,43200);assert(input.stepsPerTask>=input.referenceMedianSteps);assert.equal(input.steps,input.tasks*input.stepsPerTask);
const runs=[1,2].map(n=>{assert.equal(read(join(root,'process-'+n+'.json')).code,0);const m=read(join(root,'export-'+n+'-memory.json'));assert.equal(m.tasks,43200);assert.equal(m.heapLimitMiB,512);assert(m.peakRssBytes<1024**3);return m;});
const meta=read(join(a,'metadata.json')),hashes=[];
for(const name of readdirSync(a).sort()){assert(fileEqual(join(a,name),join(b,name)),name);hashes.push({file:name,bytes:statSync(join(a,name)).size,sha256:fileHash(join(a,name))});}
for(const [name,table] of Object.entries(meta.tables) as [string,any][]){let count=0;if(table.format==='jsonl')for(const row of jsonRows(join(a,table.file),true)){assert(row&&typeof row==='object');count++;}else{count=read(join(a,table.file)).length;}assert.equal(count,table.rows,name);}
assert.equal(meta.tables.steps.rows,input.steps);for(const name of ['steps','host'])assert(meta.tables[name].utf16CodeUnits>constants.MAX_STRING_LENGTH);
for(const name of ['requests','host'])assert(input.inputFileBytes[name]>constants.MAX_STRING_LENGTH);
json(join(root,'verification-final.json'),{status:'PASS',syntheticOnly:true,input,runs,peakRssBytes:Math.max(...runs.map(r=>r.peakRssBytes)),allManifestRowCountsRecounted:true,twoExportsByteIdentical:true,hashes,metadata:meta,initialHarnessCorrection:'The first harness also required the ledger itself to exceed MAX_STRING_LENGTH, although the task requires full-scale step export. Its actual 489372050-byte ledger is streamed. That extra input-size assertion was removed; both export child processes had already completed with exit 0, and this independent pass rechecks their full files and counts.'},true);
console.log(JSON.stringify({status:'PASS',tasks:input.tasks,steps:input.steps,stepsPerTask:input.stepsPerTask,referenceMedianSteps:input.referenceMedianSteps,peakRssBytes:Math.max(...runs.map(r=>r.peakRssBytes)),twoExportsByteIdentical:true,allManifestRowCountsRecounted:true,hashes}));
