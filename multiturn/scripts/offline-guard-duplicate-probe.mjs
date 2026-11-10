// 只供egress-guard.test.ts启动；首份guard由NODE_OPTIONS加载，后续只导入指定副本。
import fs from 'node:fs';
import net from 'node:net';
import cp from 'node:child_process';
import assert from 'node:assert/strict';
import {join} from 'node:path';
const [root,extra]=process.argv.slice(2);
const references=[fs.readFileSync,fs.openSync,net.connect,cp.spawn];
const listeners=process.listenerCount('exit');
if(extra)await import(extra);
assert.deepEqual([fs.readFileSync,fs.openSync,net.connect,cp.spawn],references);
assert.equal(process.listenerCount('exit'),listeners);
const file=join(root,'allowed.txt');fs.writeFileSync(file,'sentinel');
assert.equal(fs.readFileSync(file,'utf8'),'sentinel');
assert.throws(()=>fs.readFileSync(join(root,'blocked','sentinel.txt')),/OFFLINE_GUARD/);
console.log(JSON.stringify({sameFunctionReferences:true,sameExitListeners:true,normalReadWrite:true,sentinelDenied:true}));
