import {join} from 'node:path';
import type {Plan} from './plan.ts';
import {jsonRows} from './export-stream.ts';
import {SEARCH_LEDGER, SEARCH_MICRO_CNY} from '../egress/search-ledger.ts';

type Totals = {attempts: number; charged: number; unknown: number};
const empty = (): Totals => ({attempts: 0, charged: 0, unknown: 0});
const yuan = SEARCH_MICRO_CNY / 1e6;
export function searchColumns(totals: Totals | null) {
  return {searchAttempts: totals?.attempts ?? null, searchChargedRequests: totals?.charged ?? null,
    searchUnknownRequests: totals?.unknown ?? null, searchCny: totals ? totals.charged * yuan : null,
    searchUnknownHeldCny: totals ? totals.unknown * yuan : null};
}

export function exportSearchLedger(root: string, plan: Plan) {
  const blocks = new Map<string, Totals>(), tasks = new Map<string, {configId: string; caseId: string; counts: Totals; block: Totals}>();
  for (const job of plan.jobs) for (const unit of job.units) {
    const block = empty();
    blocks.set(job.key + '/' + unit.configId, block);
    for (const caseId of unit.caseIds) tasks.set(`${plan.runId}/${unit.configId}/r${job.round}/${caseId}`, {configId: unit.configId, caseId: 'web_search_' + caseId.split('_').at(-1), counts: empty(), block});
  }
  const pending = new Map<string, Totals[]>(), seen = new Set<string>();
  let available = false;
  for (const row of jsonRows(join(root, 'egress', SEARCH_LEDGER), true)) {
    if (!available) {
      if (row?.kind !== 'header' || row.version !== 1) throw new Error('搜索账本缺少有效文件头');
      available = true;
      continue;
    }
    if (row?.kind === 'reserve') {
      const scope = tasks.get(row.taskId);
      if (!scope || scope.configId !== row.configId || scope.caseId !== row.caseId || row.microCny !== SEARCH_MICRO_CNY ||
        typeof row.id !== 'string' || !row.id || seen.has(row.id)) throw new Error('搜索账本预留身份无效或不在冻结计划中');
      seen.add(row.id);
      const own = [scope.counts, scope.block];
      for (const counts of own) counts.attempts++;
      pending.set(row.id, own);
      continue;
    }
    const own = pending.get(row?.id);
    if (!own) throw new Error('搜索账本终态缺少预留');
    if (row.kind === 'settle' && [0, SEARCH_MICRO_CNY].includes(row.microCny)) {
      if (row.microCny > 0) for (const counts of own) counts.charged++;
    } else if (row.kind === 'retain_failed' && row.heldMicroCny === SEARCH_MICRO_CNY) {
      for (const counts of own) counts.unknown++;
    } else throw new Error('搜索账本终态无效');
    pending.delete(row.id);
  }
  for (const own of pending.values()) for (const counts of own) counts.unknown++;
  return {
    block(key: string) { return searchColumns(available ? blocks.get(key) ?? null : null); },
    task(taskId: string, observed: boolean) {
      const counts = tasks.get(taskId)?.counts;
      return searchColumns(available && counts && (observed || counts.attempts > 0) ? counts : null);
    },
  };
}
