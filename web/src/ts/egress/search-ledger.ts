import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createJsonlWriter, digest } from './common.ts';
import type { EgressConfig } from './config.ts';
import type { SearchCall } from '../search-endpoint.ts';

export const SEARCH_LEDGER = 'search-ledger.jsonl';
export const SEARCH_RATE = 'search-rate.jsonl';
export const SEARCH_MICRO_CNY = 5_000;
type Identity = Pick<SearchCall, 'configId' | 'taskId' | 'caseId' | 'call'>;
type Reservation = Identity & {kind: 'reserve'; id: string; microCny: number};
type Settlement = {kind: 'settle'; id: string; microCny: number};
type Retention = {kind: 'retain_failed'; id: string; heldMicroCny: number; reason: 'unknown' | 'account' | 'recovery'};
type Event = Reservation | Settlement | Retention;

export class SearchLedger {
  readonly reservations = new Map<string, Reservation>();
  readonly pending = new Map<string, Reservation>();
  readonly settlements = new Map<string, Settlement>();
  readonly retained = new Map<string, Retention>();
  private spentMicroCny = 0;
  private readonly path: string;
  private readonly write: ReturnType<typeof createJsonlWriter>;
  private readonly header: {kind: 'header'; version: 1; configHash: string; maxRequests: number; limitMicroCny: number};

  constructor(directory: string, config: EgressConfig) {
    this.path = join(directory, SEARCH_LEDGER);
    this.write = createJsonlWriter(this.path);
    this.header = {kind: 'header', version: 1, configHash: digest(config),
      maxRequests: config.searchMaxRequests!, limitMicroCny: Math.floor(config.searchCny! * 1e6)};
  }

  async open(recover = false) {
    let created = false;
    try {
      if (!recover) {
        await writeFile(this.path, JSON.stringify(this.header) + '\n', {flag: 'wx', flush: true});
        created = true;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    if (!created) {
      const text = await readFile(this.path, 'utf8');
      if (!text.endsWith('\n')) throw new Error('搜索账本记录不完整');
      const [first, ...events] = text.trimEnd().split('\n');
      const header = JSON.parse(first);
      if (JSON.stringify(header) !== JSON.stringify(this.header)) throw new Error('搜索账本配置与冻结计划不一致');
      for (const line of events) this.apply(JSON.parse(line));
    }
    if (!recover && this.pending.size) throw new Error('搜索账本存在未结算请求，拒绝自动重跑');
    return this;
  }

  private checkCapacity() {
    if (this.reservations.size >= this.header.maxRequests) throw new Error('达到 searchMaxRequests 上限');
    const occupied = this.spentMicroCny + (this.pending.size + this.retained.size) * SEARCH_MICRO_CNY;
    if (SEARCH_MICRO_CNY > this.header.limitMicroCny - occupied) throw new Error('达到 searchCny 上限');
  }

  private apply(event: Event) {
    if (typeof event?.id !== 'string' || !event.id) throw new Error('搜索账本请求 ID 无效');
    if (event.kind === 'reserve') {
      this.checkCapacity();
      if (this.reservations.has(event.id) || event.microCny !== SEARCH_MICRO_CNY ||
          [event.configId, event.taskId, event.caseId].some(value => typeof value !== 'string' || !value.trim()) ||
          !Number.isSafeInteger(event.call) || event.call < 1) throw new Error('搜索预留记录无效');
      this.reservations.set(event.id, event);
      this.pending.set(event.id, event);
      return;
    }
    if (!this.pending.has(event.id)) throw new Error('搜索账本缺少对应的未结算预留');
    if (event.kind === 'settle' && (event.microCny === 0 || event.microCny === SEARCH_MICRO_CNY)) {
      this.settlements.set(event.id, event);
      this.spentMicroCny += event.microCny;
    } else if (event.kind === 'retain_failed' && event.heldMicroCny === SEARCH_MICRO_CNY &&
        ['unknown', 'account', 'recovery'].includes(event.reason)) {
      this.retained.set(event.id, event);
    } else throw new Error('搜索账本结算或保留记录无效');
    this.pending.delete(event.id);
  }

  private async append(event: Event) {
    await this.write(event);
    this.apply(event);
  }

  // The limiter serializes reservations. No transport starts before both durable records exist.
  async reserve(identity: Identity) {
    this.checkCapacity();
    const id = randomUUID();
    await this.append({kind: 'reserve', id, ...identity, microCny: SEARCH_MICRO_CNY});
    return id;
  }

  settle(id: string, charged: boolean) {
    return this.append({kind: 'settle', id, microCny: charged ? SEARCH_MICRO_CNY : 0});
  }

  retain(id: string, reason: Retention['reason']) {
    return this.append({kind: 'retain_failed', id, heldMicroCny: SEARCH_MICRO_CNY, reason});
  }

  snapshot() {
    return {requests: this.reservations.size, settled: this.settlements.size, pending: this.pending.size,
      retained: this.retained.size, spentMicroCny: this.spentMicroCny, reservedMicroCny: this.pending.size * SEARCH_MICRO_CNY,
      retainedMicroCny: this.retained.size * SEARCH_MICRO_CNY, maxRequests: this.header.maxRequests,
      limitMicroCny: this.header.limitMicroCny};
  }
}
