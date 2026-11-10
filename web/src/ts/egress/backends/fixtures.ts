// 来源：旧 offlineTransport，保留完整请求匹配规则；末轮结束释放正文，缓存最多8题。
import { offlineTransport } from '../offline.ts';
import type { ModelSettings } from '../model_config.ts';
import type { SampleInput } from '../types.ts';
import { loadTask } from '../model_config.ts';
export async function fixturesBackend(settings:ModelSettings) {
  const fixture=await offlineTransport(settings);
  const recent=new Set<string>();
  return async(input:SampleInput,body:any,signal:AbortSignal)=>{
    const caseId=String(input.metadata!.caseId);
    recent.delete(caseId);recent.add(caseId);
    while(recent.size>8){const oldest=recent.values().next().value!;fixture.release(oldest);recent.delete(oldest);}
    const raw=await fixture.invoke(caseId,body,signal);
    if(input.metadata!.turn===(await loadTask(caseId)).question.length&&raw.choices?.[0]?.finish_reason==='stop'){
      fixture.release(caseId);recent.delete(caseId);
    }
    return raw;
  };
}
