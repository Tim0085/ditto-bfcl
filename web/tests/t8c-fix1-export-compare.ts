import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {readFileSync,readdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {read,json,ROOT} from '../src/ts/scheduler/io.ts';
import {exportRun} from '../src/ts/scheduler/export.ts';
import {exportRows,fileEqual,fileHash} from '../src/ts/scheduler/export-stream.ts';
const root=resolve(process.argv[2]),out=resolve(process.argv[3]);
const source=readFileSync(join(ROOT,'runs/offline/t8c-fix1-20261106/pre-supplement/export.ts'),'utf8');
const beforeURL=pathToFileURL(join(ROOT,'src/ts/scheduler/export.ts')).href+'?pre-stream';
const hook=registerHooks({load(url,context,next){return url===beforeURL?{format:'module-typescript',source,shortCircuit:true}:next(url,context);}});
const before=(await import(beforeURL)).exportRun(root,join(out,'before'));hook.deregister();
const after=exportRun(root,join(out,'after'));exportRun(root,join(out,'after-2'));
assert.deepEqual(after,before);assert.equal(after.taskRows.length,144);
const compared=[];
for(const file of readdirSync(join(out,'before')).filter(n=>n!== 'metadata.json')){
 const name=file.slice(0,-5),oldPath=join(out,'before',file),oldRows=read(oldPath);
 if(['summary','tasks','blocks'].includes(name))assert(fileEqual(oldPath,join(out,'after',file)),name+' small-table bytes');
 else {let i=0;for(const row of exportRows(join(out,'after'),name))assert.deepEqual(row,oldRows[i++],name+'/'+i);assert.equal(i,oldRows.length);}
 compared.push({table:name,rows:oldRows.length,allFieldsEqual:true,format:['summary','tasks','blocks'].includes(name)?'json-array unchanged':'json-array -> jsonl'});
}
const meta=read(join(out,'after','metadata.json'));for(const key of ['tableSchemaVersion','tables','tableReading'])delete meta[key];assert.deepEqual(meta,read(join(out,'before','metadata.json')));
const hashes=[];for(const name of readdirSync(join(out,'after'))){assert(fileEqual(join(out,'after',name),join(out,'after-2',name)));hashes.push({file:name,sha256:fileHash(join(out,'after',name))});}
const proof={status:'PASS',root,tasks:144,preStreamingSourceSha256:fileHash(join(ROOT,'runs/offline/t8c-fix1-20261106/pre-supplement/export.ts')),compared,metadataAllOriginalFieldsEqual:true,twoNewExportsByteEqual:true,hashes};json(join(out,'verification.json'),proof,true);console.log(JSON.stringify(proof));
