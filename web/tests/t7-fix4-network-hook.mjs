// Test instrumentation: observe real sockets and optionally supply a cancellation signal.
import {registerHooks} from 'node:module';
import net from 'node:net';
import {appendFileSync} from 'node:fs';
const q=new URL(import.meta.url).searchParams, file=q.get('file'), port=Number(q.get('port'));
let seq=0;
const controllers=new Set();
const write=row=>appendFileSync(file,JSON.stringify({pid:process.pid,at:performance.now(),...row})+'\n');
const connect=net.Socket.prototype.connect;
net.Socket.prototype.connect=function(...args){
  const o=Array.isArray(args[0])?args[0][0]:args[0];
  if(Number(typeof o==='object'?o.port:o)===port){
    const id=++seq;write({event:'attempt',id});
    this.once('connect',()=>write({event:'connect',id}));
    this.once('error',error=>write({event:'error',id,message:error.message}));
    this.once('close',()=>{write({event:'close',id});if(q.get('cancel')==='yes')for(const c of controllers)setTimeout(()=>c.abort(new Error('fix4 cancel during retry wait')),100);});
  }
  return connect.apply(this,args);
};
globalThis.__fix4Signal=()=>{
  const c=new AbortController();controllers.add(c);return c.signal;
};
if(q.get('cancel')==='yes')registerHooks({load(url,context,next){
  const r=next(url,context);if(!url.endsWith('/src/ts/model-client.ts'))return r;
  const needle='async invoke(input, options) {';
  if(!String(r.source).includes(needle))throw new Error('cancel hook target missing');
  return {...r,source:String(r.source).replace(needle,needle+' options = {...options, signal: (globalThis as any).__fix4Signal()};')};
}});
