// Search channel of the Web tools (src/python/web_backend.py _search -> in-container relay -> host egress), with the real
// src/ts/python-bridge.ts + src/python/bridge.py in live mode against a local fake relay and fake egress (loopback only, no outside network).
// 1. The relay's fixed "upstream not connected" reply (scripts/docker-entry.py REJECT_RESPONSE: 502, exactly those four headers, exactly that
//    body) is retried after 1, 2, 4 s, at most 3 times; the egress receives the search once. A fourth such reply is a channel failure.
// 2. A 502 whose status line, headers or body differ in any way is not retried: channel failure, one relay connection.
// 3. Every search uses a new connection, so an idle keep-alive connection closed by the egress (keepAliveTimeout 1 s) is never reused.
//    The fake relay models what the stage-3 run showed: the egress's idle close is not passed on to the client side of the relay, and the
//    next request written on that connection fails within milliseconds without reaching the egress. A second relay variant that does pass
//    the close on (as a plain TCP relay on loopback would) is checked too. Node 24 closes an idle connection keepAliveTimeout plus
//    keepAliveTimeoutBuffer (default 1000 ms) after the last reply, i.e. about 6 s for the egress; the fake egress sets the buffer to 0.
// 4. A drop after the relay connected (the request is already at the egress and may be charged) is not retried: channel failure, egress <= 1.
// 5. Retry count and wait go to stderr only; the tool result handed to the model is the same string as without retries.
// WEB_FIX2_EXPECT=before asserts the behaviour of the code before this fix instead (both failure classes reproduced).
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn,spawnSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {createServer as createTcpServer,connect,type AddressInfo,type Socket} from 'node:net';
import {createServer as createHttpServer} from 'node:http';
import {join} from 'node:path';
import {startPython,type BridgeResponse,type PythonBridge,type WebToolSettings} from '../src/ts/python-bridge.ts';
import {ROOT} from '../src/ts/scheduler/io.ts';

const before=process.env.WEB_FIX2_EXPECT==='before';
const python=process.platform==='win32'?'E:/Anaconda3/python.exe':'python3';
const bridgePy=join(ROOT,'src/python/bridge.py'),caseId='web_search_no_snippet_0';
const CHANNEL='WebChannelError: 搜索出口连接断开或回复无效';
const results=[{title:'Relay result',link:'https://example.org/relay',snippet:'one'},{title:'Second relay result',link:'https://example.org/second',snippet:'two'}];
const OBSERVATION=JSON.stringify(results.map(r=>({title:r.title,href:r.link})));

// The exact bytes of the relay's reply, taken from scripts/docker-entry.py itself (only its constant lines are executed).
const entry=readFileSync(join(ROOT,'scripts/docker-entry.py'),'utf8');
const constants=entry.slice(entry.indexOf('NOT_CONNECTED = '),entry.indexOf('relay_log_lock = '));
const relayBytes=spawnSync(python,['-B','-I','-c','import sys\nns={}\nexec(sys.stdin.read(),ns)\nsys.stdout.write(ns["REJECT_RESPONSE"].hex())'],{input:constants,encoding:'utf8',windowsHide:true});
assert.equal(relayBytes.status,0,relayBytes.stderr);
const EXACT=Buffer.from(relayBytes.stdout,'hex');
const NOT_CONNECTED=Buffer.from('DITTO_RELAY_UPSTREAM_NOT_CONNECTED_V1\n');
const HEADERS=['X-Ditto-Relay: upstream-not-connected-v1','Content-Type: text/plain','Content-Length: 38','Connection: close'];
const reply=(status:string,headers:string[],body:Buffer)=>Buffer.concat([Buffer.from(`HTTP/1.1 ${status}\r\n${headers.map(h=>h+'\r\n').join('')}\r\n`,'latin1'),body]);
assert.ok(EXACT.equals(reply('502 Bad Gateway',HEADERS,NOT_CONNECTED)),'docker-entry.py REJECT_RESPONSE layout');

type Egress={port:number;connections:number;closed:number;requests:{connection:number;body:any}[];close():Promise<void>};
async function startEgress(plan:{keepAliveMs?:number;drop?:'before-reply'|'mid-reply'}={}):Promise<Egress>{
  const sockets=new Set<Socket>(),ids=new WeakMap<Socket,number>();
  const state:Egress={port:0,connections:0,closed:0,requests:[],close:async()=>{}};
  const server=createHttpServer((req,res)=>{
    const chunks:Buffer[]=[];req.on('data',c=>chunks.push(c));
    req.on('end',()=>{
      state.requests.push({connection:ids.get(req.socket)!,body:JSON.parse(Buffer.concat(chunks).toString('utf8'))});
      if(plan.drop==='before-reply'){req.socket.destroy();return;}
      const body=JSON.stringify({ok:true,output:{organic_results:results}});
      if(plan.drop==='mid-reply'){req.socket.end(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n`+body.slice(0,10));return;}
      res.writeHead(200,{'content-type':'application/json','content-length':Buffer.byteLength(body)});res.end(body);
    });
  });
  server.keepAliveTimeout=plan.keepAliveMs??5_000;Object.assign(server,{keepAliveTimeoutBuffer:0});
  server.on('connection',s=>{state.connections++;ids.set(s,state.connections);sockets.add(s);s.on('close',()=>{sockets.delete(s);state.closed++;});});
  await new Promise<void>(yes=>server.listen(0,'127.0.0.1',yes));
  state.port=(server.address() as AddressInfo).port;
  state.close=()=>new Promise(yes=>{for(const s of sockets)s.destroy();server.close(()=>yes());});
  return state;
}

type Relay={port:number;connections:number;close():Promise<void>};
// reject: how many connections get the reply (default EXACT) instead of being forwarded; hideUpstreamClose: see header comment, point 3.
async function startRelay(egressPort:number,plan:{reject?:number;reply?:Buffer;hideUpstreamClose?:boolean}={}):Promise<Relay>{
  let rejects=plan.reject??0;
  const sockets=new Set<Socket>(),track=(s:Socket)=>{sockets.add(s);s.on('close',()=>sockets.delete(s));s.on('error',()=>{});};
  const state:Relay={port:0,connections:0,close:async()=>{}};
  const server=createTcpServer(client=>{
    state.connections++;track(client);
    if(rejects>0){
      rejects--;let buffer=Buffer.alloc(0);
      // Like docker-entry.py: read one complete request, then reply and close; nothing goes to the egress.
      client.on('data',d=>{
        buffer=Buffer.concat([buffer,d]);const end=buffer.indexOf('\r\n\r\n');if(end<0)return;
        const length=/\r\ncontent-length:\s*(\d+)/i.exec(buffer.subarray(0,end).toString('latin1'));
        if(buffer.length>=end+4+(length?Number(length[1]):0)&&!client.writableEnded)client.end(plan.reply??EXACT);
      });
      return;
    }
    const upstream=connect(egressPort,'127.0.0.1');track(upstream);let gone=false;
    client.on('data',d=>{if(gone){client.destroy();upstream.destroy();return;}upstream.write(d);});
    upstream.on('data',d=>client.write(d));
    const closed=()=>{if(gone)return;gone=true;if(!plan.hideUpstreamClose&&!client.destroyed)client.end();};
    upstream.on('end',closed);upstream.on('close',closed);
    client.on('end',()=>upstream.end());client.on('close',()=>upstream.destroy());
  });
  await new Promise<void>(yes=>server.listen(0,'127.0.0.1',yes));
  state.port=(server.address() as AddressInfo).port;
  state.close=()=>new Promise(yes=>{for(const s of sockets)s.destroy();server.close(()=>yes());});
  return state;
}

const settings=(port:number):WebToolSettings=>({mode:'live',taskId:'web-fix2/config/r1/'+caseId,configId:'config',
  searchEndpoint:`http://127.0.0.1:${port}/v1/search`,fetchProxy:'http://127.0.0.1:9'});
async function live<T>(relay:Relay,body:(bridge:PythonBridge)=>Promise<T>):Promise<T>{
  const bridge=startPython(python,bridgePy,undefined,'live');
  try{
    const init=await bridge.request({action:'init',case_id:caseId,web:settings(relay.port)});assert.equal(init.ok,true,JSON.stringify(init));
    const value=await body(bridge);await bridge.close();return value;
  }catch(error){await bridge.close().catch(()=>{});throw error;}
}
async function search(bridge:PythonBridge,keywords:string){
  const started=performance.now(),response:BridgeResponse=await bridge.request({action:'call',tool_name:'search_engine_query',arguments:{keywords}});
  return {response,ms:performance.now()-started};
}
const observation=(r:BridgeResponse)=>{assert.equal(r.ok,true,JSON.stringify(r));return (r as {ok:true;result:any}).result.observation;};
const channelFailure=(r:BridgeResponse)=>assert.deepEqual(r,{ok:false,error:CHANNEL});
async function scenario<T>(egressPlan:Parameters<typeof startEgress>[0],relayPlan:Parameters<typeof startRelay>[1],body:(bridge:PythonBridge,egress:Egress,relay:Relay)=>Promise<T>){
  const egress=await startEgress(egressPlan),relay=await startRelay(egress.port,relayPlan);
  try{return await live(relay,bridge=>body(bridge,egress,relay));}finally{await relay.close();await egress.close();}
}
const log=(value:unknown)=>console.log(JSON.stringify({expect:before?'before':'after',...value as object}));

test('baseline: one search through the relay reaches the egress once and returns the official observation',async()=>{
  await scenario({},{},async(bridge,egress,relay)=>{
    const {response}=await search(bridge,'baseline');
    assert.equal(observation(response),OBSERVATION);
    assert.equal(egress.requests.length,1);assert.equal(relay.connections,1);
    assert.deepEqual(egress.requests[0].body,{protocol:'bfcl-web-search-v1',configId:'config',taskId:'web-fix2/config/r1/'+caseId,
      caseId:'web_search_0',call:1,query:{keywords:'baseline',max_results:10,region:'wt-wt'}});
  });
});

for(const rejects of [1,2,3])test(`relay answers "not connected" ${rejects} time(s), then forwards`,async()=>{
  await scenario({},{reject:rejects},async(bridge,egress,relay)=>{
    const {response,ms}=await search(bridge,'retry-'+rejects);
    log({case:'not-connected-then-forward',rejects,ms:Math.round(ms),relayConnections:relay.connections,egressRequests:egress.requests.length,response});
    if(before){channelFailure(response);assert.equal(relay.connections,1);assert.equal(egress.requests.length,0);return;}
    assert.equal(observation(response),OBSERVATION);
    assert.equal(relay.connections,rejects+1);assert.equal(egress.requests.length,1);assert.equal(egress.requests[0].body.call,1);
    const waited=[1000,3000,7000][rejects-1];
    assert.ok(ms>=waited-50&&ms<waited+5000,`elapsed ${ms} ms, expected about ${waited} ms of waiting`);
  });
});

test('relay answers "not connected" 4 times: channel failure after 3 retries, nothing reaches the egress',async()=>{
  await scenario({},{reject:4},async(bridge,egress,relay)=>{
    const {response,ms}=await search(bridge,'retry-4');
    log({case:'not-connected-4',ms:Math.round(ms),relayConnections:relay.connections,egressRequests:egress.requests.length,response});
    channelFailure(response);assert.equal(egress.requests.length,0);
    if(before){assert.equal(relay.connections,1);return;}
    assert.equal(relay.connections,4);assert.ok(ms>=6950&&ms<12000,`elapsed ${ms} ms`);
  });
});

const near:[string,Buffer][]=[
  ['status 503',reply('503 Service Unavailable',HEADERS,NOT_CONNECTED)],
  ['relay header value',reply('502 Bad Gateway',['X-Ditto-Relay: upstream-not-connected-v2',...HEADERS.slice(1)],NOT_CONNECTED)],
  ['relay header missing',reply('502 Bad Gateway',HEADERS.slice(1),NOT_CONNECTED)],
  ['extra header',reply('502 Bad Gateway',[...HEADERS,'X-Extra: 1'],NOT_CONNECTED)],
  ['content type',reply('502 Bad Gateway',[HEADERS[0],'Content-Type: text/plain; charset=utf-8',...HEADERS.slice(2)],NOT_CONNECTED)],
  ['keep-alive',reply('502 Bad Gateway',[...HEADERS.slice(0,3),'Connection: keep-alive'],NOT_CONNECTED)],
  ['body without LF',reply('502 Bad Gateway',[...HEADERS.slice(0,2),'Content-Length: 37',HEADERS[3]],NOT_CONNECTED.subarray(0,37))],
  ['body case',reply('502 Bad Gateway',HEADERS,Buffer.from('ditto_relay_upstream_not_connected_v1\n'))],
  ['body CRLF',reply('502 Bad Gateway',[...HEADERS.slice(0,2),'Content-Length: 39',HEADERS[3]],Buffer.from('DITTO_RELAY_UPSTREAM_NOT_CONNECTED_V1\r\n'))],
];
test('a reply that differs from the relay\'s fixed one in status, any header or the body is not retried',async()=>{
  for(const [name,bytes] of near){
    assert.ok(!bytes.equals(EXACT),name);
    await scenario({},{reject:1,reply:bytes},async(bridge,egress,relay)=>{
      const {response,ms}=await search(bridge,'near-'+name);
      log({case:'near-miss',name,ms:Math.round(ms),relayConnections:relay.connections,egressRequests:egress.requests.length});
      channelFailure(response);assert.equal(relay.connections,1,name);assert.equal(egress.requests.length,0,name);
      assert.ok(ms<900,`${name}: no retry wait, elapsed ${ms} ms`);
    });
  }
});

test('egress keepAliveTimeout 1 s, second search 1.5 s later: the idle connection the egress closed is not reused',async()=>{
  await scenario({keepAliveMs:1000},{hideUpstreamClose:true},async(bridge,egress,relay)=>{
    const first=await search(bridge,'first');assert.equal(observation(first.response),OBSERVATION);
    await new Promise(yes=>setTimeout(yes,1500));assert.equal(egress.closed,1,'the egress closed the idle connection');
    const second=await search(bridge,'second');
    log({case:'keep-alive-hidden-close',secondMs:Math.round(second.ms),relayConnections:relay.connections,egressConnections:egress.connections,
      egressRequests:egress.requests.length,second:second.response});
    if(before){channelFailure(second.response);assert.equal(relay.connections,1);assert.equal(egress.requests.length,1);return;}
    assert.equal(observation(second.response),OBSERVATION);
    assert.equal(relay.connections,2);assert.equal(egress.connections,2);
    assert.deepEqual(egress.requests.map(r=>[r.connection,r.body.call]),[[1,1],[2,2]]);
  });
  // A relay that does pass the idle close on: the old code noticed the dropped connection itself; both must succeed.
  await scenario({keepAliveMs:1000},{},async(bridge,egress,relay)=>{
    assert.equal(observation((await search(bridge,'first')).response),OBSERVATION);
    await new Promise(yes=>setTimeout(yes,1500));
    assert.equal(observation((await search(bridge,'second')).response),OBSERVATION);
    assert.equal(egress.requests.length,2);assert.equal(relay.connections,2);
  });
});

test('back-to-back searches: each one opens its own connection',async()=>{
  await scenario({},{},async(bridge,egress,relay)=>{
    for(const k of ['a','b','c'])assert.equal(observation((await search(bridge,'row-'+k)).response),OBSERVATION);
    log({case:'back-to-back',relayConnections:relay.connections,egressConnections:egress.connections,egressRequests:egress.requests.length});
    assert.equal(egress.requests.length,3);
    if(before){assert.equal(relay.connections,1);assert.equal(egress.connections,1);return;}
    assert.equal(relay.connections,3);assert.equal(egress.connections,3);
    assert.deepEqual(egress.requests.map(r=>r.connection),[1,2,3]);
  });
});

for(const drop of ['before-reply','mid-reply'] as const)test(`connection dropped after the egress received the search (${drop}): no retry`,async()=>{
  await scenario({drop},{},async(bridge,egress,relay)=>{
    const {response,ms}=await search(bridge,'drop-'+drop);
    log({case:'drop',drop,ms:Math.round(ms),relayConnections:relay.connections,egressRequests:egress.requests.length,response});
    channelFailure(response);assert.equal(egress.requests.length,1);assert.equal(relay.connections,1);
    assert.ok(ms<900,`no retry wait, elapsed ${ms} ms`);
  });
});

test('retry count and wait are written to stderr only; the protocol lines and the observation are unchanged',async()=>{
  const egress=await startEgress(),relay=await startRelay(egress.port,{reject:2});
  try{
    const requests=[{action:'init',case_id:caseId,web:settings(relay.port)},{action:'call',tool_name:'search_engine_query',arguments:{keywords:'stderr'}}];
    const child=spawn(python,['-B','-X','utf8',bridgePy,'--web-mode','live'],{windowsHide:true,stdio:['pipe','pipe','pipe']});
    const out:Buffer[]=[],err:Buffer[]=[];child.stdout.on('data',b=>out.push(b));child.stderr.on('data',b=>err.push(b));
    const code=new Promise<number|null>((yes,no)=>{child.once('error',no);child.once('close',yes);});
    child.stdin.end(requests.map(r=>JSON.stringify(r)).join('\n')+'\n');
    assert.equal(await code,0,Buffer.concat(err).toString('utf8'));
    const lines=Buffer.concat(out).toString('utf8').split('\n').filter(Boolean),stderr=Buffer.concat(err).toString('utf8');
    assert.equal(lines.length,2);
    const notes=stderr.split(/\r?\n/).filter(l=>l.includes('searchConnectRetries')).map(l=>JSON.parse(l));
    log({case:'stderr',lines:lines.map(l=>l.slice(0,200)),notes,relayConnections:relay.connections,egressRequests:egress.requests.length});
    if(before){assert.deepEqual(JSON.parse(lines[1]),{ok:false,error:CHANNEL});assert.deepEqual(notes,[]);return;}
    assert.deepEqual(JSON.parse(lines[1]),{ok:true,result:{observation:OBSERVATION}});
    assert.equal(notes.length,1);
    assert.deepEqual(Object.keys(notes[0]).sort(),['call','outcome','searchConnectRetries','searchConnectRetryWaitMs']);
    assert.equal(notes[0].searchConnectRetries,2);assert.equal(notes[0].call,1);assert.equal(notes[0].outcome,'ok');
    assert.ok(notes[0].searchConnectRetryWaitMs>=2950&&notes[0].searchConnectRetryWaitMs<4000,JSON.stringify(notes[0]));
    assert.equal(egress.requests.length,1);assert.equal(relay.connections,3);
  }finally{await relay.close();await egress.close();}
});
