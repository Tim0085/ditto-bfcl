import {resolve,join,relative} from 'node:path';
import {tmpdir} from 'node:os';
import {realpathSync,existsSync,mkdirSync,cpSync,rmSync,readFileSync} from 'node:fs';
import {ROOT,json,files,read,lines} from '../src/ts/scheduler/io.ts';
import {exportRun} from '../src/ts/scheduler/export.ts';
import assert from 'node:assert/strict';
import {fileEqual} from '../src/ts/scheduler/export-stream.ts';
const evidence=join(ROOT,'runs/offline/t8a-20261105'),name=process.argv[2],source=realpathSync(resolve(process.argv[3]));
if(!/^[a-z0-9-]+$/.test(name))throw new Error('Invalid archive label');
const boundary=realpathSync(join(tmpdir(),'t8a-scratch')),rel=relative(boundary,source);if(!rel||rel.startsWith('..')||resolve(boundary,rel)!==source)throw new Error('Source is not an owned scratch subdirectory');
const target=join(evidence,'artifacts',name);if(existsSync(target))throw new Error('Archive already exists');
mkdirSync(join(evidence,'artifacts'),{recursive:true});cpSync(source,target,{recursive:true,errorOnExist:true,force:false});
const before=files(source),after=files(target);assert.equal(before.length,after.length);for(const file of before)assert(fileEqual(file,join(target,relative(source,file))));
// Validate relocated read paths before removing the original scratch directory.
if(existsSync(join(target,'plan.json'))&&existsSync(join(target,'scheduler','stop-report.json'))){const a=exportRun(target,join(target,'export-final-a'));exportRun(target,join(target,'export-final-b'));for(const file of files(join(target,'export-final-a')))assert(fileEqual(file,file.replace('export-final-a','export-final-b')));json(join(target,'archive-verification.json'),{source,archive:target,copiedFiles:before.length,originalBytesPreserved:true,relocatedReadPassed:true,finalExportByteIdentical:true,tasks:a.taskRows.length},true);}
json(join(evidence,name+'-archive.json'),{source,target,copiedFiles:before.length,originalBytesPreserved:true},true);
console.log(JSON.stringify({source,target,copiedFiles:before.length,verifiedRemovalBoundary:boundary}));
console.log('Copy verified. Remove the verified scratch directory in a separate scoped cleanup step.');
