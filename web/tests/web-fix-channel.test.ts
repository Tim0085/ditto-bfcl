// Python <-> Node tool channel (src/ts/python-bridge.ts + src/python/bridge.py), with real child processes.
// 1. Tool results with U+2028 / U+2029 (alone, together, inside a text of several MB) come back byte for byte.
// 2. print() inside a tool (the official web_search.py error branches) never reaches the protocol channel.
// 3. Node -> Python: JSON.stringify leaves U+2028 / U+2029 / U+0085 raw; Python's line reader keeps them in one line.
// 4. Replay mode: every recorded tool observation in data/replay/tools comes back unchanged through the real bridge.py.
// tests/python/web_fix_harness.py runs the real bridge.py serve() and tool path; only the network layer is replaced.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync,writeFileSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startPython,type BridgeResponse,type PythonBridge,type WebToolSettings} from '../src/ts/python-bridge.ts';
import {ROOT} from '../src/ts/scheduler/io.ts';

const python=process.platform==='win32'?'E:/Anaconda3/python.exe':'python3';
const harness=join(ROOT,'tests/python/web_fix_harness.py'),bridgePy=join(ROOT,'src/python/bridge.py'),caseId='web_search_no_snippet_0';
const big='x'.repeat(2*1024*1024)+'\u2028\u2029中文😀\r\n\u0085\t"\\'+'y'.repeat(2*1024*1024);
const raw:Record<string,string>={'u2028.txt':'before\u2028after','u2029.txt':'before\u2029after','both.txt':'\u2029start\u2028\u2029mid\u2029\u2028end\u2028','big.txt':big};
// The case of web-pilot-001 (a PDF read with mode truncate): plain text, separators in the middle, so the official text extraction keeps it as is.
const incident='Town of South Boston Newsletter\u2029Page 2\u2028Council minutes\u2028\u2029End of issue';
const dir=mkdtempSync(join(tmpdir(),'web-fix-'));
for(const [name,text] of Object.entries({...raw,'incident.txt':incident}))writeFileSync(join(dir,name),text,'utf8');
process.env.WEB_FIX_PAYLOADS=dir;
test.after(()=>rmSync(dir,{recursive:true,force:true}));

const ok=(r:BridgeResponse)=>{assert.equal(r.ok,true,JSON.stringify(r).slice(0,300));return (r as {ok:true;result:any}).result;};
async function session<T>(script:string,mode:WebToolSettings['mode'],id:string,body:(bridge:PythonBridge)=>Promise<T>):Promise<T>{
  const bridge=startPython(python,script,undefined,mode);
  try{ok(await bridge.request({action:'init',case_id:id,web:{mode} as WebToolSettings}));const value=await body(bridge);await bridge.close();return value;}
  catch(error){await bridge.close().catch(()=>{});throw error;}
}
const call=(bridge:PythonBridge,tool_name:string,args:Record<string,unknown>)=>bridge.request({action:'call',tool_name,arguments:args}).then(ok).then(r=>JSON.parse(r.observation));

test('tool results with U+2028 / U+2029 come back byte for byte (separate bridge per payload)',async()=>{
  const failures:string[]=[];
  for(const [name,text] of [...Object.entries(raw).map(([n,t])=>[n,t,'raw']),['incident.txt',incident,'truncate']]){
    try{await session(harness,'fixture',caseId,async bridge=>{
      const observation=await call(bridge,'fetch_url_content',{url:'https://example.org/'+name,mode:text===incident?'truncate':'raw'});
      assert.equal(typeof observation.content,'string',JSON.stringify(observation).slice(0,300));
      assert.ok(Buffer.from(observation.content,'utf8').equals(Buffer.from(text,'utf8')),name+' differs');
    });}catch(error){failures.push(name+': '+String((error as Error).message));}
  }
  console.log(JSON.stringify({payloads:Object.keys(raw).concat('incident.txt'),bigBytes:Buffer.byteLength(big),failures}));
  assert.deepEqual(failures,[]);
});

test('print() in the official search error branches stays off the protocol channel',async()=>{
  const searches=await session(harness,'fixture',caseId,async bridge=>{
    const plain=await call(bridge,'search_engine_query',{keywords:'fail-plain'});
    const payload429=await call(bridge,'search_engine_query',{keywords:'payload-429-once'});
    const raised429=await call(bridge,'search_engine_query',{keywords:'fail-429-once'});
    const ordinary=await call(bridge,'search_engine_query',{keywords:'ordinary'});
    return {plain,payload429,raised429,ordinary};
  });
  assert.deepEqual(searches.plain,{error:'simulated search failure'});
  for(const k of ['payload429','raised429','ordinary'] as const)assert.ok(Array.isArray(searches[k])&&searches[k].length>0,k);
  // The same requests on a bare pipe: stdout holds exactly one protocol line per request; the prints went to stderr.
  const requests=[{action:'init',case_id:caseId,web:{mode:'fixture'}},...['fail-plain','payload-429-once','fail-429-once'].map(keywords=>({action:'call',tool_name:'search_engine_query',arguments:{keywords}})),
    {action:'call',tool_name:'fetch_url_content',arguments:{url:'https://example.org/both.txt',mode:'raw'}}];
  const child=spawn(python,['-B','-X','utf8',harness,'--web-mode','fixture'],{windowsHide:true,stdio:['pipe','pipe','pipe']});
  const out:Buffer[]=[],err:Buffer[]=[];child.stdout.on('data',b=>out.push(b));child.stderr.on('data',b=>err.push(b));
  const code=new Promise<number|null>((yes,no)=>{child.once('error',no);child.once('close',yes);});
  child.stdin.end(requests.map(r=>JSON.stringify(r)).join('\n')+'\n');
  assert.equal(await code,0,Buffer.concat(err).toString('utf8'));
  const stdout=Buffer.concat(out).toString('utf8'),stderr=Buffer.concat(err).toString('utf8'),lines=stdout.split('\n').filter(Boolean);
  assert.equal(lines.length,requests.length,stdout.slice(0,500));
  for(const line of lines){const r=JSON.parse(line);assert.equal(r.ok,true);assert.deepEqual(Object.keys(r).sort(),['ok','result']);}
  assert.ok(!/[\u2028\u2029]/.test(stdout)&&stdout.includes('\\u2028')&&stdout.includes('\\u2029'),'protocol lines carry the separators escaped');
  assert.equal(JSON.parse(JSON.parse(lines.at(-1)!).result.observation).content,raw['both.txt']);
  assert.equal((stderr.match(/\[WebSearchAPI\] Received 429/g)??[]).length,2);assert.equal((stderr.match(/\[WebSearchAPI\] Error from SerpAPI/g)??[]).length,1);
  console.log(JSON.stringify({protocolLines:lines.length,stderrBlocks:(stderr.match(/\[WebSearchAPI\]/g)??[]).length}));
});

test('Node -> Python: raw U+2028 / U+2029 / U+0085 in a request stay inside one line',async()=>{
  const action='probe\u2028a\u2029b\u0085c'+'z'.repeat(3*1024*1024)+'\u2029\u2028end';
  const message={action} as any;assert.ok(JSON.stringify(message).includes('\u2028')&&JSON.stringify(message).includes('\u2029'),'JSON.stringify keeps them raw');
  const reply=await session(bridgePy,'fixture',caseId,async bridge=>{
    const r=await bridge.request(message);
    ok(await bridge.request({action:'turn',turn:1}));// still in step: a split line would have produced a second, unrequested answer
    return r;
  });
  assert.deepEqual(reply,{ok:false,error:'ValueError: 未知请求类型：'+action});
});

test('replay mode: all recorded tool observations come back unchanged through the real bridge.py',async()=>{
  const files=readdirSync(join(ROOT,'data/replay/tools')).filter(f=>f.endsWith('.json')).sort();let calls=0,bytes=0;
  assert.equal(files.length,40);
  for(const file of files){const record=JSON.parse(readFileSync(join(ROOT,'data/replay/tools',file),'utf8'));if(!record.calls.length)continue;
    await session(bridgePy,'replay',record.caseId,async bridge=>{
      for(const c of record.calls){const r=ok(await bridge.request({action:'call',tool_name:c.name,arguments:c.arguments}));
        assert.equal(r.observation,c.observation,record.caseId+' call '+(calls+1));calls++;bytes+=Buffer.byteLength(c.observation);}
    });
  }
  console.log(JSON.stringify({files:files.length,calls,observationBytes:bytes}));
  assert.equal(calls,452);
});
