import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { SEARCH_ATTEMPT_TIMEOUT_MS, SEARCH_ENDPOINT_PROTOCOL, type SearchCall, type SearchReply } from '../search-endpoint.ts';
import { searchOutput, type SearchAttempt, type SearchTransport } from './backends/search.ts';
import type { EgressConfig } from './config.ts';
import type { Gateway } from './gateway.ts';
import { GlobalLimiter, type Clock } from './limiter.ts';
import { SearchLedger, SEARCH_RATE } from './search-ledger.ts';
import { writeNew } from './common.ts';

const maxRetries = 2, maxCooldownMs = 120_000;
const modelStopped = new Error('模型出口已停止');
export const searchError = (kind: Extract<SearchReply, {ok: false}>['error']['kind'], message: string): SearchReply =>
  ({ok: false, error: {kind, message}});

export function validSearchCall(value: any): value is SearchCall {
  const query = value?.query;
  const taskNumber = typeof value?.taskId === 'string'
    ? /^[^/]+\/[^/]+\/r[1-9]\d*\/web_search_no_snippet_(0|[1-9]\d*)$/.exec(value.taskId)?.[1] : undefined;
  return value?.protocol === SEARCH_ENDPOINT_PROTOCOL &&
    [value.configId, value.taskId, value.caseId].every(x => typeof x === 'string' && !!x.trim()) &&
    taskNumber !== undefined && value.caseId === 'web_search_' + taskNumber && Number.isSafeInteger(value.call) && value.call >= 1 &&
    typeof query?.keywords === 'string' && !!query.keywords.trim() && [...query.keywords].length <= 128 &&
    Number.isSafeInteger(query.max_results) && query.max_results >= 1 && query.max_results <= 50 && query.region === 'wt-wt' &&
    Object.keys(query).every(key => ['keywords', 'max_results', 'region'].includes(key));
}

export async function untilAborted<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort!: () => void;
  const cancellation = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, {once: true});
    if (signal.aborted) abort();
  });
  try { return await Promise.race([operation, cancellation]); }
  finally { signal.removeEventListener('abort', abort); }
}

function accountFailure({status, raw}: SearchAttempt) {
  if (status !== null && [401, 402, 403].includes(status)) return true;
  let detail: unknown = raw;
  try {
    const parsed = JSON.parse(raw ?? '');
    detail = parsed?.error ?? (status !== 200 || !Array.isArray(parsed?.results) ? parsed : null);
  } catch { /* Explicit messages may also be plain text. */ }
  const message = typeof detail === 'string' ? detail : detail && typeof detail === 'object'
    ? ['code', 'type', 'message'].map(key => String((detail as Record<string, unknown>)[key] ?? '')).join(' ') : '';
  return /\b(?:insufficient[ _-]+(?:account[ _-]+)?(?:balance|credit|funds)|(?:account|balance|api[ _-]?key)[ _-]+(?:(?:is|has been)[ _-]+)?(?:disabled|suspended|invalid|exhausted|depleted)|invalid[ _-]+api[ _-]?key|account[ _-]+quota[ _-]+exceeded)\b|余额不足|账号(?:已|被)?(?:停用|禁用|冻结)/i.test(message);
}

function cooldown(attempt: number, retryAfter: string | undefined, now: number) {
  const header = retryAfter?.trim();
  const requested = header ? /^\d+(?:\.\d+)?$/.test(header) ? Math.ceil(Number(header) * 1000) : Date.parse(header) - now : 0;
  return Math.min(maxCooldownMs, Math.max(30_000 * 2 ** attempt, Number.isNaN(requested) ? 0 : requested));
}

export class SearchGateway {
  private readonly closing = new AbortController();
  private drained?: () => void;
  readonly active = new Map<string, number>();
  private constructor(readonly ledger: SearchLedger, private readonly limiter: GlobalLimiter,
    private readonly model: Gateway, private readonly directory: string, private readonly transport: SearchTransport,
    private readonly redactQuery: (query: SearchCall['query']) => SearchCall['query']) {}

  static async open(directory: string, config: EgressConfig, model: Gateway, transport: SearchTransport,
    redactQuery = (query: SearchCall['query']) => query, clock?: Clock) {
    const ledger = await new SearchLedger(directory, config).open();
    const path = join(directory, SEARCH_RATE);
    let text: string | undefined;
    try { text = await readFile(path, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (text && !text.endsWith('\n')) throw new Error('搜索限流记录不完整');
    const rows = (text ?? '').split('\n').filter(Boolean).map(line => JSON.parse(line)), reservations = [...ledger.reservations.values()];
    if (rows.length !== reservations.length || rows.some((row, i) => row.id !== reservations[i].id ||
      row.configId !== reservations[i].configId || !Number.isSafeInteger(row.at) || row.at < 0))
      throw new Error('搜索限流记录与账本不一致');
    if (text === undefined) await writeFile(path, '', {flag: 'wx', flush: true});
    const dispatch = config.searchDispatch!;
    const limiter = new GlobalLimiter(path, clock, {...dispatch, minIntervalMs: Math.ceil(60_000 / dispatch.requestsPerMinute), maxCooldownMs});
    await limiter.load();
    return new SearchGateway(ledger, limiter, model, directory, transport, redactQuery);
  }

  stop() { this.closing.abort(); this.limiter.stop(); }

  async drain() {
    if (this.active.size) await new Promise<void>(resolve => {this.drained = resolve;});
  }

  async invoke(call: SearchCall, client: AbortSignal) {
    const {configId, taskId, caseId, call: callIndex, query} = call, identity = {configId, taskId, caseId, call: callIndex};
    const signal = AbortSignal.any([client, this.model.stopSignal, this.closing.signal]);
    this.active.set(configId, (this.active.get(configId) ?? 0) + 1);
    let notBefore: number | undefined;
    try {
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (this.model.stopped) return searchError('run_stop', '模型出口已停止');
        let reservation: string | undefined;
        try {
          const result = await this.limiter.execute(async () => {
            if (this.model.stopped) throw modelStopped;
            reservation = await this.ledger.reserve(identity);
            return reservation;
          }, async id => {
            if (this.model.stopped) throw modelStopped;
            const start = this.limiter.clock.now();
            const attemptSignal = AbortSignal.any([signal, AbortSignal.timeout(SEARCH_ATTEMPT_TIMEOUT_MS)]);
            let response: SearchAttempt;
            try { response = await untilAborted(this.transport(query, attemptSignal), attemptSignal); }
            catch { response = {status: null, raw: null, incomplete: true}; }
            const apiMs = Math.max(0, this.limiter.clock.now() - start);
            const account = accountFailure(response);
            const status = response.status;
            const stopping = account ? this.model.halt('搜索账号或余额异常') : undefined;
            void stopping?.catch(() => {});
            if (!account && status === 429) await this.limiter.cooldown(cooldown(attempt, response.retryAfter, this.limiter.clock.now()), id, 'http_429', configId);
            const output = !account && !response.incomplete && status === 200 ? searchOutput(response.raw) : undefined;
            const rejected = !account && !response.incomplete && status !== null && status >= 400 && status < 500 && status !== 429;
            if (output || rejected) await this.ledger.settle(id, !!output?.organic_results.length);
            else await this.ledger.retain(id, account ? 'account' : 'unknown');
            const reply = output ? {ok: true as const, output} : account ? searchError('run_stop', '搜索账号或余额异常')
              : searchError('search_failed', rejected ? 'DeepSeek 拒绝了这次搜索' : '搜索暂时失败');
            await stopping;
            await writeNew(join(this.directory, 'search-records', id + '.json'), {
              ...identity, reservationId: id, attempt: attempt + 1, query: this.redactQuery(query), status, raw: response.raw,
              incomplete: response.incomplete === true, output: output ?? null, reply, apiMs,
            });
            return {reply, retry: !account && !output && !rejected, status, retryAfter: response.retryAfter};
          }, configId, notBefore, signal);
          if (!result.retry) return this.model.stopped && (result.reply.ok || result.reply.error.kind !== 'run_stop')
            ? searchError('run_stop', '模型出口已停止') : result.reply;
          if (this.model.stopped) return searchError('run_stop', '模型出口已停止');
          if (result.status !== 429 && attempt < maxRetries && !signal.aborted) {
            const delay = cooldown(attempt, result.retryAfter, this.limiter.clock.now());
            notBefore = await this.limiter.cooldown(delay, reservation!, 'transport', configId);
          }
          if (signal.aborted || attempt === maxRetries) return result.reply;
        } catch (error) {
          if (error === modelStopped || (signal.aborted && error === signal.reason)) {
            if (reservation && this.ledger.pending.has(reservation)) await this.ledger.retain(reservation, 'unknown');
            return this.model.stopped ? searchError('run_stop', '模型出口已停止') : searchError('search_failed', '搜索等待已取消或超时');
          }
          throw error;
        }
      }
      return searchError('search_failed', '搜索暂时失败');
    } catch (error) {
      const message = error instanceof Error && /^达到 search(?:MaxRequests|Cny) 上限$/.test(error.message)
        ? error.message : '搜索账本、限流或原始记录异常';
      await this.model.halt(message);
      return searchError('run_stop', message);
    } finally {
      const left = this.active.get(configId)! - 1;
      if (left) this.active.set(configId, left);
      else this.active.delete(configId);
      if (!this.active.size) this.drained?.();
    }
  }
}
