import { readFile } from 'node:fs/promises';
import type { ModelSettings, DispatchPolicy } from './model_config.ts';
import { workerTimeouts } from './model_config.ts';
export interface EgressConfig {
  version: 1;
  backend: 'fixtures' | 'replay' | 'live';
  mode: 'offline-reference' | 'live';
  debug: true;
  settings: ModelSettings;
  perTaskRequests: number;
  retryPolicy: {maxRetries: number};
  dispatchPolicy: DispatchPolicy;
  replay?: {source: string; index: string; failOnDifference: boolean};
}
export async function loadEgressConfig(path:string, backend:EgressConfig['backend']):Promise<EgressConfig> {
  const value=JSON.parse(await readFile(path,'utf8'));
  value.backend=backend;value.mode=backend==='live'?'live':'offline-reference';value.debug=true;
  value.settings.model.timeoutMs??=600000;
  validateConfig(value);return value;
}
export function validateConfig(c:EgressConfig) {
  const m=c.settings?.model,b=c.settings?.budget,p=c.dispatchPolicy;
  if(c.version!==1||!['fixtures','replay','live'].includes(c.backend)||!m||!b||!p)throw new Error('出口配置不完整');
  if(!['chat-completions','responses'].includes(m.protocol)||!m.model||!m.reasoningEffort)throw new Error('模型配置不完整');
  for(const n of [m.maxInputTokens,m.maxOutputTokens,m.timeoutMs,m.maxRequestBytes??8388608,b.maxRequests,c.perTaskRequests,p.maxInFlight,p.requestsPerMinute,p.maxCooldownMs])
    if(!Number.isSafeInteger(n)||n<1)throw new Error('请求、超时、限流上限必须为正整数');
  if(m.timeoutMs>2147483647||p.maxCooldownMs>900000||!Number.isSafeInteger(p.minIntervalMs)||p.minIntervalMs<Math.ceil(60000/p.requestsPerMinute)||p.minIntervalMs>60000)throw new Error('超时或发送间隔无效');
  if(!Number.isSafeInteger(c.retryPolicy?.maxRetries)||c.retryPolicy.maxRetries<0||c.retryPolicy.maxRetries>2)throw new Error('最多允许2次重试');
  workerTimeouts(m.timeoutMs,c.retryPolicy.maxRetries,p);
  if(c.mode!==(c.backend==='live'?'live':'offline-reference')||c.debug!==true)throw new Error('后端模式或原始记录配置无效');
  for(const n of [b.referenceUsd,m.referencePrice?.inputPerMillion,m.referencePrice?.outputPerMillion])if(typeof n!=='number'||!Number.isFinite(n)||n<=0)throw new Error('金额和单价尚未填写');
  if(m.baseUrl!==''||!(/^[A-Z][A-Z0-9_]*$/).test(m.apiKeyEnv)||!(/^[A-Z][A-Z0-9_]*$/).test(m.baseUrlEnv))throw new Error('凭据只能使用环境变量名');
  if(c.backend==='replay'&&(!c.replay?.source||!c.replay.index||typeof c.replay.failOnDifference!=='boolean'))throw new Error('缺少回放配置');
}
