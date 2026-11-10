import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createModelClient,connectRetryScope} from '../src/ts/model-client.ts';
import {sampleInput,sampleOutput} from './t7-helpers.ts';
const body='DITTO_RELAY_UPSTREAM_NOT_CONNECTED_V1\n';
test('exact relay failure retries four attempts; partial matches stop on first attempt',async()=>{
  for(const mode of ['exact','status','marker','body','length','extra-header','normal']){
    let count=0;
    const server=createServer(async(req,res)=>{
      for await(const _ of req);count++;
      if(mode==='normal'){res.end(JSON.stringify({ok:true,output:sampleOutput}));return;}
      res.sendDate=false;res.statusCode=mode==='status'?503:502;
      res.setHeader('X-Ditto-Relay',mode==='marker'?'other':'upstream-not-connected-v1');
      res.setHeader('Content-Type','text/plain');res.setHeader('Connection','close');
      const value=mode==='body'?body.replace('V1','V2'):body;
      res.setHeader('Content-Length',String(Buffer.byteLength(value)));
      if(mode==='length')res.removeHeader('Content-Length');
      if(mode==='extra-header')res.setHeader('X-Extra','no');
      res.end(value);
    });
    server.listen(0,'127.0.0.1');await once(server,'listening');
    const metrics={connectRetries:0,connectRetryWaitMs:0},start=performance.now();
    try{
      const run=()=>createModelClient(`http://127.0.0.1:${(server.address() as any).port}`).invoke(sampleInput as any,{} as any);
      if(mode==='normal')assert.deepEqual(await connectRetryScope.run(metrics,run),sampleOutput);
      else await assert.rejects(connectRetryScope.run(metrics,run),new RegExp('BFCL_RUN_STOP:.*"attempts":'+(mode==='exact'?4:1)));
      assert.equal(count,mode==='exact'?4:1);assert.equal(metrics.connectRetries,mode==='exact'?3:0);
      if(mode==='exact')assert(metrics.connectRetryWaitMs>=6970);
      console.log(JSON.stringify({mode,count,metrics,elapsedMs:performance.now()-start}));
    }finally{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));}
  }
});
