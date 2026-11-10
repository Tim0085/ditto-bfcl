import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,mkdtempSync,copyFileSync,writeFileSync,readFileSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';

test('guard repeated same URL or different-path copy initializes once and records one duplicate',()=>{
  const root=mkdtempSync(join(tmpdir(),'ditto-t5-tests-guard-'));
  const entry=pathToFileURL(resolve('scripts/egress-offline-guard.mjs')).href;
  const copy=join(root,'copy');mkdirSync(copy);
  // 第二份只复制入口；它应直接复用进程状态，连runtime副本都不需要打开。
  copyFileSync('scripts/egress-offline-guard.mjs',join(copy,'egress-offline-guard.mjs'));
  const blocked=join(root,'blocked');mkdirSync(blocked);writeFileSync(join(blocked,'sentinel.txt'),'harmless');
  const scenarios=[['single',undefined],['same-url',entry],['copy',pathToFileURL(join(copy,'egress-offline-guard.mjs')).href],['same-file-query',entry+'?repeat=1']] as const;
  for(const [name,extra]of scenarios){
    const reports=join(root,'reports-'+name);mkdirSync(reports);
    const child=spawnSync(process.execPath,['scripts/offline-guard-duplicate-probe.mjs',root,...(extra?[extra]:[])],{windowsHide:true,encoding:'utf8',
      env:{...process.env,NODE_OPTIONS:`--import=${entry}`,OFFLINE_GUARD_REPORT_DIR:reports,OFFLINE_GUARD_EXTRA_FORBIDDEN:JSON.stringify([blocked])}});
    assert.equal(child.status,0,child.stderr);const files=readdirSync(reports);assert.equal(files.length,1);
    const report=JSON.parse(readFileSync(join(reports,files[0]),'utf8'));
    assert.equal(report.initializations,1);assert.equal(report.duplicateLoads,extra?1:0);assert.equal(report.deniedOperations,1);
    console.log(JSON.stringify({scenario:name,initializations:report.initializations,duplicateLoads:report.duplicateLoads,reports:files.length,...JSON.parse(child.stdout.trim())}));
  }
});
