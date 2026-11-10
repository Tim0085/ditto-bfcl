// T11 第 2 条：一次断线只压出错的那个请求；HTTP 429 仍全局冷却；出口重启只恢复全局冷却。
// 假 API 是本机 127.0.0.1 的 HTTP 服务；真实时钟，单个场景约 30 秒。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, request } from 'node:http';
import { startEgress } from '../src/ts/egress/server.ts';
import { loadEgressConfig } from '../src/ts/egress/config.ts';
import { Gateway } from '../src/ts/egress/gateway.ts';
import { MODEL_ENDPOINT_PROTOCOL } from '../src/ts/model-endpoint.ts';
import { mockResponse } from '../src/ts/egress/mock.ts';

const config = () => loadEgressConfig('config/egress.offline.json', 'live');
async function output() { const root = process.env.T5_TEST_OUTPUT ?? tmpdir(); await mkdir(root, { recursive: true }); return mkdtemp(join(root, 't11-egress-')); }
function call(configId: string, taskId: string, text: string) {
  const identity = { configId, taskId, caseId: 'multi_turn_base_0', turn: 1, step: 1 };
  return { protocol: MODEL_ENDPOINT_PROTOCOL, ...identity, input: { metadata: identity, model: { model: 'deepseek-flash' }, messages: [{ role: 'user', content: text }], actions: [] } };
}
function post(url: string, body: any): Promise<any> {
  return new Promise((yes, no) => {
    const req = request(url, { method: 'POST', headers: { 'content-type': 'application/json' } }, res => { let t = ''; res.on('data', c => t += c); res.on('end', () => { try { yes(JSON.parse(t)); } catch (e) { no(e); } }); });
    req.on('error', no); req.end(JSON.stringify(body));
  });
}
const raw = () => mockResponse({ message: { role: 'assistant', content: 'done' }, finishReason: 'stop' }, 'deepseek-flash', 'chat-completions', 0);
/** 假 API：记下每次到达的时刻和是哪个配置（看消息里的标记）；first 决定 A 的第一次怎么失败。 */
async function fakeApi(first: 'reset' | 429) {
  const arrivals: { who: string; at: number }[] = []; let failed = false;
  const server = createServer((req, res) => {
    let body = ''; req.on('data', c => body += c); req.on('end', () => {
      const who = body.includes('MARK-A') ? 'A' : body.includes('MARK-B') ? 'B' : '?'; arrivals.push({ who, at: Date.now() });
      if (who === 'A' && !failed) { failed = true; if (first === 'reset') { res.destroy(); return; } res.writeHead(429, { 'retry-after': '1' }); res.end('{}'); return; }
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(raw()));
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${(server.address() as any).port}`, arrivals, close: () => new Promise<void>(r => server.close(() => r())) };
}
const lines = async (path: string) => (await readFile(path, 'utf8')).trim().split('\n').map(x => JSON.parse(x));
async function until(check: () => Promise<boolean> | boolean) { for (let i = 0; i < 400; i++) { if (await check()) return; await new Promise(r => setTimeout(r, 25)); } throw new Error('timed out waiting'); }
async function scenario(first: 'reset' | 429) {
  const api = await fakeApi(first), dir = await output(), s = await startEgress(await config(), dir, { testUrl: api.url });
  try {
    const a = post(s.url, call('config-A', 'task-A', 'MARK-A'));
    await until(async () => { try { return (await lines(join(dir, 'rate.cooldowns.jsonl'))).length === 1; } catch { return false; } });
    const cooled = Date.now(), b: any[] = [];
    // A 冷却期间，配置 B 连发 5 次（同一题依次发）。
    for (let i = 0; i < 5; i++) b.push({ ...(await post(s.url, call('config-B', 'task-B', 'MARK-B ' + i))), returned: Date.now() });
    const ra = await a, aAt = api.arrivals.filter(x => x.who === 'A').map(x => x.at), bAt = api.arrivals.filter(x => x.who === 'B').map(x => x.at);
    const cooldowns = await lines(join(dir, 'rate.cooldowns.jsonl'));
    return { ra, b, aAt, bAt, cooled, cooldowns, retained: s.gateway.ledger.snapshot().retainedRequests };
  } finally { await s.close(); await api.close(); }
}
test('T11 transport reset: only request A waits 30 s; config B keeps sending and receiving meanwhile', async () => {
  const r = await scenario('reset');
  console.log(JSON.stringify({ T11: 'reset-observed', aRetryGapMs: r.aAt[1] - r.aAt[0], bArrivalOffsetsMs: r.bAt.map(t => t - r.aAt[0]), bDoneAfterCooldownMs: r.b.at(-1).returned - r.cooled }));
  assert.equal(r.ra.ok, true, JSON.stringify(r.ra)); assert.equal(r.aAt.length, 2); assert.equal(r.retained, 1);
  assert(r.aAt[1] - r.aAt[0] >= 30000, 'A waited its own 30 s: ' + (r.aAt[1] - r.aAt[0]));
  assert.equal(r.b.length, 5); assert(r.b.every(x => x.ok === true));
  assert(r.bAt.every(t => t < r.aAt[1]), 'all five B requests reached the API before A retried');
  assert(r.b.at(-1).returned - r.cooled < 10000, 'B was not held by A\'s cooldown: ' + (r.b.at(-1).returned - r.cooled));
  assert.deepEqual(r.cooldowns.map(c => [c.configId, c.reason, c.scope, c.delayMs]), [['config-A', 'transport', 'request', 30000]]);
  console.log(JSON.stringify({ T11: 'reset', aRetryGapMs: r.aAt[1] - r.aAt[0], bArrivalOffsetsMs: r.bAt.map(t => t - r.aAt[0]), bDoneAfterCooldownMs: r.b.at(-1).returned - r.cooled, cooldowns: r.cooldowns }));
});
test('T11 HTTP 429: still a global cooldown; config B waits with A and Retry-After is honoured', async () => {
  const r = await scenario(429);
  assert.equal(r.ra.ok, true, JSON.stringify(r.ra)); assert.equal(r.aAt.length, 2); assert.equal(r.retained, 1);
  assert(r.aAt[1] - r.aAt[0] >= 30000); assert(r.b.every(x => x.ok === true));
  assert(r.bAt[0] - r.aAt[0] >= 29000, 'B held by the global 429 cooldown: ' + (r.bAt[0] - r.aAt[0]));
  assert.deepEqual(r.cooldowns.map(c => [c.configId, c.reason, c.scope, c.delayMs]), [['config-A', 'http_429', 'global', 30000]]);
  console.log(JSON.stringify({ T11: '429', aRetryGapMs: r.aAt[1] - r.aAt[0], firstBAfterAMs: r.bAt[0] - r.aAt[0], cooldowns: r.cooldowns }));
});
test('T11 egress restart restores only global cooldowns (old records without scope count as global)', async () => {
  const cases = [
    { name: 'request-only', rows: [{ delayMs: 100000, scope: 'request', reason: 'transport' }], expect: 0 },
    { name: 'global+request', rows: [{ delayMs: 100000, scope: 'request', reason: 'transport' }, { delayMs: 40000, scope: 'global', reason: 'http_429' }], expect: 40000 },
    { name: 'legacy-no-scope', rows: [{ delayMs: 50000, reason: 'transport' }], expect: 50000 },
  ];
  for (const c of cases) {
    const dir = await output(), at = Date.now();
    await writeFile(join(dir, 'rate.cooldowns.jsonl'), c.rows.map((r, i) => JSON.stringify({ configId: 'x', reservationId: 'r' + i, at, until: at + r.delayMs, ...r })+'\n').join(''));
    let mono = 0, slept = 0; const clock = { now: Date.now, monotonicNow: () => mono, sleep: async (ms: number) => { mono += ms; slept += ms; } };
    let sentAfter = -1; const g = await Gateway.open(dir, await config(), async () => { sentAfter = slept; return raw(); }, clock);
    try { const out: any = await g.invoke(call('config-A', 'task-A', 'x').input as any); assert.equal(out.finishReason, 'stop'); }
    finally { g.close(); }
    console.log(JSON.stringify({ T11: 'restart-observed', case: c.name, firstRequestWaitMs: sentAfter, expectedMs: c.expect }));
    assert(Math.abs(sentAfter - c.expect) <= 1000, `${c.name}: first request after ${sentAfter} ms, expected ~${c.expect}`);
  }
});
