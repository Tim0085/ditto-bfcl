import https from 'node:https';
import { credentials, type ModelSettings } from '../model_config.ts';
import { keyRedactor, redactParsed } from './live.ts';
import { SEARCH_UPSTREAM_PATH, type SearchCall, type SearchOutput } from '../../search-endpoint.ts';

export interface SearchAttempt {
  status: number | null;
  raw: string | null;
  incomplete?: boolean;
  retryAfter?: string;
}
export type SearchTransport = (query: SearchCall['query'], signal: AbortSignal) => Promise<SearchAttempt>;

export function searchAddress(baseUrl: string) {
  const base = new URL(baseUrl), search = new URL(SEARCH_UPSTREAM_PATH, base);
  if (search.protocol !== 'https:' || search.hostname !== base.hostname || search.port !== base.port)
    throw new Error('搜索地址必须与模型地址共用同一 HTTPS 主机和端口');
  return search;
}

export function liveSearch(settings: ModelSettings, values: Record<string, string | undefined>) {
  const { baseUrl, apiKey } = credentials(settings, values);
  const address = searchAddress(baseUrl);
  const redact = keyRedactor(apiKey);
  const redactRaw = (raw: string) => {
    const safe = redact(raw.split(JSON.stringify(apiKey).slice(1, -1)).join('[REDACTED]'));
    try {
      const parsed = JSON.parse(safe), before = JSON.stringify(parsed);
      const after = JSON.stringify(redactParsed(parsed, redact));
      return before === after ? safe : after;
    } catch { return safe; }
  };
  const transport: SearchTransport = (query, signal) => new Promise(resolve => {
    const body = JSON.stringify({query: query.keywords, count: query.max_results, need_content: false});
    let status: number | null = null, retryAfter: string | undefined;
    const chunks: Buffer[] = [];
    let size = 0;
    const limit = 8 * 1024 * 1024;
    let finished = false;
    const finish = (incomplete: boolean) => {
      if (finished) return;
      finished = true;
      signal.removeEventListener('abort', abort);
      resolve({status, retryAfter, incomplete, raw: status === null ? null : redactRaw(Buffer.concat(chunks).toString('utf8'))});
    };
    const abort = () => finish(true);
    const request = https.request(address, {method: 'POST', signal, headers: {
      'Authorization': `Bearer ${apiKey}`, 'Accept-Encoding': 'identity', 'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    }}, response => {
      status = response.statusCode ?? null;
      retryAfter = typeof response.headers['retry-after'] === 'string' ? response.headers['retry-after'] : undefined;
      response.on('error', () => finish(true));
      if ((response.headers['content-encoding'] ?? 'identity').trim().toLowerCase() !== 'identity') {
        finish(true); response.destroy(); return;
      }
      response.on('data', (chunk: Buffer) => {
        const remaining = limit - size;
        chunks.push(chunk.subarray(0, remaining));
        size += Math.min(remaining, chunk.length);
        if (chunk.length > remaining) { finish(true); response.destroy(); }
      });
      response.on('end', () => finish(false));
    });
    request.on('error', () => finish(true));
    signal.addEventListener('abort', abort, {once: true});
    if (signal.aborted) abort();
    request.end(body);
  });
  return {transport, redactQuery: (query: SearchCall['query']) => ({...query, keywords: redactParsed(query.keywords, redact) as string})};
}

export const fixtureSearch: SearchTransport = async () => ({
  status: 200, raw: '{"results":[{"title":"BFCL Web fixture","url":"https://example.invalid/fixture","snippet":"Offline fixture"}]}',
});

export function searchOutput(raw: string | null): SearchOutput | undefined {
  if (raw === null) return;
  try {
    const results = JSON.parse(raw)?.results;
    if (Array.isArray(results) && results.every(row => row && ['title', 'url', 'snippet'].every(key => typeof row[key] === 'string')))
      return {organic_results: results.map(({title, url, snippet}) => ({title, link: url, snippet}))};
  } catch { /* Invalid JSON leaves the reservation unknown. */ }
}
