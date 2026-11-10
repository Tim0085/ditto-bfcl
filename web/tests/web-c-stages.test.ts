import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { checkPlan, freeze, laneOrder, type StageConfig } from '../src/ts/scheduler/plan.ts';

const json = async (path:string) => JSON.parse(await readFile(path, 'utf8'));
const cases = (await json('config/web-replay-selection.json')).cases.map((row:any) => row.caseId).sort();
const root = process.env.WEB_C_FREEZE_ROOT;
assert(root, 'WEB_C_FREEZE_ROOT must name a new evidence run directory');
await mkdir(root);

for (const [name, configCount, caseCount, peak] of [['gates',8,40,4],['e',1,40,1],['f',18,40,12],['g',2,100,2]] as const) {
  test(`web-c-${name}: plan freeze with docker topology and path checks`, async () => {
    const stage:StageConfig = await json(`config/stages/web-c-${name}.json`);
    assert(stage.launcher?.kind === 'docker');
    assert.equal(stage.launcher.tag, 'dev');
    assert.equal(stage.launcher.imageId, undefined);
    const syntaxOnlyId = 'sha256:' + 'c'.repeat(64);
    stage.launcher.imageId = syntaxOnlyId;
    const output = join(root, name);
    const plan = freeze(stage, output);
    checkPlan(await json(join(output, 'plan.json')));
    assert.equal(plan.stage.configs.length, configCount);
    const byConfig = new Map<string, Set<string>>();
    for (const job of plan.jobs) {
      const simultaneous = laneOrder(plan, job).reduce((count, lane) => count + Math.max(...lane.map(group => group.configs.length)), 0);
      assert.equal(simultaneous, peak);
      for (const unit of job.units) {
        const selected = byConfig.get(unit.configId) ?? new Set<string>();
        for (const caseId of unit.caseIds) {
          assert(!selected.has(caseId));
          selected.add(caseId);
        }
        byConfig.set(unit.configId, selected);
      }
    }
    assert.equal(byConfig.size, configCount);
    for (const selected of byConfig.values()) {
      assert.equal(selected.size, caseCount);
      if (name !== 'g') assert.deepEqual([...selected].sort(), cases);
    }
    if (name === 'g') assert.equal(stage.egress.backend, 'fixtures');
    else {
      assert.equal(stage.egress.backend, 'replay');
      assert.equal(stage.egress.replay?.failOnDifference, true);
    }
    assert.equal(stage.egress.settings.model.maxRequestBytes, 1887436);
    console.log(JSON.stringify({stage:name,configCount,caseCount,peak,planHash:plan.hash,imageId:syntaxOnlyId,realImageVerified:false}));
  });
}
