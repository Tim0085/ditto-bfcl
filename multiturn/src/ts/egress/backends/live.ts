// 来源：旧 model.ts 的 HTTP 与错误规则。使用 Node 内置 HTTP，避免新增 undici 依赖及隐含300秒时限。
import http from 'node:http';
import https from 'node:https';
import { Readable } from 'node:stream';
import { credentials, type ModelSettings } from '../model_config.ts';
import { ModelTransportError, providerError } from '../model.ts';
import type { SampleInput } from '../types.ts';
// T9 C2: the key as a reply may carry it besides its plain text. JSON \uXXXX escapes need no form of their own: replies are
// redacted after JSON.parse, string by string and key by key. Base64 is matched at all three byte alignments (only the
// characters that depend on key bytes alone), so the key is found inside a longer Base64 text too. Changed case and
// truncated keys are not recognized.
function keyForms(key:string){
  const bytes=Buffer.from(key,'utf8'),derived:string[]=[];
  for(const variant of ['base64','base64url'] as const)for(let shift=0;shift<3;shift++){
    const text=Buffer.concat([Buffer.alloc(shift),bytes]).toString(variant);
    derived.push(text.slice(Math.ceil(shift*4/3),Math.floor((shift+bytes.length)*4/3)));
  }
  const percent=[...bytes].map(b=>'%'+b.toString(16).padStart(2,'0')).join('');
  derived.push(percent,percent.toUpperCase());
  // The key and its encodeURIComponent form always count; a derived form only when it is long enough to mean the key.
  const forms=new Set([key,encodeURIComponent(key),...derived.filter(form=>form.length>=8)]);
  return [...forms].filter(Boolean).sort((a,b)=>b.length-a.length);
}
export function keyRedactor(key:string){
  if(!key)return (text:string)=>text;
  const forms=keyForms(key),percent=new RegExp([...Buffer.from(key,'utf8')].map(b=>'%'+b.toString(16).padStart(2,'0')).join(''),'gi');
  return (text:string)=>{for(const form of forms)if(text.includes(form))text=text.split(form).join('[REDACTED]');return text.replace(percent,'[REDACTED]');};
}
// T9 C3: a string that is itself JSON text (tool arguments are) is parsed and redacted again, so a key written with \uXXXX
// escapes inside that inner text is found too; at most 4 such nested layers. The text is rewritten (JSON.stringify of the
// redacted value) only when something inside it changed; otherwise it stays exactly as it was. Request bodies are untouched.
const nestedJsonLayers=4;
function redactText(text:string,redact:(text:string)=>string,layer:number):string{
  const out=redact(text);
  if(layer>=nestedJsonLayers||!/^\s*[[{"]/.test(out))return out;
  let inner:unknown;try{inner=JSON.parse(out);}catch{return out;}
  const before=JSON.stringify(inner),after=JSON.stringify(redactParsed(inner,redact,layer+1));
  return after===before?out:after;
}
/** Every string value and every key name of a parsed reply; objects are rebuilt only when a key name changes. */
export function redactParsed(value:unknown,redact:(text:string)=>string,layer=0):unknown{
  if(typeof value==='string')return redactText(value,redact,layer);
  if(Array.isArray(value)){for(let i=0;i<value.length;i++){const next=redactParsed(value[i],redact,layer);if(next!==value[i])value[i]=next;}return value;}
  if(value&&typeof value==='object'){
    const object=value as Record<string,unknown>,keys=Object.keys(object),name=(key:string)=>redactText(key,redact,layer);
    if(keys.some(key=>name(key)!==key)){
      const out:Record<string,unknown>={};
      for(const key of keys)Object.defineProperty(out,name(key),{value:redactParsed(object[key],redact,layer),enumerable:true,writable:true,configurable:true});
      return out;
    }
    for(const key of keys){const next=redactParsed(object[key],redact,layer);if(next!==object[key])object[key]=next;}
  }
  return value;
}
export function liveBackend(settings:ModelSettings, options:{live?:boolean;testUrl?:string;credentials?:Record<string,string|undefined>}={}) {
  let baseUrl:string,apiKey='';
  if(options.live&&options.testUrl)throw new Error('真实模式和假服务不可同时启用');
  if(options.testUrl){
    const u=new URL(options.testUrl);
    if(u.protocol!=='http:'||u.hostname!=='127.0.0.1'||u.username||u.password||u.search||u.hash)throw new Error('假服务只允许127.0.0.1 HTTP');
    baseUrl=options.testUrl.replace(/\/+$/,'');
  }else{
    if(!options.live)throw new Error('真实出口必须显式 --live；离线测试用 --test-url');
    ({baseUrl,apiKey}=credentials(settings,options.credentials));
  }
  const endpoint=new URL(baseUrl+(settings.model.protocol==='responses'?'/responses':'/chat/completions'));
  const redact=keyRedactor(apiKey),secrets=apiKey?[...keyForms(apiKey)]:[];
  return async(_input:SampleInput,body:any,signal:AbortSignal):Promise<any>=>{
    const requestSignal=AbortSignal.any([signal,AbortSignal.timeout(settings.model.timeoutMs)]);
    const response=await new Promise<Response>((resolve,reject)=>{
      let phase:'fetch'|'read_json'='fetch';
      const failed=(error:unknown)=>reject(new ModelTransportError('模型连接或响应读取失败，保留预留费用',phase,
        requestSignal.aborted?requestSignal.reason:error,undefined,{cancelled:signal.aborted&&signal.reason?.name!=='TimeoutError'}));
      const req=(endpoint.protocol==='https:'?https:http).request(endpoint,{method:'POST',signal:requestSignal,
        headers:{'Content-Type':'application/json',...(apiKey?{Authorization:`Bearer ${apiKey}`}:{})}},res=>{
        phase='read_json';const headers=new Headers();
        for(const [key,value]of Object.entries(res.headers))if(value!==undefined)headers.set(key,Array.isArray(value)?value.join(','):value);
        const noBody=[204,205,304].includes(res.statusCode!);if(noBody)res.resume();
        resolve(new Response(noBody?null:Readable.toWeb(res) as ReadableStream<Uint8Array>,{status:res.statusCode!,headers}));
      });
      req.on('error',failed);req.end(JSON.stringify(body));
    });
    if(response.status<200||response.status>=300){
      const header=response.headers.get('retry-after');
      const delay=header===null?undefined:/^\d+(?:\.\d+)?$/.test(header.trim())?Math.ceil(Number(header)*1000):Math.max(0,Date.parse(header)-Date.now());
      // The key forms go in with the original two secrets, so they are cut out before providerError shortens the text;
      // the case-insensitive percent form is applied once more to what it returns.
      const diagnostic=redactParsed(await providerError(response,[apiKey,baseUrl,...secrets]),redact) as Awaited<ReturnType<typeof providerError>>;
      throw new ModelTransportError(`模型接口 HTTP ${response.status}`,'http',undefined,response.status,{retryAfterMs:delay,providerError:diagnostic});
    }
    try {
      // 原始回复也先脱敏，Gateway 不必读取任何凭据。
      let text=await response.text();
      if(apiKey)text=text.split(JSON.stringify(apiKey).slice(1,-1)).join('[REDACTED]');
      // T9 C2: and after parsing, every string and key name, so escaped or encoded copies of the key are caught too.
      return redactParsed(JSON.parse(text),redact);
    }catch(error){throw new ModelTransportError('模型接口没有返回有效 JSON；保留预留费用','read_json',requestSignal.aborted?requestSignal.reason:error,undefined,{cancelled:signal.aborted&&signal.reason?.name!=='TimeoutError'});}
  };
}
