import { createServer } from 'node:http';
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
export async function startEgress(config:EgressConfig,output:string,options:{host?:string;port?:number;live?:boolean;testUrl?:string;credentials?:Record<string,string|undefined>;clock?:Clock}={}){
  validateConfig(config);await mkdir(output,{recursive:true});
  const transport=config.backend==='fixtures'?await fixturesBackend(config.settings):config.backend==='replay'?await replayBackend(config.replay!,output):liveBackend(config.settings,options);
  const gateway=await Gateway.open(output,config,transport,options.clock);
  const recordCall=createJsonlWriter(join(output,'calls.jsonl'));
  const server=createServer(async(req,res)=>{
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
  catch(error){gateway.close();throw error;}
  const address=server.address() as {port:number};
  return {gateway,server,url:`http://${options.host??'127.0.0.1'}:${address.port}${MODEL_ENDPOINT_PATH}`,async close(){await new Promise<void>((yes,no)=>server.close(error=>error?no(error):yes()));gateway.close();}};
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
