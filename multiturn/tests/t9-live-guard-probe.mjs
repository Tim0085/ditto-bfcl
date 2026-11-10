// Test-only. Loaded after scripts/egress-live-guard.mjs in a process started exactly like the real egress
// (script egress-shell.ts, root, key file), then exits before the shell runs. T9_PROBE_OUT receives the table.
// Every attempt below must fail in the guard, except the rows marked allowed.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';
import dgram from 'node:dgram';
import cp from 'node:child_process';
import {Worker} from 'node:worker_threads';
import {dirname,join} from 'node:path';
const state=globalThis[Symbol.for('ditto.egress.liveGuard')],[,,root,keyFile]=process.argv,rows=[];
const denied=error=>/LIVE_GUARD: forbidden/.test(String(error?.message));
async function attempt(label,action){try{await action();rows.push({label,outcome:'not denied'});}catch(error){rows.push({label,outcome:denied(error)?'denied':'other error: '+String(error?.message).slice(0,120)});}}
const quiet=socket=>{socket?.on?.('error',()=>{});socket?.destroy?.();};
const sink=net.createServer(s=>s.destroy());await new Promise(y=>sink.listen(0,'127.0.0.1',y));const otherPort=sink.address().port;
const server=https.createServer({cert:fs.readFileSync(process.env.T9_CERT),key:fs.readFileSync(process.env.T9_KEY)},(q,r)=>{r.end('{}');});await new Promise(y=>server.listen(Number(process.env.T9_PORT),'127.0.0.1',y));
const pinnedPort=server.address().port;
// Before the key file is read nothing may connect anywhere.
await attempt('before pin: socket to the API port',()=>quiet(net.connect(pinnedPort,'localhost')));
await attempt('before pin: https to the API',()=>quiet(https.request('https://localhost:'+pinnedPort+'/')));
await attempt('before pin: dns.lookup of the API host',()=>dns.lookup('localhost',()=>{}));
const credentials=state.readCredentials({baseUrlEnv:'BFCL_BASE_URL',apiKeyEnv:'BFCL_API_KEY'});
rows.push({label:'readCredentials returns only the two configured names',outcome:Object.keys(credentials).sort().join()==='BFCL_API_KEY,BFCL_BASE_URL'?'allowed':'wrong'});
rows.push({label:'key is not in process.env',outcome:Object.values(process.env).some(v=>v===credentials.BFCL_API_KEY)?'wrong':'allowed'});
await attempt('second key file read',()=>state.readCredentials({baseUrlEnv:'BFCL_BASE_URL',apiKeyEnv:'BFCL_API_KEY'}));
for(const [label,action] of Object.entries({
  'fs.readFileSync of the key file':()=>fs.readFileSync(keyFile),'fs.promises.readFile of the key file':()=>fsp.readFile(keyFile),'createReadStream of the key file':()=>fs.createReadStream(keyFile),
  'copyFile of the key file':()=>fs.copyFileSync(keyFile,join(root,'stolen')),'stat of the key file':()=>fs.statSync(keyFile),'list the key directory':()=>fs.readdirSync(dirname(keyFile)),
  'read the private directory':()=>fs.readdirSync('F:/Academic/Ditto/experiments/private'),'read a .env file':()=>fs.readFileSync(join(root,'.env')),'process.loadEnvFile':()=>process.loadEnvFile(keyFile),
  'net.connect to another local port':()=>quiet(net.connect(otherPort,'127.0.0.1')),'net.connect to the API port by another name':()=>quiet(net.connect(pinnedPort,'127.0.0.1')),'net.connect to another host':()=>quiet(net.connect(443,'example.invalid')),
  'net.connect to a pipe':()=>quiet(net.connect({path:'\\\\.\\pipe\\t9-probe'})),'net.connect with a private lookup':()=>quiet(net.connect({host:'localhost',port:pinnedPort,lookup:(h,o,c)=>c(null,'127.0.0.1',4)})),
  'tls.connect to another local port':()=>quiet(tls.connect(otherPort,'127.0.0.1')),'https to another port':()=>quiet(https.request('https://localhost:'+otherPort+'/')),'https to another host':()=>quiet(https.get('https://example.invalid/')),
  'http to the API port':()=>quiet(http.request('http://localhost:'+pinnedPort+'/')),'http.get to the API port':()=>quiet(http.get('http://localhost:'+pinnedPort+'/')),
  'fetch to another host':()=>fetch('https://example.invalid/'),'fetch over http to the API port':()=>fetch('http://localhost:'+pinnedPort+'/'),'fetch to another port':()=>fetch('https://localhost:'+otherPort+'/'),
  'http2.connect':()=>http2.connect('https://localhost:'+pinnedPort),'dgram socket':()=>dgram.createSocket('udp4'),
  'dns.lookup of another host':()=>dns.lookup('example.invalid',()=>{}),'dns.lookup of a loopback literal':()=>dns.lookup('127.0.0.1',()=>{}),'dns.promises.lookup of another host':()=>dns.promises.lookup('example.invalid'),
  'dns.resolve4 of the API host':()=>dns.resolve4('localhost',()=>{}),'dns.resolve of the API host':()=>dns.resolve('localhost',()=>{}),'dns.promises.resolve4':()=>dns.promises.resolve4('localhost'),'dns.reverse':()=>dns.reverse('127.0.0.1',()=>{}),'dns.lookupService':()=>dns.lookupService('127.0.0.1',443,()=>{}),
  'dns.Resolver.resolve4':()=>new dns.Resolver().resolve4('localhost',()=>{}),'dns.promises.Resolver.resolve':()=>new dns.promises.Resolver().resolve('localhost'),
  'listen on all interfaces':()=>net.createServer().listen(0,'0.0.0.0'),'listen without a host':()=>net.createServer().listen(0),
  'spawn':()=>cp.spawn(process.execPath,['-v']),'spawnSync':()=>cp.spawnSync(process.execPath,['-v']),'exec':()=>cp.exec('echo x'),'execSync':()=>cp.execSync('echo x'),'execFile':()=>cp.execFile(process.execPath,['-v']),'execFileSync':()=>cp.execFileSync(process.execPath,['-v']),'fork':()=>cp.fork('tests/t9-live-guard-probe.mjs'),
  'worker thread':()=>new Worker('console.log(1)',{eval:true}),'process.binding':()=>process.binding('tcp_wrap'),'process.dlopen':()=>process.dlopen({},'x.node'),
}))await attempt(label,action);
// The allowed path: the pinned name and port over TLS, name resolved through the one permitted lookup.
const allowed=await new Promise(yes=>{const r=https.request('https://localhost:'+pinnedPort+'/',{method:'POST'},res=>{res.resume();res.once('end',()=>yes(res.statusCode));});r.once('error',e=>yes('error '+String(e.message).slice(0,120)));r.end('{}');});
rows.push({label:'https to the pinned host and port',outcome:allowed===200?'allowed':'wrong: '+allowed});
const allowedFetch=await fetch('https://localhost:'+pinnedPort+'/',{method:'POST',body:'{}'}).then(r=>r.status,e=>'error '+String(e?.cause?.message??e?.message).slice(0,120));
rows.push({label:'fetch to the pinned host and port',outcome:allowedFetch===200?'allowed':'wrong: '+allowedFetch});
const lookedUp=await new Promise(yes=>dns.lookup('localhost',(e,a)=>yes(e?String(e.message):'ok')));
rows.push({label:'dns.lookup of the API host',outcome:lookedUp==='ok'?'allowed':'wrong: '+lookedUp});
fs.writeFileSync(process.env.T9_PROBE_OUT,JSON.stringify(rows,null,1));
process.exit(0);
