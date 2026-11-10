// Offline prerequisite probe, not a scheduler implementation or acceptance test.
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync, writeFileSync, readdirSync, lstatSync, readlinkSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const self = fileURLToPath(import.meta.url);
const guard = new URL('./egress-offline-guard.mjs', import.meta.url).href;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function snapshot(root, output) {
  root = resolve(root);
  const rows = [], excluded = [];
  function walk(directory, relative = '') {
    for (const name of readdirSync(directory).sort()) {
      const rel = relative ? `${relative}/${name}` : name;
      // Do not stat/read forbidden entries and never traverse a directory link.
      if (name.toLowerCase() === 'private' || name.toLowerCase().startsWith('.env')) {
        excluded.push(rel); continue;
      }
      const path = join(directory, name), st = lstatSync(path, {bigint:true});
      if (st.isSymbolicLink()) rows.push({path:rel, link:readlinkSync(path), mtimeNs:String(st.mtimeNs)});
      else if (st.isDirectory()) walk(path, rel);
      else if (st.isFile()) rows.push({path:rel, size:String(st.size), mtimeNs:String(st.mtimeNs), sha256:hash(readFileSync(path))});
      else throw new Error(`Unsupported filesystem entry: ${rel}`);
    }
  }
  walk(root);
  mkdirSync(dirname(resolve(output)), {recursive:true});
  const data = JSON.stringify({root, excluded, rows}, null, 2) + '\n';
  writeFileSync(output, data, {flag:'wx'});
  console.log(JSON.stringify({root, entries:rows.length, excluded:excluded.length, sha256:hash(data), output}));
}

async function probe(kind) {
  // Deliberately no model, tasks, Worker, Python, or network; terminate this child only.
  const child = fork(self, ['child'], {
    cwd:resolve(dirname(self), '..'),
    execArgv:['--import', guard],
    env:{PATH:process.env.PATH, SYSTEMROOT:process.env.SYSTEMROOT,TEMP:process.env.TEMP,TMP:process.env.TMP,
      OFFLINE_GUARD_REPORT_DIR:process.env.OFFLINE_GUARD_REPORT_DIR},
    stdio:['ignore','pipe','pipe','ipc'],
  });
  const messages = []; let stdout = '', stderr = '';
  child.stdout.on('data', data => {stdout += data;});
  child.stderr.on('data', data => {stderr += data;});
  child.on('message', message => messages.push(message));
  const closed = once(child, 'close');
  const watchdog = setTimeout(() => {if(child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');}, 10000);
  try {
    const [ready] = await Promise.race([once(child, 'message'), closed.then(() => {throw new Error(`Child exited before ready: ${stderr}`);})]);
    if (ready !== 'ready') throw new Error('Invalid child handshake');
    if (kind === 'external-SIGTERM') child.kill('SIGTERM');
    else child.send('cooperative-stop-proposal');
    const [exitCode, signal] = await closed;
    return {kind, pid:child.pid, exitCode, signal, messages, stdout, stderr,
      handlerRan:stdout.includes('handler-ran'), cleanupRan:stdout.includes('cleanup-complete')};
  } finally {
    clearTimeout(watchdog);
    if(child.exitCode === null && child.signalCode === null) {child.kill('SIGKILL'); await closed;}
  }
}

const [command, ...args] = process.argv.slice(2);
if (command === 'child') {
  let stopping = false;
  process.on('SIGTERM', () => {
    if (stopping) return;
    stopping = true;
    console.log('handler-ran');
    setTimeout(() => {console.log('cleanup-complete'); process.exit(0);}, 150);
  });
  // Only demonstrates the proposed change in transport, not production behavior.
  process.on('message', message => {if(message === 'cooperative-stop-proposal') process.emit('SIGTERM');});
  process.send('ready');
} else if(command === 'snapshot') {
  if(args.length !== 2) throw new Error('snapshot <read-only-root> <new-output-file>');
  snapshot(...args);
} else if(command === 'compare') {
  if(args.length !== 2) throw new Error('compare <before.json> <after.json>');
  const a = readFileSync(args[0]), b = readFileSync(args[1]);
  const identical = a.equals(b);
  console.log(JSON.stringify({identical, beforeSha256:hash(a), afterSha256:hash(b)}));
  if(!identical) process.exitCode = 1;
} else if(command === 'probe') {
  console.log(JSON.stringify({platform:process.platform, node:process.version,
    observations:[await probe('external-SIGTERM'), await probe('cooperative-stop-proposal')],
    scope:'Platform probe only. IPC alternative is not implemented in the scheduler or accepted as SIGTERM delivery.'}, null, 2));
} else {
  throw new Error('Usage: t8a-platform-probe.mjs snapshot|compare|probe');
}
