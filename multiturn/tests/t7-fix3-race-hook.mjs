import {registerHooks} from 'node:module';
import {appendFileSync} from 'node:fs';
const params=new URL(import.meta.url).searchParams,mode=params.get('mode'),out=params.get('out');
let used=false;
function mark(event,u,error){appendFileSync(out,JSON.stringify({event,ns:String(process.hrtime.bigint()),pid:u.child.pid,worker:u.id,connected:u.child.connected,exitCode:u.child.exitCode,error:error?.message})+'\n');}
globalThis.__crossPublish=(path,row)=>{if(String(path).includes('failures'))appendFileSync(out,JSON.stringify({event:'failure-published',ns:String(process.hrtime.bigint()),pid:process.pid,disposition:row.disposition,category:row.category})+'\n');};
if(mode==='fatal-reply'&&process.send){
 const send=process.send.bind(process);
 process.send=function(message,...rest){
   if(globalThis.__crossFatal&&message.protocol!=='bfcl:manage:1'){
     globalThis.__crossFatal=false;
     appendFileSync(out,JSON.stringify({event:'fatal-reply-send',ns:String(process.hrtime.bigint()),pid:process.pid,message})+'\n');
     const cb=typeof rest.at(-1)==='function'?rest.pop():undefined;
     return send(message,...rest,(...args)=>{cb?.(...args);appendFileSync(out,JSON.stringify({event:'self-kill-request',ns:String(process.hrtime.bigint()),pid:process.pid})+'\n');process.kill(process.pid,'SIGKILL');});
   }
   return send(message,...rest);
 };
}
globalThis.__crossRace=async(u,envelope,work)=>{
 if(used||envelope.node!=='INFER.REASONING.SAMPLE')return work();
 used=true;
 u.child.once('exit',()=>mark('exit-event',u));u.child.once('disconnect',()=>mark('disconnect-event',u));
 if(mode==='fatal-reply'){try{return await work();}catch(e){mark('invoke-rejected',u,e);throw e;}}
 if(mode==='before'){
   const pending=work();mark('kill-request',u);process.kill(u.child.pid,'SIGKILL');
   try{return await pending;}catch(e){mark('invoke-rejected',u,e);throw e;}
 }
 try {const value=await work();mark('invoke-returned',u);mark('kill-request',u);process.kill(u.child.pid,'SIGKILL');return value;}
 catch(e){mark('invoke-rejected',u,e);mark('kill-request',u);process.kill(u.child.pid,'SIGKILL');throw e;}
};
registerHooks({load(url,context,next){const r=next(url,context);
 if(url.endsWith('/src/ts/step-log.ts'))return {...r,source:String(r.source).replace('linkSync(temporary,path);','linkSync(temporary,path); globalThis.__crossPublish(path,row);')};
 if(url.endsWith('/src/ts/agent-core.ts')&&(mode==='after-call'||mode==='fatal-reply'))return {...r,source:String(r.source).replace('const target = executor(capability);','const target = executor(capability); if(node==="INFER.REASONING.SAMPLE"){globalThis.__crossFatal=true;throw new Error("cross fatal SAMPLE invocation");}')};
 if(!url.endsWith('/src/ts/deploy.ts'))return r;
 const needle='()=>ipc.invoke(envelope)';if(!String(r.source).includes(needle))throw new Error('missing injection target');
 return {...r,source:String(r.source).replace(needle,'()=>globalThis.__crossRace(u,envelope,()=>ipc.invoke(envelope))')};
}});
