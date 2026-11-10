// T9 段 B：离线保护器唯一的例外。离线保护器给每个子进程强制挂自己，所以受保护的调度程序起的出口
// 连不了外网；这里判断“这一次 spawn 是不是调度程序在真实计划下起 egress-shell.ts”。
//
// 下面每一条都要成立，缺一条就返回 false，调用方走原路（强制挂离线保护器）。子进程里的 egress-shell.ts
// 发现离线保护器在场就拒绝启动，所以伪造同样命令行得到的只是一个起不来的进程：
//  1. 调用方是 spawn，不走 shell，程序就是当前的 node，工作目录是包根；
//  2. 参数逐项等于 --experimental-transform-types <包内 egress-shell.ts> <运行根> <密钥文件>；
//  3. 当前进程本身是 scripts/t8a.ts run --live，别的入口（运行单元、Python 起的 Node、测试探针）都不是；
//  4. 运行根的 plan.json 哈希自洽，后端和模式都是 live，启动器是 docker；
//  5. 全机调度锁的持有者就是当前进程，而且锁的运行根和 runId 与计划一致；子进程拿不到这把锁；
//  6. scheduler/live-authorizations 下有当前进程写的记录，计划哈希、授权原文和密钥路径都对得上；
//  7. 一个进程只放行一次。
// 放行判断不打开密钥文件，也不看它是否存在（T9 C2 另加的 keyFilePresent 只查属性，见下）。放行只换掉 NODE_OPTIONS，别的都不放宽。
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// 这个模块先于保护器的包装求值，所以这里拿到的是原始函数。
const readFile = fs.readFileSync, readDirectory = fs.readdirSync, statFile = fs.statSync;
const schedulerLock = 'F:/Academic/Ditto/experiments/sec1/_machine/scheduler-lock/scheduler.lock';
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entry = join(packageRoot, 'src/ts/scheduler/egress-shell.ts'), scheduler = join(packageRoot, 'scripts/t8a.ts');
const comparable = value => {
  const text = resolve(String(value)).replaceAll('\\', '/');
  return process.platform === 'win32' ? text.toLowerCase() : text;
};
const same = (a, b) => comparable(a) === comparable(b);
const record = path => JSON.parse(readFile(path, 'utf8'));
let used = false;

function evidence(root, keyFile) {
  const plan = record(join(root, 'plan.json')), { hash, ...body } = plan;
  if (createHash('sha256').update(JSON.stringify(body)).digest('hex') !== hash) return false;
  const { backend, mode } = plan.stage.egress;
  if (backend !== 'live' || mode !== 'live' || plan.stage.launcher?.kind !== 'docker') return false;
  const lock = record(schedulerLock);
  if (lock.pid !== process.pid || !same(lock.root, root) || lock.runId !== plan.runId) return false;
  const directory = join(root, 'scheduler', 'live-authorizations');
  return readDirectory(directory).filter(name => name.endsWith('.json')).map(name => record(join(directory, name)))
    .some(row => row.pid === process.pid && row.planHash === hash && row.keyFile === keyFile
      && typeof row.authorization === 'string' && row.authorization.includes('live:' + hash));
}

// T9 C2：t8a.ts 在写授权记录、起出口之前问一句“我的 --key-file 指的是不是一个存在的文件”。只回答本进程
// `scripts/t8a.ts run --live` 命令行里那一个 --key-file 路径，只给 true/false；用的是保护器包装之前的原始 stat，
// 只查属性、不打开文件内容（密钥目录在测试里是禁区，经保护器的 stat 会被拒）。别的路径、别的入口一律 false。
export function keyFilePresent(path) {
  const argv = process.argv;
  if (!same(argv[1] ?? '', scheduler) || argv[2] !== 'run' || !argv.includes('--live')) return false;
  const given = argv.flatMap((arg, i) => arg === '--key-file' ? [argv[i + 1]] : arg.startsWith('--key-file=') ? [arg.slice('--key-file='.length)] : []);
  if (given.length !== 1 || typeof given[0] !== 'string' || !given[0].trim() || !same(given[0], path)) return false;
  try { return statFile(path).isFile(); } catch { return false; }
}

export function liveEgressLaunch(method, command, args, options) {
  if (used || method !== 'spawn' || options.shell || command !== process.execPath || !same(options.cwd ?? '', packageRoot)) return false;
  if (args.length !== 4 || args[0] !== '--experimental-transform-types' || !same(args[1], entry)) return false;
  if (!isAbsolute(args[2]) || !isAbsolute(args[3])) return false;
  if (!same(process.argv[1] ?? '', scheduler) || process.argv[2] !== 'run' || !process.argv.includes('--live')) return false;
  try { if (!evidence(args[2], args[3])) return false; } catch { return false; }
  used = true;
  return true;
}
