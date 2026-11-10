// 进程内离线保护，不代替容器权限隔离。所有真实路径检查都使用未打补丁的 native realpath。
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';
import childProcess from 'node:child_process';
import nodeModule, { registerHooks, syncBuiltinESMExports } from 'node:module';
import { resolve, dirname, basename, join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { liveEgressLaunch } from './egress-live-launch.mjs';

const guardState = globalThis[Symbol.for('ditto.egress.offlineGuard')];
if (!guardState) throw new Error('Load scripts/egress-offline-guard.mjs as the guard entry');
const nativeRealpath = fs.realpathSync.native;
const nativeReaddir = fs.readdirSync, nativeStat = fs.statSync;
const saveReport = fs.writeFileSync, makeDirectory = fs.mkdirSync;
const report = { offlineGuard: true, version: 2, pid: process.pid, ppid: process.ppid,
  instance: randomUUID(), launchId: process.env.OFFLINE_GUARD_LAUNCH_ID ?? null, checks: {}, denied: {}, children: [] };
const increment = (group, kind) => { group[kind] = (group[kind] ?? 0) + 1; };
function reject(kind) { increment(report.denied, kind); throw new Error(`OFFLINE_GUARD: forbidden ${kind}`); }
function pathString(value) {
  if (value instanceof URL) return fileURLToPath(value);
  if (Buffer.isBuffer(value)) return value.toString();
  return typeof value === 'string' ? value : undefined;
}
const normalize = value => {
  let result = value.replaceAll('\\', '/').replace(/^\/\/\?\//, '');
  if (process.platform === 'win32') result = result.toLowerCase();
  return result.replace(/\/$/, '');
};
// T8a fix 6: on Windows a file whose last handle is closing (e.g. a temporary file
// another writer just unlinked) is briefly delete-pending; realpath then reports
// EBADF/EPERM/EBUSY. Retry the same resolution a few times; a persistent error is
// rethrown exactly as before, so no path is ever accepted without resolving it.
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
const forbiddenRoots = [String.raw`F:\Academic\Ditto\experiments\private`,
  ...(process.env.OFFLINE_GUARD_EXTRA_FORBIDDEN ? JSON.parse(process.env.OFFLINE_GUARD_EXTRA_FORBIDDEN) : [])]
  .map(value => normalize(realTarget(value)));
const forbiddenParts = value => normalize(value).split('/').some(part => part.toLowerCase() === 'private' || part.toLowerCase().startsWith('.env'));
function checkPath(value, kind = 'file', cwd) {
  const text = pathString(value);
  if (text === undefined) return; // fd / FileHandle：打开该句柄时已检查；预先打开的句柄不属于权限隔离。
  increment(report.checks, kind);
  if (forbiddenParts(text)) reject(kind);
  const absolute = resolve(cwd ?? process.cwd(), text);
  if (forbiddenParts(absolute)) reject(kind);
  const target = normalize(realTarget(text, cwd));
  if (forbiddenParts(target) || forbiddenRoots.some(root => target === root || target.startsWith(root + '/'))) reject(kind);
}
function checkRecursiveDirectory(value, kind, seen = new Set()) {
  checkPath(value, kind);
  const path = pathString(value), real = normalize(realTarget(path));
  if (seen.has(real)) return;
  seen.add(real);
  for (const entry of nativeReaddir(path, {withFileTypes:true})) {
    const child = join(path, entry.name);
    // 在进入下一层之前检查，不能先遍历完禁区再过滤返回结果。
    checkPath(child, kind);
    let directory = entry.isDirectory();
    if (entry.isSymbolicLink()) {
      try { directory = nativeStat(child).isDirectory(); }
      catch (error) { if (!['ENOENT','ENOTDIR'].includes(error.code)) throw error; }
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
      // cp 内部递归不一定再调用公开 fs 函数，过滤器逐个检查源与目标。
      if (base === 'cp') {
        const options = typeof args[2] === 'object' && args[2] !== null ? args[2] : {};
        const filter = options.filter;
        const checkedFilter = (src, dest) => { checkPath(src, kind); checkPath(dest, kind); return filter ? filter(src, dest) : true; };
        if (typeof args[2] === 'function') args.splice(2, 0, {filter: checkedFilter});
        else args[2] = {...options, filter: checkedFilter};
      }
      return Reflect.apply(original, this, args);
    };
    if (original.native) wrapped.native = function(path, ...args) { checkPath(path, `${label}.${name}.native`); return original.native.call(this, path, ...args); };
    target[name] = wrapped;
  }
}
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('file:')) checkPath(new URL(specifier), 'module.resolve');
    else if (specifier.startsWith('.') && context.parentURL?.startsWith('file:')) checkPath(new URL(specifier, context.parentURL), 'module.resolve');
    else if (isAbsolute(specifier)) checkPath(specifier, 'module.resolve');
    const result = next(specifier, context);
    // 同URL由Node缓存，不再执行入口正文；在resolve中记录这类重复加载。
    if (guardState.entries.has(result.url)) guardState.duplicateLoads++;
    if (result.url.startsWith('file:')) checkPath(new URL(result.url), 'module.resolve');
    return result;
  },
  load(url, context, next) { if (url.startsWith('file:')) checkPath(new URL(url), 'module.load'); return next(url, context); }
});

const local = host => ['localhost','127.0.0.1','::1','[::1]'].includes(String(host).toLowerCase());
function checkHost(host, kind) { increment(report.checks, kind); if (!local(host)) reject(kind); }
for (const target of [http, https]) for (const name of ['request','get']) {
  const original = target[name];
  target[name] = function(input, ...args) {
    const options = typeof input === 'string' || input instanceof URL ? new URL(input) : input;
    const override = args[0] && typeof args[0] === 'object' ? args[0] : {};
    const kind = `${target === https ? 'https' : 'http'}.${name}`;
    checkHost(override.hostname ?? override.host ?? options.hostname ?? options.host ?? 'localhost', kind);
    if (target === https) reject(kind); // 保留原规则：HTTP只许本机，HTTPS禁用。
    return original.call(this, input, ...args);
  };
}
const originalFetch = globalThis.fetch;
globalThis.fetch = function(input, ...args) { checkHost(new URL(typeof input === 'string' || input instanceof URL ? input : input.url).hostname, 'fetch'); return originalFetch.call(this, input, ...args); };
function socketCheck(args, kind) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  if (typeof first === 'object') {
    if (first.path) { checkPath(first.path, kind); return; }
    checkHost(first.host ?? first.hostname ?? 'localhost', kind);
  } else if (typeof first === 'string' && !/^\d+$/.test(first)) checkPath(first, kind);
  else checkHost(typeof args[1] === 'string' ? args[1] : 'localhost', kind);
}
for (const [target, names] of [[net,['connect','createConnection']], [net.Socket.prototype,['connect']], [tls,['connect']]]) for (const name of names) {
  const original = target[name]; target[name] = function(...args) { socketCheck(args, `socket.${name}`); return original.apply(this, args); };
}
for (const target of [dns, dns.promises]) for (const name of Object.keys(target).filter(name => name === 'lookup' || name.startsWith('resolve') || name === 'reverse' || name === 'lookupService')) {
  if (typeof target[name] !== 'function') continue;
  const original = target[name]; target[name] = function(host, ...args) {
    checkHost(host, `dns.${name}`);
    // resolve* 使用配置的DNS服务器，不能让“localhost”触发外部DNS报文；只允许系统本机lookup。
    if (name !== 'lookup') reject(`dns.${name}`);
    return original.call(this, host, ...args);
  };
}

const guardURL = new URL('./egress-offline-guard.mjs', import.meta.url).href;
const liveGuardURL = new URL('./egress-live-guard.mjs', import.meta.url).href;
function guardedOptions(options = {}) {
  const env = {...(options.env ?? process.env)};
  const required = `--import=${guardURL}`;
  const existing = env.NODE_OPTIONS ?? '';
  env.NODE_OPTIONS = existing.includes(required) ? existing : `${existing} ${required}`.trim();
  // 自定义 env 不能丢失本次报告位置或测试哨兵禁区。
  if (env.OFFLINE_GUARD_REPORT_DIR === undefined && process.env.OFFLINE_GUARD_REPORT_DIR !== undefined) env.OFFLINE_GUARD_REPORT_DIR = process.env.OFFLINE_GUARD_REPORT_DIR;
  const extra = [...JSON.parse(process.env.OFFLINE_GUARD_EXTRA_FORBIDDEN ?? '[]'), ...JSON.parse(env.OFFLINE_GUARD_EXTRA_FORBIDDEN ?? '[]')];
  if (extra.length) env.OFFLINE_GUARD_EXTRA_FORBIDDEN = JSON.stringify([...new Set(extra)]);
  return {...options, env};
}
function checkArgument(value, cwd) {
  if (typeof value !== 'string') return;
  // 同时检查完整参数、--key=value及shell中的引号/空白分隔路径，不执行shell展开。
  const tokens = [...value.matchAll(/"([^"]*)"|'([^']*)'|([^\s"';&|<>]+)/g)].map(match => match[1] ?? match[2] ?? match[3]);
  for (const token of new Set([value, ...tokens, value.includes('=') ? value.slice(value.indexOf('=') + 1) : value])) {
    if (!token || token.startsWith('-') || /^(https?|node|data):/.test(token)) continue;
    if (token.startsWith('file:')) checkPath(new URL(token), 'child.argument', cwd);
    else checkPath(token, 'child.argument', cwd);
  }
}
let publicLaunch = 0; // T9 C2: >0 while one of the functions below is starting its child
for (const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']) {
  const original = childProcess[name];
  childProcess[name] = function(command, ...rest) {
    const args = Array.isArray(rest[0]) ? rest[0] : [];
    let optionIndex = Array.isArray(rest[0]) ? 1 : 0;
    const supplied = rest[optionIndex] && typeof rest[optionIndex] === 'object' ? rest[optionIndex] : {};
    const options = guardedOptions(supplied);
    // T9 段 B 唯一例外：调度程序在真实计划下起 egress-shell.ts 时换成真实模式保护器，条件见 egress-live-launch.mjs。
    // 最后一个参数是密钥文件的路径，调度程序不碰这个文件，所以不按禁区检查；其余检查照旧。
    const live = liveEgressLaunch(name, command, args, options);
    if (live) options.env.NODE_OPTIONS = `--import=${liveGuardURL}`;
    const launchId = randomUUID(); options.env.OFFLINE_GUARD_LAUNCH_ID = launchId;
    if (typeof rest[optionIndex] === 'function') rest.splice(optionIndex, 0, options); else rest[optionIndex] = options;
    const isNode = name === 'fork' ? !options.execPath || normalize(realTarget(options.execPath)) === normalize(realTarget(process.execPath))
      : /(^|[\\/])node(?:\.exe)?$/i.test(command);
    // 不记录env；内联代码也不落报告，防止命令源码含环境变量值。
    const safeArgs = args.map((arg, i) => ['-e','--eval','-p','--print'].includes(args[i-1]) ? '[inline code omitted]' : arg);
    const row = {method:name,command: /^(exec|execSync)$/.test(name) ? '[shell command] ' + command.replace(/\b\w+=\S+/g, '[assignment omitted]') : command,
      args:safeArgs,isNode,launchId,guardRequested:!live,liveEgress:live,guardLoaded:false,denied:false,pid:null};
    report.children.push(row); increment(report.checks, 'child.launch');
    try {
      checkPath(options.cwd, 'child.cwd');
      const cwd = options.cwd ? pathString(options.cwd) : process.cwd();
      checkArgument(command, cwd); for (const arg of live ? args.slice(0, -1) : args) checkArgument(arg, cwd);
      if (options.execPath) checkArgument(options.execPath, cwd);
      publicLaunch++; let child; try { child = original.call(this, command, ...rest); } finally { publicLaunch--; }
      row.pid = child?.pid ?? null; return child;
    } catch (error) { row.denied = String(error.message).includes('OFFLINE_GUARD'); throw error; }
  };
}
// T9 C2: a ChildProcess built by hand reaches the operating system without the functions above. It gets the same forced guard
// and the same path checks here; a launch that already passed the functions above (they end up here too) goes through as it is.
const childSpawn = childProcess.ChildProcess.prototype.spawn;
childProcess.ChildProcess.prototype.spawn = function(supplied) {
  if (publicLaunch) return childSpawn.call(this, supplied);
  const given = supplied && typeof supplied === 'object' ? supplied : {}, args = Array.isArray(given.args) ? given.args : [];
  const env = {};
  for (const pair of Array.isArray(given.envPairs) ? given.envPairs : []) { const text = String(pair), at = text.indexOf('='); if (at > 0) env[text.slice(0, at)] = text.slice(at + 1); }
  const options = guardedOptions({env}), launchId = randomUUID(); options.env.OFFLINE_GUARD_LAUNCH_ID = launchId;
  const safeArgs = args.map((arg, i) => ['-e','--eval','-p','--print'].includes(args[i-1]) ? '[inline code omitted]' : arg);
  const row = {method:'ChildProcess.spawn',command:given.file,args:safeArgs,isNode:/(^|[\\/])node(?:\.exe)?$/i.test(String(given.file)),launchId,guardRequested:true,liveEgress:false,guardLoaded:false,denied:false,pid:null};
  report.children.push(row); increment(report.checks, 'child.launch');
  try {
    checkPath(given.cwd, 'child.cwd');
    const cwd = given.cwd ? pathString(given.cwd) : process.cwd();
    checkArgument(given.file, cwd); for (const arg of args) checkArgument(arg, cwd);
    const result = childSpawn.call(this, {...given, envPairs: Object.entries(options.env).map(([k, v]) => `${k}=${v}`)});
    row.pid = this.pid ?? null; return result;
  } catch (error) { row.denied = String(error.message).includes('OFFLINE_GUARD'); throw error; }
};
// T9 C2: no loader thread without this guard. Test hooks use registerHooks (same thread, checked by the hooks above) and keep it.
nodeModule.register = function() { reject('module.register'); };
syncBuiltinESMExports();
const reportDir = process.env.OFFLINE_GUARD_REPORT_DIR;
if (reportDir) { checkPath(reportDir, 'report.directory'); makeDirectory(reportDir, {recursive:true}); }
process.once('exit', () => {
  report.initializations = 1;
  report.duplicateLoads = guardState.duplicateLoads;
  report.checkedFileOperations = Object.entries(report.checks).filter(([key]) => /^(fs|fsp|module)\./.test(key)).reduce((sum, [,n]) => sum+n, 0);
  report.deniedOperations = Object.values(report.denied).reduce((sum, n) => sum+n, 0);
  const text = JSON.stringify(report);
  if (reportDir) saveReport(join(reportDir, `${process.pid}-${report.instance}.json`), text+'\n', {flag:'wx'});
  else console.log(text);
});
