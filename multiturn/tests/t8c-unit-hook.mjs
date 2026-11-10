import {registerHooks,syncBuiltinESMExports} from 'node:module';
import fs from 'node:fs';
const options=JSON.parse(fs.readFileSync('/unit/fault.json','utf8'));
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
globalThis.__t8cUnitFault=async(node,input)=>{
  const taskId=input?.scope?.sessionId??input?.metadata?.taskId??input?.call?.arguments?.taskId;
  if(!taskId||options.caseId&&!taskId.endsWith('/'+options.caseId))return;
  if(options.skip&&node==='CONTEXT.SELECT')throw Error('t8c fixture context failure');
  if(options.hang&&node==='INTERACTION.ACT.TOOL'&&input?.call?.arguments?.request?.action==='call'){
    fs.writeFileSync('/unit/hang-entered.json',JSON.stringify({taskId,pid:process.pid}));
    while(!fs.existsSync('/unit/release'))await sleep(25);
  }
};
registerHooks({load(url,context,next){const result=next(url,context);let source=String(result.source);
  if(url.endsWith('/src/ts/agent-core.ts')){const at='const target = executor(capability);';if(!source.includes(at))throw Error('Unit fixture hook target missing');source=source.replace(at,at+' await globalThis.__t8cUnitFault(node,input);');}
  if(options.tasksFail&&url.endsWith('/src/ts/config-main.ts')){const at='for(const name of ["tasks","failures","workers"])mkdirSync(join(directory,name));';if(!source.includes(at))throw Error('Startup fixture hook target missing');source=source.replace(at,'writeFileSync(join(directory,"tasks"),"t8c startup fixture",{flag:"wx"});'+at);}
  if(options.summaryHang&&url.endsWith('/src/ts/config-main.ts')){const at='await pool?.close();';if(!source.includes(at))throw Error('Summary barrier anchor missing');source=source.replace(at,'await new Promise(()=>{writeFileSync("/unit/summary-blocked","two skipped failures are durable; summary not written");setInterval(()=>{},1000);});'+at);}
  return {...result,source};
}});
// All observed sync writes retain their original arguments, return values and exceptions.
let calls=0,bytes=0,nanoseconds=0n,depth=0;const begun=process.hrtime.bigint(),nativeWrite=fs.writeFileSync;
for(const name of ['writeFileSync','appendFileSync','fsyncSync']){const original=fs[name];fs[name]=function(...args){const outer=depth++===0,start=process.hrtime.bigint();try{return original.apply(this,args);}finally{depth--;if(outer){calls++;if(typeof args[1]==='string'||Buffer.isBuffer(args[1]))bytes+=Buffer.byteLength(args[1]);nanoseconds+=process.hrtime.bigint()-start;}}};}
syncBuiltinESMExports();
process.once('exit',()=>nativeWrite('/unit/io-'+process.pid+'.json',JSON.stringify({pid:process.pid,calls,bytes,syncWriteMs:Number(nanoseconds)/1e6,lifetimeMs:Number(process.hrtime.bigint()-begun)/1e6,measurement:'outermost synchronous write/append/flush calls; nested append-to-write calls counted once; async I/O excluded'})));
