import test from 'node:test';
import { runWebBPython } from './web-b-python.ts';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, readdir, writeFile, appendFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startEgress } from '../src/ts/egress/server.ts';
import { loadEgressConfig, type EgressConfig } from '../src/ts/egress/config.ts';
import { SEARCH_ENDPOINT_PATH, SEARCH_ENDPOINT_PROTOCOL, type SearchCall, type SearchReply } from '../src/ts/search-endpoint.ts';
import { liveSearch, searchAddress, type SearchAttempt, type SearchTransport } from '../src/ts/egress/backends/search.ts';
import { mockResponse } from '../src/ts/egress/mock.ts';
import { MODEL_ENDPOINT_PROTOCOL } from '../src/ts/model-endpoint.ts';
import { createModelClient } from '../src/ts/model-client.ts';
import { inputLimitDetails } from '../src/ts/egress/retry.ts';
import { taskPlan } from '../src/ts/direct-task.ts';
import { loadTask } from '../src/ts/tool-actions.ts';
import type { Clock } from '../src/ts/egress/limiter.ts';

const rawSuccess = '{"results":[{"title":"example","url":"https://example.invalid/?token=public&key=term","snippet":"test"}]}';
const success: SearchAttempt = {status: 200, raw: rawSuccess};
const query: SearchCall['query'] = {keywords: '示例', max_results: 10, region: 'wt-wt'};
const call: SearchCall = {protocol: SEARCH_ENDPOINT_PROTOCOL, configId: 'direct-c1', caseId: 'web_search_1',
  taskId: 'wb/direct-c1/r1/web_search_no_snippet_1', call: 1, query};
const output = () => mkdtemp(join(tmpdir(), 'wb-egress-'));
const config = () => loadEgressConfig('config/egress.offline.json', 'live');
function virtualClock() {
  let now = 1_800_000_000_000;
  return {now: () => now, monotonicNow: () => now, sleep: async (ms: number) => {now += ms;}};
}
const modelInput = (taskId = 'model-task') => ({
  metadata: {configId: 'direct-c1', caseId: 'web_search_no_snippet_0', taskId, turn: 1, step: 1},
  model: {model: 'deepseek-flash'}, messages: [{role: 'user' as const, content: 'hello'}], actions: [],
});
const modelReply = () => mockResponse({message: {role: 'assistant', content: 'ok'}, finishReason: 'stop'}, 'deepseek-flash', 'chat-completions', 0);
async function fakeModel(respond: () => {status?: number; body: unknown; raw?: string} = () => ({body: modelReply()})) {
  const server = createServer((req, res) => {
    req.resume();
    const {status, body, raw} = respond();
    res.writeHead(status ?? 200, {'content-type': 'application/json'});
    res.end(raw ?? JSON.stringify(body));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return {url: 'http://127.0.0.1:' + (server.address() as {port: number}).port,
    close: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))};
}
async function service(t: {after(fn: () => Promise<void>): void}, options: {search?: SearchTransport; clock?: Clock;
  config?: EgressConfig; model?: Parameters<typeof fakeModel>[0]; dir?: string} = {}) {
  const model = await fakeModel(options.model);
  let s: Awaited<ReturnType<typeof startEgress>> | undefined;
  t.after(async () => {try {await s?.close();} finally {await model.close();}});
  const dir = options.dir ?? await output();
  s = await startEgress(options.config ?? await config(), dir, {testUrl: model.url, clock: options.clock ?? virtualClock(), searchTransport: options.search});
  return {...s, dir};
}
async function post(url: string, payload: unknown = call, options: {method?: string; contentType?: string; body?: string} = {}) {
  const method = options.method ?? 'POST';
  const response = await fetch(new URL(SEARCH_ENDPOINT_PATH, url), {method,
    headers: {'content-type': options.contentType ?? 'application/json'},
    ...(method === 'POST' ? {body: options.body ?? JSON.stringify(payload)} : {})});
  assert.equal(response.status, 200);
  return await response.json() as SearchReply;
}
async function modelPost(url: string, id?: string) {
  const input = modelInput(id);
  const response = await fetch(url, {method: 'POST', body: JSON.stringify({protocol: MODEL_ENDPOINT_PROTOCOL, ...input.metadata, input})});
  assert.equal(response.status, 200);
  return await response.json() as any;
}
const kind = (reply: SearchReply) => reply.ok ? 'ok' : reply.error.kind;
async function rows(dir: string, name: string) {
  return (await readFile(join(dir, name), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
}
async function marker(dir: string) {return JSON.parse(await readFile(join(dir, 'stopped.json'), 'utf8'));}

test('HTTP contract, deterministic fixture, validation rejects without reserve', async t => {
  const c = await loadEgressConfig('config/egress.offline.json', 'fixtures');
  const s = await service(t, {config: c});
  for (const input of [null, {...call, protocol: 'bad'}, {...call, call: 0}, {...call, caseId: 'bad'}, {...call, taskId: ''},
    {...call, caseId: 'web_search_2'}, {...call, taskId: 'wb/direct-c1/r1/web_search_no_snippet_2'},
    {...call, taskId: 'wb/direct-c1/r0/web_search_no_snippet_1'}, {...call, taskId: 'web_search_no_snippet_1'},
    ...[0, 51, 1.5, '3', true].map(max_results => ({...call, query: {...query, max_results}})),
    ...['', ' ', '𠮷'.repeat(129)].map(keywords => ({...call, query: {...query, keywords}})),
    {...call, query: {...query, region: 'us-en'}}, {...call, query: {...query, extra: true}}]) {
    assert.equal(kind(await post(s.url, input)), 'invalid_argument');
  }
  for (const options of [{method: 'GET'}, {contentType: 'text/plain'}, {body: '{'}])
    assert.equal(kind(await post(s.url, call, options)), 'invalid_argument');
  assert.equal(s.search!.ledger.reservations.size, 0);
  assert.equal(await readFile(join(s.dir,'search-rate.jsonl'),'utf8'),'');
  const a = await post(s.url, {...call, query: {...query, keywords: '𠮷'.repeat(128), max_results: 1}});
  const b = await post(s.url, {...call, call: 2, query: {...query, max_results: 50}});
  assert.equal(kind(a), 'ok'); assert.deepEqual(a, b);
  assert.equal(s.search!.ledger.snapshot().spentMicroCny, 10000);
  assert.equal(s.gateway.ledger.reservations.size, 0);
});

test('search billing and attempt records distinguish nonempty, empty, refusal and unknown', async t => {
  const attempts: SearchAttempt[] = [success, {status: 200, raw: '{"results":[]}'}, {status: 404, raw: '{"error":"bad query"}'},
    {status: null, raw: null}, {status: 503, raw: '{}'}, {status: 200, raw: 'not-json'}];
  const s = await service(t, {search: async () => attempts.shift()!});
  assert.deepEqual(await post(s.url), {ok: true, output: {organic_results: [{title: 'example', link: 'https://example.invalid/?token=public&key=term', snippet: 'test'}]}});
  assert.deepEqual(await post(s.url, {...call, call: 2}), {ok: true, output: {organic_results: []}});
  assert.equal(kind(await post(s.url, {...call, call: 3})), 'search_failed');
  assert.equal(kind(await post(s.url, {...call, call: 4})), 'search_failed');
  assert.equal(s.gateway.stopped, false);
  assert.deepEqual((await rows(s.dir, 'search-ledger.jsonl')).filter(r => r.kind === 'settle').map(r => r.microCny), [5000, 0, 0]);
  assert.deepEqual((await rows(s.dir, 'search-ledger.jsonl')).filter(r => r.kind === 'retain_failed').map(r => r.heldMicroCny), [5000, 5000, 5000]);
  assert.equal((await rows(s.dir, 'search-rate.jsonl')).length, 6);
  const captures = await Promise.all((await readdir(join(s.dir, 'search-records'))).map(file =>
    readFile(join(s.dir, 'search-records', file), 'utf8').then(JSON.parse)));
  assert.equal(captures.length, 6);
  assert(captures.some(row => row.call === 1 && row.configId === call.configId && row.caseId === call.caseId &&
    row.taskId === call.taskId && row.raw === rawSuccess && row.output.organic_results.length === 1 && row.apiMs >= 0));
  assert.deepEqual((await rows(s.dir, 'search-rate.cooldowns.jsonl')).map(r => [r.scope, r.delayMs]), [['request', 30000], ['request', 60000]]);
  assert.equal((await modelPost(s.url)).ok, true);
});

test('an upstream timeout is unknown and retries only twice', async t => {
  const original = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, 'timeout', (ms: number) => original(ms === 60_000 ? 5 : ms));
  let attempts = 0;
  const s = await service(t, {search: async () => {attempts++; return new Promise(() => {});}});
  assert.equal(kind(await post(s.url)), 'search_failed');
  assert.equal(attempts, 3);
  assert.equal(s.search!.ledger.snapshot().retainedMicroCny, 15000);
  assert.equal(s.gateway.stopped, false);
});

test('total response deadline cancels work queued behind a search cooldown', async t => {
  const original = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, 'timeout', (ms: number) => original(ms === 600_000 ? 250 : ms));
  let sends = 0;
  const s = await service(t, {clock: {now: Date.now, sleep: ms => new Promise(resolve => setTimeout(resolve, ms))},
    search: async () => {sends++; return {status: 429, raw: '{}'};}});
  assert.equal(kind(await post(s.url)), 'search_failed');
  assert.equal(kind(await post(s.url, {...call, call: 2})), 'search_failed');
  await s.search!.drain();
  assert.equal(sends, 1);
  assert.equal(s.search!.ledger.snapshot().pending, 0);
  assert.equal(s.search!.ledger.snapshot().retainedMicroCny, 5000);
  assert.equal(s.gateway.stopped, false);
});

for (const fault of [401, 402, 403, 422, 200]) test('account error stops both routes: ' + fault, async t => {
  const s = await service(t, {search: async () => ({status: fault, raw: fault === 200 ? '{"message":"Account has been suspended"}' : fault === 422 ? '{"error":{"message":"Insufficient Balance"}}' : '{}'})});
  assert.equal(kind(await post(s.url)), 'run_stop');
  assert.match((await marker(s.dir)).detail, /余额/);
  assert.equal(s.search!.ledger.snapshot().retainedMicroCny, 5000);
  assert.equal(kind(await post(s.url)), 'run_stop');
  assert.equal((await modelPost(s.url)).error.kind, 'run_stop');
});

for (const cap of ['searchMaxRequests', 'searchCny'] as const) test(cap + ' stops and holds unknown spend', async t => {
  const c = await config(); c[cap] = cap === 'searchMaxRequests' ? 1 : .005;
  let sends = 0;
  const s = await service(t, {config: c, search: async () => {sends++; return {status: 502, raw: '{}'};}});
  assert.equal(kind(await post(s.url)), 'run_stop');
  assert.match((await marker(s.dir)).detail, new RegExp(cap));
  assert.equal(sends, 1);
  assert.equal(s.search!.ledger.snapshot().retainedMicroCny, 5000);
  assert.equal((await modelPost(s.url)).error.kind, 'run_stop');
});

test('replay rejects search, and search accounting write failure stops the model', async t => {
  const c = await loadEgressConfig('config/egress.offline.json', 'replay'), dir = await output();
  const index = join(dir, 'replay.json'); await writeFile(index, '{"version":1,"records":{}}');
  c.replay = {source: dir, index, failOnDifference: true};
  const s = await service(t, {config: c, dir});
  assert.equal(kind(await post(s.url)), 'run_stop');
  assert.match((await marker(dir)).detail, /回放/);
  let sends = 0;
  const bad = await service(t, {search: async () => {sends++; return success;}});
  await unlink(join(bad.dir, 'search-rate.jsonl'));
  await mkdir(join(bad.dir, 'search-rate.jsonl'));
  assert.equal(kind(await post(bad.url)), 'run_stop');
  assert.equal(sends, 0);
  assert.equal(bad.search!.ledger.snapshot().reservedMicroCny, 5000);
  assert.equal((await modelPost(bad.url)).error.kind, 'run_stop');
});

test('cooldown scopes leave the model unaffected and only 429 delays a peer search', async t => {
  for (const status of [429, 503]) {
    let now = 1_800_000_000_000;
    const sleeps: {at: number; wake: () => void}[] = [];
    const clock = {now: () => now, monotonicNow: () => now, sleep: (ms: number) =>
      new Promise<void>(wake => sleeps.push({at: now + ms, wake}))};
    let count = 0;
    const arrived: {keywords: string; at: number}[] = [];
    const s = await service(t, {clock, search: async q => {
      arrived.push({keywords: q.keywords, at: now});
      return ++count === 1 ? {status, raw: '{}', retryAfter: '120'} : success;
    }});
    const first = post(s.url);
    for (let i = 0; !sleeps.length && i < 200; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert(sleeps.length > 0);
    const second = post(s.url, {...call, configId: 'peer', query: {...query, keywords: 'peer'}});
    assert.equal((await modelPost(s.url)).ok, true, 'model sent while search was cooling');
    for (let i = 0; i < 160 && arrived.length < 3; i++) {
      now += 1000;
      for (const wait of sleeps.splice(0)) {if (wait.at <= now) wait.wake(); else sleeps.push(wait);}
      await new Promise(resolve => setTimeout(resolve, 3));
    }
    assert.equal(kind(await first), 'ok'); assert.equal(kind(await second), 'ok');
    const peer = arrived.find(row => row.keywords === 'peer')!;
    assert.equal(peer.at - arrived[0].at >= 120000, status === 429);
    const [event] = await rows(s.dir, 'search-rate.cooldowns.jsonl');
    assert.equal(event.scope, status === 429 ? 'global' : 'request');
    assert.equal(event.delayMs, 120000);
  }
});

test('a model stop wakes a queued search without another upstream attempt', async t => {
  let sends = 0;
  const s = await service(t, {clock: {now: Date.now, sleep: ms => new Promise(resolve => setTimeout(resolve, ms))},
    search: async () => {sends++; return {status: 429, raw: '{}'};},
    model: () => ({status: 400, body: {error: {message: 'generic invalid request'}}})});
  const queued = post(s.url);
  for (let i = 0; s.search!.ledger.retained.size === 0 && i < 200; i++)
    await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(s.search!.ledger.retained.size, 1);
  assert.equal((await modelPost(s.url)).error.kind, 'run_stop');
  assert.equal(kind(await queued), 'run_stop');
  assert.equal(sends, 1);
});

test('search address uses only model HTTPS origin; injected HTTPS observes fixed request and redaction', async t => {
  assert.equal(searchAddress('https://api.invalid:8443/v1').href, 'https://api.invalid:8443/v1/tools/search');
  assert.equal(searchAddress('https://api.invalid/v1/').href, searchAddress('https://api.invalid').href);
  assert.throws(() => searchAddress('http://api.invalid:8443'), /HTTPS/);
  const c = await config(), secret = 'FAKE-SEARCH-MARKER-ONLY', link = 'https://example.invalid/?token=public';
  let written: any;
  t.mock.method(https, 'request', (url: URL, options: any, receive: (res: any) => void) => {
    assert.equal(url.href, 'https://api.invalid:8443/v1/tools/search');
    assert.equal(options.method, 'POST');
    assert.equal(options.headers.Authorization, 'Bearer ' + secret);
    assert.equal(options.headers['Accept-Encoding'], 'identity');
    return Object.assign(new EventEmitter(), {end(body: string) {
      written = JSON.parse(body);
      const res = Object.assign(new EventEmitter(), {statusCode: 200, headers: {}, destroy() {}});
      receive(res);
      res.emit('data', Buffer.from(JSON.stringify({results: [{title: secret, url: link, snippet: 'ok'}]})));
      res.emit('end');
    }});
  });
  const {transport, redactQuery} = liveSearch(c.settings, {[c.settings.model.baseUrlEnv]: 'https://api.invalid:8443/v1',
    [c.settings.model.apiKeyEnv]: secret});
  const result = await transport(query, new AbortController().signal);
  assert.deepEqual(written, {query: query.keywords, count: query.max_results, need_content: false});
  assert(result.raw?.includes(link) && result.raw.includes('[REDACTED]') && !result.raw.includes(secret));
  assert.equal(redactQuery({...query, keywords: secret}).keywords, '[REDACTED]');
});

test('live search refuses compressed replies and retains at most 8 MiB of identity body', async t => {
  const c = await config();
  let encoding = 'gzip';
  t.mock.method(https, 'request', (_url: URL, _options: unknown, receive: (res: any) => void) =>
    Object.assign(new EventEmitter(), {end() {
      const res = Object.assign(new EventEmitter(), {statusCode: 200, headers: {'content-encoding': encoding}, destroy() {}});
      receive(res);
      res.emit('data', Buffer.alloc(8 * 1024 * 1024 + 1, 'x'));
      res.emit('end');
    }}));
  const {transport} = liveSearch(c.settings, {[c.settings.model.baseUrlEnv]: 'https://api.invalid/v1',
    [c.settings.model.apiKeyEnv]: 'FAKE-SEARCH-MARKER-ONLY'});
  const send = () => transport(query, new AbortController().signal);
  const compressed = await send();
  assert.equal(compressed.incomplete, true);
  assert.equal(compressed.raw, '');
  encoding = 'identity';
  const oversized = await send();
  assert.equal(oversized.status, 200);
  assert.equal(oversized.incomplete, true);
  assert.equal(Buffer.byteLength(oversized.raw!), 8 * 1024 * 1024);
});

test('1.8 MiB local model body limit blocks the request without reserving', async t => {
  let sends = 0;
  const s = await service(t, {model: () => {sends++; return {body:modelReply()};}});
  const input = modelInput();
  input.messages[0].content = 'x'.repeat(1_887_437);
  await assert.rejects(createModelClient(s.url).invoke(input, {signal: new AbortController().signal}), error => {
    const detail = inputLimitDetails(error);
    return !!detail && detail.maxRequestBytes === 1_887_436 && detail.inputBytes > detail.maxRequestBytes && detail.source === undefined;
  });
  assert.equal(sends, 0);
  assert.equal(s.gateway.ledger.reservations.size, 0);
  assert.equal(s.gateway.stopped, false);
});

test('all eight recorded DeepSeek 400 bodies end only their task and retain the estimate', async t => {
  const records = JSON.parse(await readFile(new URL('./web-b-context-errors.fixture.json', import.meta.url), 'utf8'));
  assert.equal(records.length, 8);
  let next = 0;
  const s = await service(t, {model: () => {
    const row = records[next++];
    return {status: row.httpStatus, body: {error: row.error}};
  }});
  for (const row of records) {
    const result = await modelPost(s.url, 'historical-' + row.line);
    assert.equal(result.error.kind, 'input_limit', String(row.line));
    assert.equal(result.error.details.source, 'provider_context');
    assert.equal(s.gateway.stopped, false);
  }
  assert.equal(s.gateway.ledger.retained.size, 8);
  assert.equal(kind(await post(s.url)), 'ok');
});

const context = (message: unknown, status = 400, raw?: string) => ({
  status, body: {error: typeof message === 'object' ? message : {message}}, raw,
});
const reviewVariants = [
  ['exact text without type', context("This model's maximum context length is 1048576 tokens. However, you requested 1100000 tokens.")],
  ['short uppercase phrase', context('MAXIMUM CONTEXT LENGTH IS 1048576 TOKENS')],
  ['different limit 131072', context('maximum context length is 131072 tokens')],
  ['different limit 10485760', context('maximum context length is 10485760 tokens')],
  ['tokensX glued', context('maximum context length is 1048576 tokensX')],
  ['double space', context('maximum  context length is 1048576 tokens')],
  ['phrase only in type', context({type: 'maximum context length is 1048576 tokens', message: 'bad request'})],
  ['phrase only in code', context({code: 'maximum context length is 1048576 tokens', message: 'bad request'})],
  ['plain text', context('', 400, 'maximum context length is 1048576 tokens')],
  ['HTTP 413', context('maximum context length is 1048576 tokens', 413)],
  ['HTTP 422', context('maximum context length is 1048576 tokens', 422)],
  ['top-level message', {status: 400, body: {message: 'maximum context length is 1048576 tokens'}}],
  ['unrelated mention', context('Invalid tools[0].function.parameters; note maximum context length is 1048576 tokens')],
] as const;
for (const [label, reply] of reviewVariants) test('review P7 rejects ' + label, async t => {
  const s = await service(t, {model: () => reply});
  assert.equal((await modelPost(s.url)).error.kind, 'run_stop');
  assert.equal(s.gateway.stopped, true);
});

test('type and first sentence must both match even when the other field is correct', async t => {
  const sentence = "This model's maximum context length is 1048576 tokens.";
  const typed = (message: string, type = 'invalid_request_error', status = 400) => context({type, message}, status);
  const positive = await service(t, {model: () => typed(sentence.toUpperCase())});
  assert.equal((await modelPost(positive.url)).error.kind, 'input_limit');
  for (const reply of [
    typed(sentence, 'another_error'),
    typed('Invalid tools; note ' + sentence),
    typed(sentence.replace('1048576', '10485760')),
    typed(sentence.replace('tokens.', 'tokensX.')),
    typed(sentence.replace('maximum context', 'maximum  context')),
    typed(sentence, 'invalid_request_error', 422),
  ]) {
    const s = await service(t, {model: () => reply});
    assert.equal((await modelPost(s.url)).error.kind, 'run_stop');
  }
});

test('only the exact DeepSeek 400 context limit ends a task, retaining its original estimate', async t => {
  let n = 0;
  const s = await service(t, {model: () => ++n === 1 ? {status: 400, body: {error: {type: 'invalid_request_error', message: "This model's maximum context length is 1048576 tokens. Request too large."}}}
    : n === 2 ? {body: modelReply()} : {status: 400, body: {error: {message: 'maximum context length is 1048577 tokens'}}}});
  const client = createModelClient(s.url);
  let limitError: unknown;
  await assert.rejects(client.invoke(modelInput('big'), {signal: new AbortController().signal}), error => {
    limitError=error;
    const detail = inputLimitDetails(error);
    return !!detail && detail.source === 'provider_context' && detail.maxContextTokens === 1048576 && detail.inputBytes <= detail.maxRequestBytes;
  });
  const task=await loadTask('web_search_no_snippet_0');
  const driver=taskPlan(task,{taskId:'big',configId:'direct-c1',model:'deepseek-flash',maxOutputTokens:65536,perTaskRequests:100,mode:'live'});
  assert.equal((await driver.next()).value.stage,'open');
  assert.equal((await driver.next({load:{items:[]}})).value.stage,'turn');
  assert.equal((await driver.next({user:{items:[]}})).value.stage,'think');
  assert.equal((await driver.throw(limitError)).value.stage,'close');
  const terminal=(await driver.next({})).value;
  assert.equal(terminal.executionOutcome,'input_limit');
  assert.equal(terminal.termination.source,'provider_context');
  assert.equal(terminal.modelSteps.length,0);
  await writeFile(join(s.dir,'provider-terminal.json'),JSON.stringify({...terminal,status:'terminated',workerEvents:[],
    inputLimitEvents:[{kind:'infer',error:(limitError as Error).message}]},null,2));
  console.log('provider terminal=' + join(s.dir,'provider-terminal.json'));
  assert.equal(s.gateway.ledger.retained.size, 1);
  assert.equal(s.gateway.stopped, false);
  assert.equal((await modelPost(s.url, 'peer')).ok, true);
  assert.equal((await modelPost(s.url, 'other-400')).error.kind, 'run_stop');
  assert.equal(kind(await post(s.url)), 'run_stop');
  runWebBPython('web-b-input-limit.py', join(s.dir, 'provider-terminal.json'));
});
