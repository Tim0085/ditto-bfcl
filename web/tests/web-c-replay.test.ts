import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildRequest } from '../src/ts/egress/model.ts';
import { readReplayRecord, replayBackend, webRequestComparator } from '../src/ts/egress/backends/replay.ts';
import { startEgress } from '../src/ts/egress/server.ts';
import { runBlock } from '../src/ts/config-main.ts';
import { loadActions } from '../src/ts/tool-actions.ts';
import type { SampleInput } from '../src/ts/egress/types.ts';

const json = async (file:string) => JSON.parse(await readFile(file, 'utf8'));
const egress = (await json('config/stages/web-c-gates.json')).egress;
const caseId = 'web_search_no_snippet_38';

test('strict replay requires all five old and new values and rejects any extra difference', async () => {
  const index = await json(egress.replay.index);
  const position = caseId + '/1/1';
  const old = await readReplayRecord(egress.replay.source, position, index.records[position]);
  const input:SampleInput = {messages:old.requestBody.messages, actions:await loadActions(caseId, 1),
    model:{model:egress.settings.model.model}, metadata:{configId:'test', taskId:'strict', caseId, turn:1, step:1}};
  const body = buildRequest(input, egress.settings);
  const output = await mkdtemp(join(tmpdir(), 'web-c-replay-'));
  const invoke = await replayBackend(egress.replay, output);
  const signal = new AbortController().signal;
  assert.deepEqual(await invoke(input, body, signal), old.rawResponse);
  for (const change of [
    (b:any) => {b.messages[0].content += 'x';},
    (b:any) => {b.tools[0].function.strict = true;},
    (b:any) => {b.tools[1].function.strict = null;},
    (b:any) => {b.tools[1].function.response = old.requestBody.tools[1].function.response;},
    (b:any) => {b.parallel_tool_calls = 0;},
    (b:any) => {delete b.tool_choice;},
    (b:any) => {b['tools.0.function.strict'] = false;},
  ]) {
    const mutated = structuredClone(body);
    change(mutated);
    await assert.rejects(invoke(input, mutated, signal), /回放请求体不同/);
  }
  const badOld = structuredClone(old.requestBody);
  badOld.tools[0].function.strict = null;
  assert((await webRequestComparator())(badOld, body).length > 0);
  const logged = (await readFile(join(output, 'requests.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  assert.equal(logged.length, 8);
  assert.deepEqual(logged[0].differences, []);
  assert(logged.slice(1).every(row => row.differences.length > 0));
});

test('Direct replay with the real offline model gateway and Python tool', async () => {
  const output = process.env.WEB_C_TEST_ROOT;
  assert(output, 'WEB_C_TEST_ROOT must name a new evidence run directory');
  await mkdir(output);
  const service = await startEgress(egress, join(output, 'egress'));
  try {
    const selection = await json('config/web-replay-selection.json');
    const caseIds = selection.cases.map((row:any) => row.caseId);
    const result = await runBlock({runId:'web-c-local-proof',configId:'direct-c1',group:'Direct',c:1,round:1,caseIds,
      modelEndpoint:service.url,model:egress.settings.model.model,maxOutputTokens:egress.settings.model.maxOutputTokens,
      perTaskRequests:egress.perTaskRequests,mode:egress.mode,debug:true,python:'E:/Anaconda3/python.exe',
      outputRoot:output,sampling:{enabled:false,strict:false,expected:{cpuMax:'',memoryMax:'',swapMax:''}},egress});
    console.log(JSON.stringify({cases:caseIds.length, completed:result.completed, failed:result.failed}));
    assert.equal(result.completed, 40);
    assert.equal(result.failed, 0);
    const long = await json(join(output, 'configs/direct-c1/tasks', caseId + '.r1.json'));
    assert.equal(long.completed.length, 3);
    assert.equal(long.inputLimitEvents.length, 1);
    assert.equal(long.inputLimitEvents[0].webReplayCall.name, 'fetch_url_content');
    assert.equal(long.termination.source, 'context');
    assert.equal(long.termination.inputBytes, 6131086);
  } finally {
    await service.close();
  }
});
