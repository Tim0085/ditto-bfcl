import assert from 'node:assert/strict';
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
const root=process.argv[2];if(!root)throw new Error('Explicit evidence directory required');
const groups=['guard-replay-final','guard-fixtures','guard-direct-proof-final','guard-final-typecheck2','guard-final-npm2'];
const summaries=[];
for(const group of groups){
  const reports=[];
  for(const file of await readdir(join(root,group)))if(file.endsWith('.json'))reports.push(JSON.parse(await readFile(join(root,group,file),'utf8')));
  // T5's duplicate-load regression deliberately places its reports under its own
  // temporary root. Follow only the exact root recorded in these child launches.
  if(group==='guard-final-npm2') {
    const roots=new Set(reports.flatMap(r=>r.children??[]).filter(c=>c.args?.[0]==='scripts/offline-guard-duplicate-probe.mjs').map(c=>c.args[1]));
    const archive=join(root,'guard-final-npm2-extra');await mkdir(archive,{recursive:true});
    for(const temp of roots)for(const scenario of ['single','same-url','copy','same-file-query']) {
      const directory=join(temp,'reports-'+scenario);
      for(const file of await readdir(directory))if(file.endsWith('.json')) {
        const bytes=await readFile(join(directory,file));reports.push(JSON.parse(bytes));
        await writeFile(join(archive,file),bytes,{flag:'wx'});
      }
    }
  }
  const launches=reports.flatMap(r=>r.children??[]).filter(c=>c.isNode&&!c.denied);
  const missing=launches.filter(c=>!reports.some(r=>r.launchId===c.launchId));
  const python=reports.flatMap(r=>r.children??[]).filter(c=>/python(?:\.exe)?$/i.test(c.command));
  assert.equal(missing.length,0,`${group}: child guard report missing`);
  assert(python.every(c=>c.args.includes('-B')),`${group}: Python without -B`);
  const denied=reports.reduce((n,r)=>n+r.deniedOperations,0);
  if(['guard-replay-final','guard-fixtures','guard-direct-proof-final'].includes(group))assert.equal(denied,0);
  const summary={group,processes:reports.map(r=>({pid:r.pid,ppid:r.ppid,launchId:r.launchId,denied:r.deniedOperations,duplicateLoads:r.duplicateLoads})),
    nodeProcesses:reports.length,nodeChildren:launches.length,nodeChildrenMissingGuard:missing.length,pythonProcesses:python.length,allPythonUseB:true,deniedOperations:denied};
  summaries.push(summary);console.log(JSON.stringify(summary));
}
await writeFile(join(root,'guard-summary-final.json'),JSON.stringify(summaries,null,2),{flag:'wx'});
