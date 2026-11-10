// T9 C1 #44: record the user's confirmation of one unknown model-request fee.
// Appends exactly one line to <root>/scheduler/fee-confirmations.jsonl. egress/ledger.jsonl is only read
// (to check that the request is a retained or never-settled reservation) and is byte-for-byte unchanged;
// the script checks its hash before and after. The export reads the confirmations: "not-charged" counts
// 0 CNY and is no longer an unknown hold; "charged" counts the confirmed amount instead of the hold.
// A later line for the same request supersedes an earlier one (the file is never rewritten).
//
// Usage (offline guard, TEMP/TMP on F:):
//   node --import ./scripts/egress-offline-guard.mjs --experimental-transform-types scripts/confirm-fee.ts
//     --root <run root> --request <reservation id> --conclusion not-charged|charged [--charged-cny <yuan>]
//     --user-text "<the user's own words>" --authorization "<who authorized this record, when, where>"
import {parseArgs} from 'node:util';
import {join,resolve} from 'node:path';
import {existsSync,appendFileSync,mkdirSync,writeSync} from 'node:fs';
import {jsonRows,fileHash} from '../src/ts/scheduler/export-stream.ts';
import {feeConfirmations} from '../src/ts/scheduler/export-ledger.ts';
import {now} from '../src/ts/scheduler/io.ts';
import {visibleCount} from '../src/ts/scheduler/live.ts';
const {values}=parseArgs({options:{root:{type:'string'},request:{type:'string'},conclusion:{type:'string'},'charged-cny':{type:'string'},'user-text':{type:'string'},authorization:{type:'string'}}});
// Synchronous write, then a natural exit with code 2. Calling process.exit while the module loader is
// still active aborts libuv on Windows now and then (exit 0xC0000409, 6 of 20 runs in T9 C1's probe).
class Refused extends Error{}
const fail=(m:string):never=>{writeSync(2,'confirm-fee: '+m+String.fromCharCode(10));throw new Refused(m);};
// At least one visible character. T9 C3: the same count as the real-run authorization (live.ts visibleCount); its set of
// invisible characters includes the ranges this script used before.
const visible=(s:string|undefined)=>typeof s==='string'&&visibleCount(s)>=1;
function main(){
if(!values.root)fail('--root is required');
const root=resolve(values.root!),ledgerPath=join(root,'egress','ledger.jsonl');
if(!existsSync(join(root,'plan.json'))||!existsSync(ledgerPath))fail('not a run root with plan.json and egress/ledger.jsonl: '+root);
const id=values.request;if(!id||!/^[A-Za-z0-9-]{8,80}$/.test(id))fail('--request must be a ledger reservation id');
const conclusion=values.conclusion;if(conclusion!=='not-charged'&&conclusion!=='charged')fail('--conclusion must be not-charged or charged');
let chargedCny:number|null=null;
if(conclusion==='charged'){chargedCny=Number(values['charged-cny']);if(values['charged-cny']===undefined||!Number.isFinite(chargedCny)||chargedCny<0)fail('--charged-cny must be a non-negative number for charged');}
else if(values['charged-cny']!==undefined)fail('--charged-cny only goes with --conclusion charged');
if(!visible(values['user-text']))fail("--user-text must carry the user's own words");
if(!visible(values.authorization))fail('--authorization must say who authorized this record');
const before=fileHash(ledgerPath);let reserve:any=null,end:any=null;
for(const row of jsonRows(ledgerPath,true)){if(row.id!==id)continue;if(row.kind==='reserve')reserve=row;else if(row.kind==='settle'||row.kind==='retain_failed')end=row;}
if(!reserve)fail('no reservation '+id+' in the ledger');
if(end?.kind==='settle')fail('request '+id+' is settled in the ledger; nothing to confirm');
const previous=feeConfirmations(root).byId.get(id!)??null;
const line={version:1,kind:'fee-confirmation',requestId:id,configId:reserve.configId??null,caseId:reserve.caseId??null,taskId:reserve.taskId??null,ledgerState:end?'retained':'pending',
  conclusion,chargedCny,userText:values['user-text'],authorization:values.authorization,at:now(),recordedBy:'scripts/confirm-fee.ts',...(previous?{supersedesLine:previous.line}:{})};
const path=join(root,'scheduler','fee-confirmations.jsonl');mkdirSync(join(root,'scheduler'),{recursive:true});
appendFileSync(path,JSON.stringify(line)+'\n',{flag:'a'});
const after=fileHash(ledgerPath);if(after!==before)fail('ledger.jsonl changed while recording (before '+before+', after '+after+'); stop and inspect');
console.log(JSON.stringify({recorded:path,requestId:id,conclusion,chargedCny,supersedes:previous?.line??null,ledgerSha256:after}));
}
try{main();}catch(error){if(error instanceof Refused)process.exitCode=2;else throw error;}
