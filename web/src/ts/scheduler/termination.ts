import {join} from 'node:path';
import {files,maybe,read} from './io.ts';
import {attempts} from './records.ts';
import type {Plan} from './plan.ts';
/** Keep the collector snapshot and the per-request history separate: late receipts do not rewrite history. */
export function terminationEvidence(path:string){
  const logDir=join(path,'logs'),exit=maybe(join(path,'collected.json'))??maybe(join(logDir,'exit.json'));
  const snapshot=maybe(join(logDir,'kill-outcome.json')),names=files(join(logDir,'kill-requests')).filter(p=>p.endsWith('.json'));
  const requests=names.length?names.map(p=>read(p)):[maybe(join(logDir,'kill.json'))].filter(Boolean);
  const relevant=requests.filter(r=>!snapshot?.containerId||r.containerId===undefined||r.containerId===snapshot.containerId);
  let outcome:string|null=null;
  if(snapshot){
    const sigkill=exit?.exitCode===137&&exit?.oomKilled===false;
    outcome=sigkill&&relevant.some(r=>r.status==='succeeded')?'confirmed':
      sigkill&&relevant.some(r=>r.status==='dispatched'||!['requested','succeeded','failed','not-running','not-found'].includes(r.status))?'unconfirmed':
      relevant.length&&relevant.every(r=>r.status==='requested')?'not-dispatched':relevant.length?'not-confirmed':'not-requested';
  }
  return {outcome,collectedOutcome:snapshot?.outcome??null,killed:exit?.killed??null,
    explanation:outcome==='confirmed'?'确认强杀':outcome==='unconfirmed'?'已发出未确认':outcome==='not-dispatched'?'未发出':outcome==='not-confirmed'?'未确认强杀':outcome==='not-requested'?'没有强杀请求':'强杀证据缺失或不适用',
    requests:relevant,collectorSnapshot:snapshot??null,missing:snapshot?[]:['kill-outcome.json unavailable (historical or local-process)']};
}
export function terminationReport(root:string,plan:Plan){
  return plan.jobs.flatMap(job=>job.units.flatMap(unit=>attempts(root,job,unit.configId).map(a=>({
    job:job.key,configId:unit.configId,unitId:a.unitId,attempt:a.number,...terminationEvidence(a.path)
  }))));
}
