import test from 'node:test';
import assert from 'node:assert/strict';
import { DockerLauncher,containerName,egressPort } from '../src/ts/docker/launcher.ts';
import { safePath } from '../src/ts/docker/common.ts';
import { auxiliarySample } from '../src/ts/docker/sampling.ts';
import { scoreDifference } from './t8b-score-diff.ts';
test('score comparison allows only documented line endings and rejects content changes',()=>{
  const diff=scoreDifference(Buffer.from('{\r\n  "x": 1\r\n}\r\n'),Buffer.from('{\n  "x": 1\n}'));
  assert.equal(diff.differenceCount,3);assert.equal(diff.rawBytesEqual,false);
  assert.throws(()=>scoreDifference(Buffer.from('{"x":1}\r\n'),Buffer.from('{"x":2}\n')));
  assert.throws(()=>scoreDifference(Buffer.from('{"x":1} \r\n'),Buffer.from('{"x":1}\n')));
});
test('ambiguous run/unit concatenation never collides',()=>assert.notEqual(containerName('a-b','c'),containerName('a','b-c')));
test('auxiliary measurement and logging failures do not reject lifecycle',async()=>{const errors:unknown[]=[];await auxiliarySample(async()=>{throw Error('stats failed');},async e=>{errors.push(e);});assert.equal(errors.length,1);await auxiliarySample(async()=>{throw Error('stats failed');},async()=>{throw Error('disk failed');});});
test('fixed egress rejects credentials, nonloopback, other paths and schemes',()=>{
  for(const url of ['https://127.0.0.1:123','http://evil:123','http://host.docker.internal:123','http://a:b@127.0.0.1:123','http://127.0.0.1:123/evil','http://127.0.0.1:123/?x=1'])assert.throws(()=>egressPort(url));
  assert.equal(egressPort('http://127.0.0.1:123/v1/sample'),123);
});
test('names are deterministic unique bounded and validated',()=>{const a=containerName('x'.repeat(150),'a'),b=containerName('x'.repeat(150),'b');assert(a.length<=120);assert.notEqual(a,b);assert.equal(a,containerName('x'.repeat(150),'a'));assert.throws(()=>containerName('x/y','z'));});
test('view maps only container fields and does not mutate spec',()=>{
  const launcher=new DockerLauncher('sha256:'+'a'.repeat(64),{clockTicks:123,pageBytes:8192});
  const spec={runId:'r',unitId:'u',block:{runId:'r',configId:'c',sampling:{enabled:true,strict:true},python:'host',outputRoot:'host',modelEndpoint:'host'},outputRoot:'host',logDir:'host',guardReportDir:'host',egressUrl:'http://127.0.0.1:123/v1/sample'};
  const original=structuredClone(spec);const view=launcher.toUnitView(spec);assert.deepEqual(spec,original);assert.equal(view.modelEndpoint,'http://127.0.0.1:18080/v1/sample');assert.equal(view.sampling.clockTicks,123);assert.equal(view.sampling.pageBytes,8192);
});
test('mount paths exclude private and env and ambiguous mount separators',()=>{for(const p of ['relative','C:/private/foo','C:/.env.test','C:/tmp/a,b'])assert.throws(()=>safePath(p));});
