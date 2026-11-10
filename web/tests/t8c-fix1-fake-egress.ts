import {createServer} from 'node:net';
import {randomBytes} from 'node:crypto';
import {resolve,join} from 'node:path';
import {control} from '../src/ts/scheduler/control.ts';
import {json,read,now} from '../src/ts/scheduler/io.ts';
const root=resolve(process.argv[2]),mode=process.argv[3],runId=read(join(root,'plan.json')).runId;
let close:()=>void;
if(mode==='stall-control'){
  const server=createServer(socket=>{socket.on('error',()=>{});});await new Promise<void>((yes,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',yes);});
  json(join(root,'scheduler/egress/control.json'),{host:'127.0.0.1',port:(server.address() as any).port,pid:process.pid,identity:runId+'/egress',startedAt:now(),token:randomBytes(32).toString('hex')});close=()=>server.close();
}else{
  const channel=await control(join(root,'scheduler/egress'),runId+'/egress',()=>{clearInterval(timer);channel.close();});close=()=>channel.close();
}
const status=()=>json(join(root,'egress/status.json'),{pid:process.pid,at:Date.now(),active:{'direct-c1':mode==='stall-control'?1:0},peak:{},url:'http://127.0.0.1:1'});
const timer=setInterval(status,50);status();
process.once('SIGTERM',()=>{clearInterval(timer);close();});console.log('ready');
