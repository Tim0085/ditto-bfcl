// T9 C2 test child for tests/t9c2-guards.ts. Started as `node tests/t9c2-guard-child.mjs` with no NODE_OPTIONS; it is never
// loaded through NODE_OPTIONS or --import. It loads one guard by dynamic import (T9C2_MODE=live: the live guard, with the argv of
// a real egress; offline: the offline guard from its one entry), tries each way around it once, and writes one JSON result.
// Each check that could start a process starts at most one `node -e` that only writes a marker file; that grandchild gets an
// explicit environment with SEC1_PROBE_DEPTH=1 and nothing that loads this file. At most 3 grandchildren in all.
if (Number(process.env.SEC1_PROBE_DEPTH ?? 0) >= 1) process.exit(0);
process.env.SEC1_PROBE_DEPTH = '1';
setTimeout(() => process.exit(3), 60000).unref();
const fs = (await import('node:fs')).default;
const { join, dirname } = await import('node:path');
const { pathToFileURL } = await import('node:url');
const mode = process.env.T9C2_MODE, dir = process.env.T9C2_DIR, guards = process.env.T9C2_GUARDS, rows = [];
const keyFile = join(dir, 'parent', 'k', 'fake.keys'), sibling = join(dir, 'parent', 'k', 'sibling.txt'), hard = join(dir, 'hardlink.keys');
let grandchildren = 0;
const marker = name => join(dir, 'marker-' + name + '.json');
const markerCode = file => `require('fs').writeFileSync(${JSON.stringify(file)},JSON.stringify({nodeOptions:process.env.NODE_OPTIONS??null}))`;
const cleanPairs = [`PATH=${process.env.PATH}`, `SYSTEMROOT=${process.env.SYSTEMROOT}`, `TEMP=${process.env.TEMP}`, `TMP=${process.env.TMP}`, 'SEC1_PROBE_DEPTH=1'];
const verdict = error => /(LIVE|OFFLINE)_GUARD: forbidden/.test(String(error?.message)) ? 'denied' : 'other-error';
async function attempt(label, action, markerFile) {
  const row = { label };
  try { const value = await action(); row.outcome = 'allowed'; if (value !== undefined) row.value = String(value).slice(0, 120); }
  catch (error) { row.outcome = verdict(error); row.note = String(error?.message).slice(0, 140); }
  if (markerFile) { for (let i = 0; i < 60 && !fs.existsSync(markerFile); i++) await new Promise(y => setTimeout(y, 50)); row.marker = fs.existsSync(markerFile) ? JSON.parse(fs.readFileSync(markerFile, 'utf8')) : null; }
  rows.push(row);
}
function handSpawn(cp, name, extra = {}) {
  if (++grandchildren > 3) throw new Error('test grandchild cap reached');
  const child = new cp.ChildProcess();
  child.spawn({ file: process.execPath, args: [process.execPath, '-e', markerCode(marker(name)), ...(extra.args ?? [])], cwd: process.env.T9C2_COPY,
    envPairs: cleanPairs, stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true });
  return new Promise((y, n) => { child.once('error', n); child.once('exit', code => y('exit ' + code)); });
}
if (mode === 'live') {
  process.argv.length = 0; process.argv.push(process.execPath, join(process.env.T9C2_COPY, 'src/ts/scheduler/egress-shell.ts'), join(dir, 'root'), keyFile);
  await import(pathToFileURL(join(guards, 'egress-live-guard.mjs')).href);
  globalThis[Symbol.for('ditto.egress.liveGuard')].readCredentials({ baseUrlEnv: 'BFCL_BASE_URL', apiKeyEnv: 'BFCL_API_KEY' });
} else {
  process.env.OFFLINE_GUARD_EXTRA_FORBIDDEN = JSON.stringify([join(dir, 'forbidden')]);
  await import(pathToFileURL(join(guards, 'egress-offline-guard.mjs')).href);
}
const cp = (await import('node:child_process')).default, nodeModule = (await import('node:module')).default;
await attempt('new ChildProcess().spawn', () => handSpawn(cp, 'hand'), marker('hand'));
if (mode === 'offline') await attempt('new ChildProcess().spawn with a forbidden path argument', () => handSpawn(cp, 'hand-forbidden', { args: [join(dir, 'forbidden', 'x.js')] }), marker('hand-forbidden'));
await attempt('module.register (loader thread)', async () => {
  nodeModule.register('data:text/javascript,' + encodeURIComponent(`import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(marker('thread'))},JSON.stringify({thread:true}));`));
  await import('data:text/javascript,export default 1');
}, marker('thread'));
await attempt('module.registerHooks (no-op hooks)', () => { nodeModule.registerHooks({ load: (url, context, next) => next(url, context) }); });
if (mode === 'live') {
  await attempt('inspector.open on 127.0.0.1', async () => { const inspector = (await import('node:inspector')).default; inspector.open(0, '127.0.0.1'); const url = inspector.url(); inspector.close(); return url ? 'listened' : 'no url'; });
  await attempt('process._debugProcess (pid that does not exist)', () => process._debugProcess(4194301));
  await attempt('read the key through a hard link made before start', () => fs.readFileSync(hard).length);
  await attempt('rename the parent of the key folder', () => fs.renameSync(join(dir, 'parent'), join(dir, 'parent-moved')));
  await attempt('read the key under the renamed parent', () => fs.readFileSync(join(dir, 'parent-moved', 'k', 'fake.keys')).length);
  await attempt('read the sibling under the renamed parent', () => fs.readFileSync(join(dir, 'parent-moved', 'k', 'sibling.txt')).length);
  await attempt('rename the parent back', () => fs.renameSync(join(dir, 'parent-moved'), join(dir, 'parent')));
  await attempt('readdir of the key folder', () => fs.readdirSync(dirname(keyFile)).length);
  await attempt('globSync in the key folder', () => fs.globSync('*', { cwd: dirname(keyFile) }).length);
}
fs.writeFileSync(process.env.T9C2_OUT, JSON.stringify({ mode, grandchildren, rows }, null, 1));
process.exit(0);
