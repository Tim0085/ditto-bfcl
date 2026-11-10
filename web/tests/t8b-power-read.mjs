import { spawn } from 'node:child_process';
const args=process.argv.slice(2);
if(!['/requests','/query','/qh'].includes(args[0]))throw Error('Read-only powercfg commands only');
const child=spawn('powercfg',args,{windowsHide:true,stdio:['ignore','pipe','pipe']});
const out=[],err=[];child.stdout.on('data',b=>out.push(b));child.stderr.on('data',b=>err.push(b));
const code=await new Promise((yes,no)=>{child.once('error',no);child.once('close',yes);});
for(const chunks of [out,err]){const b=Buffer.concat(chunks),utf8=b.toString('utf8');console.log(utf8.includes('\ufffd')?new TextDecoder('gbk').decode(b):utf8);}
process.exitCode=code??1;
