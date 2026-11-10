export const SEARCH_ENDPOINT_PATH = '/v1/search';
export const SEARCH_UPSTREAM_PATH = '/v1/tools/search';
export const SEARCH_ENDPOINT_PROTOCOL = 'bfcl-web-search-v1';
export const SEARCH_REQUEST_TIMEOUT_MS = 600_000;
export const SEARCH_ATTEMPT_TIMEOUT_MS = 60_000;

export interface SearchCall {
  protocol: typeof SEARCH_ENDPOINT_PROTOCOL;
  configId: string;
  taskId: string;
  caseId: string;
  call: number;
  query: {keywords: string; max_results: number; region: 'wt-wt'};
}

export interface SearchOutput {
  organic_results: {title: string; link: string; snippet: string}[];
}

export type SearchReply = {ok: true; output: SearchOutput}
  | {ok: false; error: {kind: 'invalid_argument' | 'search_failed' | 'run_stop'; message: string}};
