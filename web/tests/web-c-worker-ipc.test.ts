import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIpcTransport } from '@codesoul-co/ditto/runtime';
import { deploy, type Copies } from '../src/ts/deploy.ts';
import { deployTimeouts } from '../src/ts/deploy-timeouts.ts';
import { runBlock } from '../src/ts/config-main.ts';
import { loadTask } from '../src/ts/tool-actions.ts';
import { runTask } from '../src/ts/task-loop.ts';
import { startEgress } from '../src/ts/egress/server.ts';
import { mockResponse } from '../src/ts/egress/mock.ts';
import { parseResponse, parseUsage } from '../src/ts/egress/model.ts';
import { remaining } from '../src/ts/scheduler/records.ts';
import type { PlannedJob } from '../src/ts/scheduler/plan.ts';

const json = async (path:string) => JSON.parse(await readFile(path, 'utf8'));
const stage = await json('config/egress.offline.json');
const python = process.platform === 'win32' ? 'E:/Anaconda3/python.exe' : '/usr/local/bin/python3';
const replay = {...stage,backend:'replay',replay:{source:'data/replay/models',index:'data/replay/models/index.json',failOnDifference:true}};
const cases = {large:'web_search_no_snippet_38', next:'web_search_no_snippet_14',
  ordinary:'web_search_no_snippet_0', stop:'web_search_no_snippet_1'};
const groups = ['Direct','Monolithic','Uniform','Targeted'] as const;
function copies(group:typeof groups[number]):Copies|undefined {
  if (group === 'Direct') return;
  if (group === 'Monolithic') return {All:1};
  return {Context:1,Infer:group==='Targeted'?2:1,Interaction:1,Memory:1};
}
const model = stage.settings.model.model;
const maxOutputTokens = stage.settings.model.maxOutputTokens;
const sampling = {enabled:false,strict:false,expected:{cpuMax:'',memoryMax:'',swapMax:''}};
const eventRows = async (path:string) => (await readFile(path,'utf8')).trim().split('\n').filter(Boolean).map(s=>JSON.parse(s));

test('real IPC gives the Direct context termination, publishes the next task, and closes the tool',async()=>{
  const root = await mkdtemp(join(tmpdir(),'web-c-ipc-context-'));
  const service = await startEgress(replay,join(root,'egress'));
  let expected:unknown;
  try {
    for (const group of groups) {
      const configId = group.toLowerCase();
      const result = await runBlock({runId:'context',configId,group,c:1,round:1,copies:copies(group),
        caseIds:[cases.large,cases.next],modelEndpoint:service.url,model,maxOutputTokens,perTaskRequests:100,
        mode:'offline-reference',debug:true,python,outputRoot:root,sampling,egress:replay});
      assert.deepEqual([result.completed,result.failed,result.skipped,result.notStarted,result.consecutiveFailure],[2,0,0,0,null]);
      const out = join(root,'configs',configId);
      const large = await json(join(out,'tasks',cases.large+'.r1.json'));
      if (group==='Direct') expected=large.termination;
      assert.deepEqual(large.termination,expected,group);
      assert.equal(large.executionOutcome,'input_limit');
      assert.equal(large.termination.source,'context');
      assert.equal(large.termination.inputBytes,6131086);
      assert.equal(large.termination.maxRequestBytes,1000000);
      assert.equal(large.completed.length,3);
      assert(large.messages.every((message:any)=>message.role!=='tool'||
        Buffer.byteLength(JSON.stringify(message.content))<=large.termination.maxRequestBytes));
      assert.equal(large.inputLimitEvents[0].webReplayCall.name,'fetch_url_content');
      assert.equal((await json(join(out,'tasks',cases.next+'.r1.json'))).executionOutcome,'completed');
      assert((await eventRows(join(out,'steps.jsonl'))).some(row=>row.taskId===large.taskId&&
        row.execution?.graphId==='bfcl-close'&&row.success));
      const life = await json(join(out,'lifecycle.json'));
      if (group!=='Direct') assert(life.processes.length>0&&life.processes.every((p:any)=>p.pid!==process.pid&&p.exited));
      console.log(JSON.stringify({group,context:large.termination,failed:result.failed,nextCompleted:true}));
    }
  } finally { await service.close(); }
});

test('ordinary search-channel failure stays skipped and a real search run_stop interrupts like Direct',async()=>{
  const root = await mkdtemp(join(tmpdir(),'web-c-ipc-stop-'));
  const fixture = (await json('data/web_search_no_snippet.fixtures.json')).cases.find((c:any)=>c.id===cases.ordinary);
  const call = fixture.turns[0][0];
  assert.equal(call.name,'search_engine_query');
  const raw = mockResponse({message:{role:'assistant',content:''},finishReason:'action_request',
    actionRequests:[{id:'search-one',name:call.name,arguments:call.arguments}]},model,'chat-completions',0);
  const output = {...parseResponse(raw,'chat-completions'),usage:parseUsage(raw,'chat-completions')};
  const hit = new Map<string,string[]>();
  const server = createServer(async(req,res)=>{
    const chunks:Buffer[]=[];
    for await (const chunk of req) chunks.push(chunk);
    const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const ids=hit.get(body.configId)??[];
    ids.push(req.url+':'+body.caseId);
    hit.set(body.configId,ids);
    const reply = req.url==='/v1/sample' ? {ok:true,output}
      : body.caseId==='web_search_1' ? {ok:false,error:{kind:'run_stop',message:'fixture search halt'}} : {};
    res.setHeader('content-type','application/json');
    res.end(JSON.stringify(reply));
  });
  await new Promise<void>((yes,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',yes);});
  const address = server.address();
  assert(address&&typeof address==='object');
  const modelEndpoint=`http://127.0.0.1:${address.port}/v1/sample`;
  const egress={...stage,backend:'live' as const,webFetchProxy:'http://127.0.0.1:9'};
  let reason:unknown;
  try {
    for (const group of groups) {
      const configId=group.toLowerCase();
      const block=join(root,'blocks','b',configId,'r1','attempt-1');
      await mkdir(block,{recursive:true});
      const {writeFile}=await import('node:fs/promises');
      await writeFile(join(block,'attempt.json'),JSON.stringify({number:1,unitId:configId}));
      const caseIds=[cases.ordinary,cases.stop,cases.next];
      const result=await runBlock({runId:'search',configId,group,c:1,round:1,copies:copies(group),caseIds,
        modelEndpoint,model,maxOutputTokens,perTaskRequests:100,mode:'live',debug:true,python,
        outputRoot:join(block,'output'),sampling,egress});
      assert.deepEqual([result.stopCategory,result.skipped,result.interrupted,result.notStarted,result.consecutiveFailure],
        ['出口停止',1,1,1,null],group);
      if(group==='Direct')reason=result.stopReason;
      assert.equal(result.stopReason,reason);
      assert.match(result.stopReason??'',/BFCL_RUN_STOP:fixture search halt/);
      const failures=join(block,'output','configs',configId,'failures');
      const ordinary=await json(join(failures,cases.ordinary+'.r1.json'));
      const stopped=await json(join(failures,cases.stop+'.r1.json'));
      assert.equal(ordinary.failureType,'tool-channel');
      assert.equal(ordinary.disposition,'skipped');
      assert.equal(stopped.disposition,'interrupted');
      assert.equal(stopped.category,'出口停止');
      const job:PlannedJob={key:'r1-b',batch:'test',blockId:'b',category:'web_search_no_snippet',round:1,caseIds,
        environmentCounts:{WebSearchAPI:3},units:[{configId,seed:'test',caseIds}]};
      assert.deepEqual(remaining(root,job,configId),[cases.stop,cases.next]);
      assert.deepEqual(hit.get(configId),['/v1/sample:'+cases.ordinary,'/v1/search:web_search_0',
        '/v1/sample:'+cases.stop,'/v1/search:web_search_1']);
      console.log(JSON.stringify({group,ordinary:ordinary.disposition,runStop:stopped.disposition,retry:remaining(root,job,configId)}));
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((yes,no)=>server.close(error=>error?no(error):yes()));
  }
});

test('real Worker failure messages cannot restore an error for a different identity or malformed byte counts',async()=>{
  const root=await mkdtemp(join(tmpdir(),'web-c-ipc-negative-'));
  const service=await startEgress(replay,join(root,'egress'));
  const mutations = ['invocation','task','graph','step','worker','malformed','missing'] as const;
  try {
    for (const group of groups) {
      if (group==='Direct') continue;
      let mutation:typeof mutations[number]|undefined, mutated=0;
      const directory=join(root,group);
      const pool=await deploy({group,copies:copies(group)!,python,modelEndpoint:service.url,
        directory,timeouts:deployTimeouts(replay)}, opts=>{
        const channel=opts.channel as typeof opts.channel & {emit:(event:string,...args:any[])=>boolean};
        const emit=channel.emit.bind(channel);
        channel.emit=(event,...args)=>{
          const row=args[0];
          if(event==='message'&&row?.kind==='failure-origin'&&row.toolFailure?.kind==='input_limit'&&mutation){
            ++mutated;
            if(mutation==='invocation')row.id+='-old';
            else if(mutation==='task')row.toolInvocation.taskId+='-old';
            else if(mutation==='graph')row.toolInvocation.runId+='-old';
            else if(mutation==='step')row.toolInvocation.nodeId+='-old';
            else if(mutation==='worker')row.workerId+='-old';
            else if(mutation==='malformed')row.toolFailure.inputBytes=String(row.toolFailure.inputBytes);
            else delete row.toolInvocation.taskId;
          }
          return emit(event,...args);
        };
        return createIpcTransport(opts);
      });
      try {
        for(const variant of [...mutations,undefined]){
          mutation=variant;
          const taskId=`negative/${group}/${variant??'valid'}`;
          const {bindings}=pool.attach(taskId);
          const releases:any[]=[];
          const handles=new Map([...pool.handles].map(([id,handle])=>[id,{...handle,async releaseTask(taskId:string){
            const result=await handle.releaseTask(taskId);releases.push(result);return result;
          }}]));
          const run=runTask(pool.runtime,await loadTask(cases.large),{taskId,configId:group,
            model,maxOutputTokens,perTaskRequests:100,mode:'offline-reference',web:{mode:'replay'},bindings,handles});
          try {
            if(variant)await assert.rejects(run,error=>error instanceof Error&&/Worker invocation failed/.test(error.message)&&
              !/BFCL_INPUT_LIMIT|BFCL_RUN_STOP/.test(error.message),variant);
            else assert.equal((await run).executionOutcome,'input_limit');
          } finally {pool.detach(taskId);}
          assert(releases.some(result=>result.contextDeleted),variant);
          if(process.platform==='linux'){
            const steps=(await Promise.all(pool.units.map(async unit=>{
              const file=join(directory,'workers',unit.id+'.steps.jsonl');
              return existsSync(file)?eventRows(file):[];
            }))).flat();
            const initialized=steps.find(row=>row.taskId===taskId&&row.action==='init'&&row.pythonPid>0);
            assert(initialized,'missing Python PID evidence');
            assert(!existsSync('/proc/'+initialized.pythonPid),'Python process survived task cleanup');
          }
        }
        assert.equal(mutated,mutations.length);
        console.log(JSON.stringify({group,rejectedAlterations:mutated,validAfterAlternations:true,cleanupVerified:true}));
      } finally {await pool.close();}
    }
  } finally {await service.close();}
});
