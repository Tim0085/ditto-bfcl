import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { MODEL_ENDPOINT_PATH, MODEL_ENDPOINT_PROTOCOL, type ModelCallRequest, type ModelCallResponse } from '../model-endpoint.ts';
import { Gateway } from './gateway.ts';
import { inputLimitDetails, requestLimitDetails } from './retry.ts';
import { loadEgressConfig, validateConfig, type EgressConfig } from './config.ts';
import { fixturesBackend } from './backends/fixtures.ts';
import { replayBackend } from './backends/replay.ts';
import { liveBackend } from './backends/live.ts';
import type { Clock } from './limiter.ts';
import type { SampleInput } from './types.ts';
import { createJsonlWriter } from './common.ts';
import { SEARCH_ENDPOINT_PATH, SEARCH_REQUEST_TIMEOUT_MS, type SearchReply } from '../search-endpoint.ts';
import { SearchGateway, searchError, untilAborted, validSearchCall } from './search.ts';
import { fixtureSearch, liveSearch, type SearchTransport } from './backends/search.ts';

function searchBody(req: IncomingMessage, signal: AbortSignal) {
  return new Promise<unknown>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    const clean = () => {
      req.off('data', data); req.off('end', end); req.off('error', fail);
      signal.removeEventListener('abort', abort);
    };
    const fail = (error: unknown) => { clean(); req.resume(); reject(error); };
    const abort = () => fail(signal.reason);
    const data = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 1_887_436) { fail(new Error('搜索请求体过大')); return; }
      chunks.push(chunk);
    };
    const end = () => {
      clean();
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (error) { reject(error); }
    };
    req.on('data', data); req.once('end', end); req.once('error', fail);
    signal.addEventListener('abort', abort, {once: true});
    if (signal.aborted) abort();
  });
}

async function serveSearch(req: IncomingMessage, res: ServerResponse, gateway: Gateway, config: EgressConfig, search?: SearchGateway) {
  const client = new AbortController();
  res.once('close', () => client.abort());
  const deadline = AbortSignal.timeout(SEARCH_REQUEST_TIMEOUT_MS);
  const signal = AbortSignal.any([deadline, client.signal]);
  let reply: SearchReply;
  if (gateway.stopped) reply = searchError('run_stop', '模型出口已停止');
  else if (config.backend === 'replay' || !search) {
    const message = config.backend === 'replay' ? '回放模式收到意外的搜索请求' : '搜索入口未配置';
    await gateway.halt(message);
    reply = searchError('run_stop', message);
  } else {
    let call: unknown;
    const contentType = req.headers['content-type']?.split(';', 1)[0].trim().toLowerCase();
    if (req.method === 'POST' && contentType === 'application/json') {
      try { call = await searchBody(req, AbortSignal.any([signal, gateway.stopSignal])); } catch { /* No valid request body. */ }
    }
    if (gateway.stopped) reply = searchError('run_stop', '模型出口已停止');
    else if (deadline.aborted) reply = searchError('search_failed', '搜索请求超时');
    else if (!validSearchCall(call)) reply = searchError('invalid_argument', '搜索请求协议、身份或参数不合规');
    else {
      try { reply = await untilAborted(search.invoke(call, signal), signal); }
      catch (error) {
        if (!signal.aborted || error !== signal.reason) await gateway.halt('搜索账本或停止记录异常').catch(() => {});
        reply = gateway.stopped ? searchError('run_stop', '模型出口已停止') : searchError('search_failed', '搜索请求超时');
      }
    }
  }
  req.resume();
  if (!res.destroyed) { res.writeHead(200, {'content-type': 'application/json'}); res.end(JSON.stringify(reply)); }
}
export async function startEgress(config:EgressConfig,output:string,options:{host?:string;port?:number;live?:boolean;testUrl?:string;credentials?:Record<string,string|undefined>;clock?:Clock;searchTransport?:SearchTransport}={}){
  validateConfig(config);await mkdir(output,{recursive:true});
  const transport=config.backend==='fixtures'?await fixturesBackend(config.settings):config.backend==='replay'?await replayBackend(config.replay!,output):liveBackend(config.settings,options);
  if (options.live && (!options.credentials || options.searchTransport)) throw new Error('真实搜索需要保护器凭据且不接受测试传输');
  const searchBackend = options.live ? liveSearch(config.settings, options.credentials!) : {transport: options.searchTransport ?? fixtureSearch, redactQuery: undefined};
  const gateway=await Gateway.open(output,config,transport,options.clock);
  let search: SearchGateway | undefined;
  try {
    if (config.searchPath && config.backend !== 'replay')
      search = await SearchGateway.open(output, config, gateway, searchBackend.transport, searchBackend.redactQuery, options.clock);
  } catch (error) {
    try { await gateway.halt('搜索账本或限流启动校验失败'); } finally { gateway.close(); }
    throw error;
  }
  const recordCall=createJsonlWriter(join(output,'calls.jsonl'));
  const server=createServer({requestTimeout: SEARCH_REQUEST_TIMEOUT_MS + 1}, async(req,res)=>{
    if (req.url === SEARCH_ENDPOINT_PATH) {
      try { await serveSearch(req, res, gateway, config, search); }
      catch {
        if (!res.destroyed && !res.headersSent) {
          res.writeHead(200, {'content-type': 'application/json'});
          res.end(JSON.stringify(searchError('run_stop', '搜索停止记录写入失败')));
        }
      }
      return;
    }
    if(req.method!=='POST'||req.url!==MODEL_ENDPOINT_PATH){res.writeHead(404);res.end();return;}
    let identity:any={configId:'__invalid__'};
    const cancellation=new AbortController();
    res.once('close',()=>{if(!res.writableEnded)cancellation.abort(new Error('模型客户端已断开'));});
    let response:ModelCallResponse;
    try{
      // 输入上限只按旧 buildRequest 的最终请求体判断，不能另加信封阈值改变终态分类。
      const chunks:Buffer[]=[];
      for await(const chunk of req)chunks.push(chunk);
      const call=JSON.parse(Buffer.concat(chunks).toString('utf8')) as ModelCallRequest;
      identity={configId:call.configId,taskId:call.taskId,caseId:call.caseId,turn:call.turn,step:call.step};
      if(call.protocol!==MODEL_ENDPOINT_PROTOCOL||!call.input)throw new Error('模型出口协议不匹配');
      for(const key of ['configId','taskId','caseId'] as const)if(typeof call[key]!=='string'||!call[key].trim()||call.input.metadata?.[key]!==call[key])throw new Error('模型调用身份不匹配');
      for(const key of ['turn','step'] as const)if(!Number.isSafeInteger(call[key])||call[key]<1||call.input.metadata?.[key]!==call[key])throw new Error('模型调用位置不匹配');
      const result=await gateway.invoke(call.input as SampleInput,cancellation.signal);
      response={ok:true,output:result as any};
    }catch(error){
      const input=inputLimitDetails(error),request=requestLimitDetails(error);
      if(input)response={ok:false,error:{kind:'input_limit',message:'模型输入超过上限',details:input}};
      else if(request)response={ok:false,error:{kind:'request_limit',message:'本题请求次数达到上限',details:request}};
      else {await gateway.halt();response={ok:false,error:{kind:'run_stop',message:error instanceof Error?error.message:'模型出口异常'}};}
    }
    try{await recordCall({...identity,configId:typeof identity.configId==='string'?identity.configId:'__invalid__',ok:response.ok,...(!response.ok?{error:response.error}:{})});}
    catch{await gateway.halt();response={ok:false,error:{kind:'run_stop',message:'调用记录写入失败'}};}
    res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(response));
  });
  try{await new Promise<void>((yes,no)=>{server.once('error',no);server.listen(options.port??0,options.host??'127.0.0.1',yes);});}
  catch(error){search?.stop();gateway.close();throw error;}
  const address=server.address() as {port:number};
  return {gateway,search,server,url:`http://${options.host??'127.0.0.1'}:${address.port}${MODEL_ENDPOINT_PATH}`,async close(){search?.stop();await new Promise<void>((yes,no)=>server.close(error=>error?no(error):yes()));await search?.drain();gateway.close();}};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const {values}=parseArgs({options:{backend:{type:'string'},host:{type:'string',default:'127.0.0.1'},port:{type:'string',default:'8787'},config:{type:'string'},output:{type:'string'},live:{type:'boolean',default:false},'test-url':{type:'string'}}});
  // T9 C2: this old entry took the key from the environment and loads no live guard. Real mode starts only from the scheduler.
  if(values.live)throw new Error('server.ts 不接受 --live：真实模式请用 scripts/t8a.ts run --live（或 scripts/t8a-stage.ps1 -Live）');
  if(!values.config||!values.output||!values.backend)throw new Error('需要 --backend --config --output');
  const config=await loadEgressConfig(values.config,values.backend as EgressConfig['backend']);
  const service=await startEgress(config,resolve(values.output),{host:values.host,port:Number(values.port),live:values.live,testUrl:values['test-url']});
  console.log(JSON.stringify({ready:true,pid:process.pid,url:service.url,backend:config.backend}));
  process.once('SIGTERM',()=>void service.close());process.once('SIGINT',()=>void service.close());
  // 只供启动本进程的离线测试父进程优雅收尾；不接管任何既有窗口或进程。
  if(process.send)process.once('message',message=>{if(message==='shutdown')void service.close().then(()=>process.disconnect());});
}
