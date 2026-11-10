// T9 段 B：真实模式保护器，只给调度程序在真实计划下起的 egress-shell.ts 用（放行条件见 egress-live-launch.mjs）。
// 和离线保护器一样是进程内保护，不代替权限隔离。它管三件事：
//  - 网络：只许连密钥文件里那个 HTTPS 地址的主机和端口；只许在 127.0.0.1 上监听。（T9 C2：Socket.connect 按 Node 的规整办法
//    只读一次选项再查；dgram 套接字不能 bind/connect/send；inspector 不能 open。）
//  - 文件：照旧拒绝 private、.env*、额外禁区；密钥文件只由 readCredentials 读一次，别的读法一律拒绝。（T9 C2：密钥所在的整个
//    目录都是禁区，列目录和 glob 也拒；另按启动时记下的卷号＋文件号认密钥文件和它的目录，硬链接、\\localhost\X$、改上层目录名都挡住。T9 C3：逐级比对上层目录，密钥目录下任何一层子目录里的文件也挡住。）
//  - 子进程：一律拒绝。（T9 C2：手工构造的 ChildProcess 也拒；保护器装好后 module.register、module.registerHooks 都拒。）
// 密钥只从 readCredentials 的返回值交给出口，不写环境变量，不进报告。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import net from 'node:net';
import dns from 'node:dns';
import dgram from 'node:dgram';
import childProcess from 'node:child_process';
import workerThreads from 'node:worker_threads';
import inspector from 'node:inspector';
import inspectorPromises from 'node:inspector/promises';
import nodeModule, { registerHooks, syncBuiltinESMExports } from 'node:module';
import { parseEnv } from 'node:util';
import { resolve, dirname, basename, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const stateKey = Symbol.for('ditto.egress.liveGuard');
if (globalThis[Symbol.for('ditto.egress.offlineGuard')] || globalThis[stateKey]) throw new Error('LIVE_GUARD: another guard is already loaded');
if (process.env.NODE_TLS_REJECT_UNAUTHORIZED !== undefined) throw new Error('LIVE_GUARD: certificate checks may not be changed');
const lower = value => process.platform === 'win32' ? value.toLowerCase() : value;
const normalize = value => lower(value.replaceAll('\\', '/').replace(/^\/\/\?\//, '')).replace(/\/$/, '');
const entry = join(dirname(fileURLToPath(import.meta.url)), '..', 'src/ts/scheduler/egress-shell.ts');
const [, script, runRoot, keyFile, ...extraArguments] = process.argv;
if (!script || normalize(resolve(script)) !== normalize(entry) || !runRoot || !keyFile || !isAbsolute(keyFile) || extraArguments.length)
  throw new Error('LIVE_GUARD: only egress-shell.ts <root> <key file> may load this guard');

const nativeRealpath = fs.realpathSync.native, nativeReaddir = fs.readdirSync, nativeStat = fs.statSync;
const readKeyFile = fs.readFileSync, saveReport = fs.writeFileSync, makeDirectory = fs.mkdirSync;
const report = { offlineGuard: false, liveGuard: true, version: 1, pid: process.pid, ppid: process.ppid, instance: randomUUID(),
  launchId: process.env.OFFLINE_GUARD_LAUNCH_ID ?? null, checks: {}, denied: {}, children: [], keyFileReads: 0, pinned: false };
const increment = (group, kind) => { group[kind] = (group[kind] ?? 0) + 1; };
function reject(kind) { increment(report.denied, kind); throw new Error(`LIVE_GUARD: forbidden ${kind}`); }
function pathString(value) {
  if (value instanceof URL) return fileURLToPath(value);
  if (Buffer.isBuffer(value)) return value.toString();
  return typeof value === 'string' ? value : undefined;
}
const transientDelay = new Int32Array(new SharedArrayBuffer(4));
function resolveRealpath(current) {
  for (let attempt = 0; ; attempt++) {
    try { return nativeRealpath(current); }
    catch (error) {
      if (process.platform !== 'win32' || !['EBADF', 'EPERM', 'EBUSY'].includes(error.code) || attempt >= 5) throw error;
      Atomics.wait(transientDelay, 0, 0, 10 * (attempt + 1));
    }
  }
}
function realTarget(value, cwd = process.cwd()) {
  let current = resolve(cwd, value), rest = [];
  for (;;) {
    try { return join(resolveRealpath(current), ...rest); }
    catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
      const parent = dirname(current);
      if (parent === current) return join(current, ...rest);
      rest.unshift(basename(current)); current = parent;
    }
  }
}
// T9 C2: the key file's whole directory is a forbidden root (readCredentials still reads the file once, with the raw function).
const keyDirectory = dirname(resolve(keyFile));
const forbiddenRoots = [String.raw`F:\Academic\Ditto\experiments\private`, keyDirectory,
  ...(process.env.OFFLINE_GUARD_EXTRA_FORBIDDEN ? JSON.parse(process.env.OFFLINE_GUARD_EXTRA_FORBIDDEN) : [])]
  .map(value => normalize(realTarget(value)));
// T9 C2: the key file and its directory are also known by identity (volume serial + file id, raw bigint stat taken at start).
// A path is refused when it is either of them, or anything inside that directory, however it is spelled:
// a hard link, a \\localhost\X$ admin-share path, a junction, or a parent renamed after start.
// T9 C3: "inside" means at any depth: every directory above the path is stat'ed, one level at a time up to the root, and
// any of them with the key directory's identity refuses the path (before, only the direct parent was compared, so files in
// a subdirectory of the key directory were readable through \\localhost\X$ or a renamed parent).
function rawIdentity(path) {
  for (let attempt = 0; ; attempt++) {
    try { const s = nativeStat(path, { bigint: true }); return s.ino === 0n ? null : `${s.dev}:${s.ino}`; }
    catch (error) {
      if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null;
      if (process.platform !== 'win32' || !['EBADF', 'EPERM', 'EBUSY'].includes(error.code) || attempt >= 5) throw error;
      Atomics.wait(transientDelay, 0, 0, 10 * (attempt + 1));
    }
  }
}
const keyIdentity = rawIdentity(resolve(keyFile)), keyDirectoryIdentity = rawIdentity(keyDirectory);
function isKeyByIdentity(real) {
  if (keyIdentity === null && keyDirectoryIdentity === null) return false;
  const own = rawIdentity(real);
  if (own !== null && (own === keyIdentity || own === keyDirectoryIdentity)) return true;
  if (keyDirectoryIdentity === null) return false;
  for (let current = real, parent = dirname(real); parent !== current; current = parent, parent = dirname(parent))
    if (rawIdentity(parent) === keyDirectoryIdentity) return true;
  return false;
}
const forbiddenParts = value => normalize(value).split('/').some(part => part === 'private' || part.toLowerCase() === 'private' || part.toLowerCase().startsWith('.env'));
function checkPath(value, kind = 'file', cwd) {
  const text = pathString(value);
  if (text === undefined) return;
  increment(report.checks, kind);
  if (forbiddenParts(text)) reject(kind);
  const absolute = resolve(cwd ?? process.cwd(), text);
  if (forbiddenParts(absolute)) reject(kind);
  const real = realTarget(text, cwd), target = normalize(real);
  if (forbiddenParts(target) || forbiddenRoots.some(root => target === root || target.startsWith(root + '/'))) reject(kind);
  if (isKeyByIdentity(real)) reject(kind);
}
function checkRecursiveDirectory(value, kind, seen = new Set()) {
  checkPath(value, kind);
  const path = pathString(value), real = normalize(realTarget(path));
  if (seen.has(real)) return;
  seen.add(real);
  for (const item of nativeReaddir(path, { withFileTypes: true })) {
    const child = join(path, item.name);
    checkPath(child, kind);
    let directory = item.isDirectory();
    if (item.isSymbolicLink()) {
      try { directory = nativeStat(child).isDirectory(); }
      catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
    }
    if (directory) checkRecursiveDirectory(child, kind, seen);
  }
}
const single = ['readFile','open','openAsBlob','createReadStream','createWriteStream','opendir','readdir',
  'stat','lstat','access','exists','statfs','readlink','realpath','watch','watchFile',
  'writeFile','appendFile','mkdir','mkdtemp','rm','rmdir','unlink','truncate','chmod','chown','lchmod','lchown','utimes','lutimes'];
for (const [label, target] of [['fs', fs], ['fsp', fsp]]) {
  for (const base of [...single, 'copyFile','cp','link','symlink','rename']) for (const name of [base, base + 'Sync']) {
    if (typeof target[name] !== 'function') continue;
    const original = target[name];
    const wrapped = function(...args) {
      const kind = `${label}.${name}`;
      if (base === 'symlink') {
        checkPath(args[1], kind);
        checkPath(args[0], kind, args[2] === 'junction' ? process.cwd() : dirname(resolve(pathString(args[1]))));
      } else {
        checkPath(args[0], kind);
        if (['copyFile','cp','link','rename'].includes(base)) checkPath(args[1], kind);
      }
      if (['readdir','opendir'].includes(base) && args[1]?.recursive) checkRecursiveDirectory(args[0], kind);
      if (base === 'cp') {
        const options = typeof args[2] === 'object' && args[2] !== null ? args[2] : {};
        const filter = options.filter;
        const checkedFilter = (src, dest) => { checkPath(src, kind); checkPath(dest, kind); return filter ? filter(src, dest) : true; };
        if (typeof args[2] === 'function') args.splice(2, 0, { filter: checkedFilter });
        else args[2] = { ...options, filter: checkedFilter };
      }
      return Reflect.apply(original, this, args);
    };
    if (original.native) wrapped.native = function(path, ...args) { checkPath(path, `${label}.${name}.native`); return original.native.call(this, path, ...args); };
    target[name] = wrapped;
  }
  // T9 C2: a glob lists directories by pattern; the egress never needs one.
  for (const name of ['glob', 'globSync']) if (typeof target[name] === 'function') target[name] = function() { reject(`${label}.${name}`); };
}
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('file:')) checkPath(new URL(specifier), 'module.resolve');
    else if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) checkPath(new URL(specifier, context.parentURL), 'module.resolve');
    else if (isAbsolute(specifier)) checkPath(specifier, 'module.resolve');
    const result = next(specifier, context);
    if (result.url.startsWith('file:')) checkPath(new URL(result.url), 'module.resolve');
    return result;
  },
  load(url, context, next) { if (url.startsWith('file:')) checkPath(new URL(url), 'module.load'); return next(url, context); }
});
// T9 C2: with the guard's hooks in place, no more hooks: module.register would start a loader thread without this guard,
// and further registerHooks could rewrite modules after these checks.
nodeModule.register = function() { reject('module.register'); };
nodeModule.registerHooks = function() { reject('module.registerHooks'); };

// 网络。pin 只能由 readCredentials 从密钥文件里设一次，设之前什么都连不了。
let pin = null, listening = 0;
const bare = host => String(host).toLowerCase().replace(/^\[|\]$/g, '');
const pinned = (host, port) => pin !== null && bare(host) === pin.host && String(port) === pin.port;
for (const name of ['request', 'get']) {
  http[name] = function() { reject(`http.${name}`); };
  const original = https[name];
  https[name] = function(input, ...args) {
    const kind = `https.${name}`;
    increment(report.checks, kind);
    const url = typeof input === 'string' || input instanceof URL ? new URL(input) : input ?? {};
    const override = args[0] && typeof args[0] === 'object' ? args[0] : {};
    if (url.protocol !== undefined && url.protocol !== 'https:') reject(kind);
    if (!pinned(override.hostname ?? override.host ?? url.hostname ?? url.host, override.port ?? (url.port || url.defaultPort || 443))) reject(kind);
    return original.call(this, input, ...args);
  };
}
const originalFetch = globalThis.fetch;
globalThis.fetch = function(input, ...args) {
  increment(report.checks, 'fetch');
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.protocol !== 'https:' || !pinned(url.hostname, url.port || 443)) reject('fetch');
  return originalFetch.call(this, input, ...args);
};
// 所有 TCP/TLS 连接最后都走到这里：net.connect、tls.connect、http 代理库都一样。
const socketConnect = net.Socket.prototype.connect;
// T9 C2: the arguments are normalized once the way Node does it (an array Node normalized itself is taken as it is), and
// every option is read exactly once into a plain object. That object is what is checked and what connects, so an array
// dressed up as options, or a getter that answers the pin first and somewhere else later, connects nowhere else.
const normalizedMark = Object.getOwnPropertySymbols(net._normalizeArgs([{}]))[0];
net.Socket.prototype.connect = function(...args) {
  increment(report.checks, 'socket.connect');
  const [given, callback] = Array.isArray(args[0]) && normalizedMark !== undefined && args[0][normalizedMark] ? args[0] : net._normalizeArgs(args);
  const options = {};
  if (given && typeof given === 'object') for (const key in given) options[key] = given[key];
  if (options.path != null) reject('socket.connect');
  if (options.lookup !== undefined && options.lookup !== dns.lookup) reject('socket.connect');
  if (!pinned(options.host || 'localhost', options.port)) reject('socket.connect');
  return typeof callback === 'function' ? socketConnect.call(this, options, callback) : socketConnect.call(this, options);
};
const serverListen = net.Server.prototype.listen;
net.Server.prototype.listen = function(...args) {
  const first = args[0], object = typeof first === 'object' && first !== null;
  increment(report.checks, 'server.listen');
  if ((object ? first.host : args[1]) !== '127.0.0.1' || (object && first.path != null) || typeof first === 'string' && !/^\d+$/.test(first)) reject('server.listen');
  // Node 在 listen 里同步地对这个地址调一次 dns.lookup；127.0.0.1 不发 DNS 报文。
  listening++;
  try { return serverListen.apply(this, args); } finally { listening--; }
};
for (const target of [dns, dns.promises]) for (const name of Object.keys(target).filter(name => name === 'lookup' || name.startsWith('resolve') || name === 'reverse' || name === 'lookupService')) {
  if (typeof target[name] !== 'function') continue;
  const original = target[name];
  target[name] = function(host, ...args) {
    const kind = `dns.${name}`;
    increment(report.checks, kind);
    if (name !== 'lookup') reject(kind);
    if (!(pin !== null && bare(host) === pin.host) && !(listening > 0 && host === '127.0.0.1')) reject(kind);
    return original.call(this, host, ...args);
  };
}
for (const resolver of [dns.Resolver, dns.promises.Resolver]) for (const name of Object.getOwnPropertyNames(resolver.prototype).filter(name => name.startsWith('resolve') || name === 'reverse')) {
  resolver.prototype[name] = function() { reject(`dns.Resolver.${name}`); };
}
http2.connect = function() { reject('http2.connect'); };
dgram.createSocket = function() { reject('dgram.createSocket'); };
// T9 C2: a socket built with `new dgram.Socket` (its own lookup included) cannot bind, connect or send either.
for (const name of ['bind', 'connect', 'send', 'sendto']) if (typeof dgram.Socket.prototype[name] === 'function') dgram.Socket.prototype[name] = function() { reject(`dgram.Socket.${name}`); };
// T9 C2: the inspector would listen on a port of its own choosing.
for (const target of [inspector, inspectorPromises]) target.open = function() { reject('inspector.open'); };

// 进程：不起任何子进程，也不留绕过上面规则的入口。
for (const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']) {
  childProcess[name] = function() { reject(`child.${name}`); };
}
// T9 C2: and not through a ChildProcess built by hand, which the functions above never see.
childProcess.ChildProcess.prototype.spawn = function() { reject('child.ChildProcess.spawn'); };
workerThreads.Worker = function() { reject('worker.Worker'); };
for (const name of ['binding', '_linkedBinding', 'dlopen', 'loadEnvFile', '_debugProcess']) {
  process[name] = function() { reject(`process.${name}`); };
}
syncBuiltinESMExports();

function readCredentials({ baseUrlEnv, apiKeyEnv }) {
  if (report.keyFileReads) reject('key.file');
  report.keyFileReads++;
  const values = parseEnv(readKeyFile(keyFile, 'utf8'));
  let url;
  try { url = new URL(String(values[baseUrlEnv] ?? '').trim()); }
  catch { throw new Error('LIVE_GUARD: the key file has no valid API address'); }
  if (url.protocol !== 'https:') throw new Error('LIVE_GUARD: the API address must be HTTPS');
  pin = { host: bare(url.hostname), port: url.port || '443' };
  report.pinned = true;
  // 只取这两个名字，文件里的其余内容到此丢弃。
  return { [baseUrlEnv]: values[baseUrlEnv], [apiKeyEnv]: values[apiKeyEnv] };
}
globalThis[stateKey] = Object.freeze({ readCredentials });

const reportDir = process.env.OFFLINE_GUARD_REPORT_DIR;
if (reportDir) { checkPath(reportDir, 'report.directory'); makeDirectory(reportDir, { recursive: true }); }
process.once('exit', () => {
  report.deniedOperations = Object.values(report.denied).reduce((sum, n) => sum + n, 0);
  const text = JSON.stringify(report);
  if (reportDir) saveReport(join(reportDir, `${process.pid}-${report.instance}.json`), text + '\n', { flag: 'wx' });
  else console.log(text);
});
