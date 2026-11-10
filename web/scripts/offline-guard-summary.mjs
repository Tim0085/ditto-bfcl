import fs from 'node:fs';
import {join, resolve} from 'node:path';
const directory = resolve(process.argv[2]);
const rows = fs.readdirSync(directory).filter(name => /^\d+-.*\.json$/.test(name)).map(name => JSON.parse(fs.readFileSync(join(directory,name),'utf8')));
if (!rows.length) throw new Error('No process reports');
const checks = {}, denied = {}, children = [];
for (const row of rows) {
  for (const [kind,n] of Object.entries(row.checks)) checks[kind]=(checks[kind]??0)+n;
  for (const [kind,n] of Object.entries(row.denied)) denied[kind]=(denied[kind]??0)+n;
  for (const child of row.children) {
    const matching = rows.filter(r => child.launchId ? r.launchId === child.launchId : child.pid !== null && r.pid === child.pid && r.ppid === row.pid);
    children.push({...child,parentPid:row.pid,guardLoaded:child.isNode && matching.length>0,
      guardedNodeDescendants:!child.isNode && matching.length>0,observedNodePids:matching.map(r=>r.pid)});
  }
}
const missingNodeReports = children.filter(child => child.isNode && !child.denied && !child.guardLoaded);
const result = {processes:rows.map(row=>({pid:row.pid,ppid:row.ppid,guardLoaded:row.offlineGuard,initializations:row.initializations,duplicateLoads:row.duplicateLoads})),
  duplicateLoads:rows.reduce((sum,row)=>sum+(row.duplicateLoads??0),0),
  processCount:rows.length,checks,denied,deniedOperations:Object.values(denied).reduce((sum,n)=>sum+n,0),
  children,nonNodeChildren:children.filter(child=>!child.isNode),missingNodeReports,
  note:'Shell wrappers do not execute Node hooks. Every observed Node report includes pid/ppid; native extensions and internal bindings are outside this guard.'};
console.log(JSON.stringify(result,null,2));
if (missingNodeReports.length || (process.argv.includes('--zero-denied') && result.deniedOperations)) process.exitCode=1;
