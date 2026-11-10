import {createServer,createConnection} from 'node:net';
import {randomBytes,createHmac} from 'node:crypto';
import {join} from 'node:path';
import {json,log,now,read} from './io.ts';
export interface Endpoint {host:'127.0.0.1';port:number;token:string;pid:number;identity:string;startedAt:string}
export async function control(directory:string,identity:string,stop:()=>void|Promise<void>){
  const token=randomBytes(32).toString('hex'),startedAt=now();
  const server=createServer(socket=>{
    socket.unref();socket.setTimeout(3000,()=>socket.destroy());socket.on('error',()=>{});
    const nonce=randomBytes(16).toString('hex'),proof=createHmac('sha256',token).update(identity+'/'+process.pid+'/'+nonce).digest('hex');
    socket.write(JSON.stringify({identity,pid:process.pid,nonce,proof})+'\n');let text='';
    socket.on('data',bytes=>{text+=bytes;if(text.length>8192){log(join(directory,'control.jsonl'),{at:now(),kind:'rejected',reason:'oversize'});socket.destroy();return;}
      if(!text.includes('\n'))return;let message:any;try{message=JSON.parse(text.trim());}catch{}
      if(message?.token!==token||message?.command!=='stop'||Object.keys(message).sort().join()!=='command,token'){
        log(join(directory,'control.jsonl'),{at:now(),kind:'rejected',reason:'invalid message or token'});socket.end('{"ok":false}\n');return;}
      log(join(directory,'control.jsonl'),{at:now(),kind:'planned-stop'});socket.end('{"ok":true}\n',()=>{void stop();});
    });
  });
  await new Promise<void>((yes,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',yes);});
  const endpoint:Endpoint={host:'127.0.0.1',port:(server.address() as any).port,token,pid:process.pid,identity,startedAt};
  json(join(directory,'control.json'),endpoint);server.unref();return {endpoint,close:()=>server.close()};
}
export async function connect(directory:string,stop=false):Promise<Endpoint>{
  const endpoint=read<Endpoint>(join(directory,'control.json'));
  if(endpoint.host!=='127.0.0.1')throw new Error('Non-local control address');
  await new Promise<void>((yes,no)=>{
    const socket=createConnection({host:endpoint.host,port:endpoint.port});let text='',authenticated=false,finished=false;
    const end=(error?:Error)=>{if(finished)return;finished=true;socket.destroy();error?no(error):yes();};
    socket.setTimeout(3000,()=>end(new Error('Control timeout')));socket.on('error',end);socket.on('end',()=>{if(!finished)end(new Error('Control closed'));});
    socket.on('data',bytes=>{text+=bytes;if(text.length>16384)return end(new Error('Invalid control reply'));
      while(text.includes('\n')){const index=text.indexOf('\n'),line=text.slice(0,index);text=text.slice(index+1);let msg:any;try{msg=JSON.parse(line);}catch{return end(new Error('Invalid control JSON'));}
        if(!authenticated){if(msg.identity!==endpoint.identity||msg.pid!==endpoint.pid||msg.proof!==createHmac('sha256',endpoint.token).update(endpoint.identity+'/'+endpoint.pid+'/'+msg.nonce).digest('hex'))return end(new Error('Control identity mismatch'));authenticated=true;if(!stop)return end();socket.write(JSON.stringify({token:endpoint.token,command:'stop'})+'\n');}
        else return end(msg.ok===true?undefined:new Error('Stop rejected'));
      }
    });
  });return endpoint;
}
