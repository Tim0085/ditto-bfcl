import { readdir,readFile,lstat } from "node:fs/promises";
import { join } from "node:path";
import { docker,inspect,assertOwned,ownerFilter } from "../src/ts/docker/common.ts";
import { SEC1_OWNER,SEC1_LABELS,SEC1_IMAGE_REPOSITORY } from "../src/ts/run-unit.ts";
import {readLedger} from '../src/ts/docker/release.ts';
const args=process.argv.slice(2),apply=args.includes('--apply'),run=args.find(a=>a.startsWith('--run='))?.slice(6);
const ledger=args.find(a=>a.startsWith('--ledger='))?.slice(9)??'docker/images.json';
const onlyImage=args.find(a=>a.startsWith('--image='))?.slice(8);
if(onlyImage&&!/^sha256:[a-f0-9]{64}$/.test(onlyImage))throw Error('--image requires full image ID');
if(args.some(a=>a!=='--apply'&&!/^--(run|ledger|image)=.+/.test(a)))throw Error('Usage: docker-gc.ts [--apply] [--run=<runId>] [--ledger=path] [--image=fullID]');
const ledgerImages=new Set((await readLedger(ledger)).map(r=>r.imageId));
for(const id of ledgerImages)console.log(JSON.stringify({protected:'image-ledger',description:'受台账保护',id,apply}));
const references=new Set<string>();
async function plans(path:string){for(const e of await readdir(path,{withFileTypes:true})){if(e.isSymbolicLink()||e.name.startsWith('.env')||e.name==='private')continue;const p=join(path,e.name);if(e.isDirectory())await plans(p);else if(/plan.*\.json$/i.test(e.name)){const text=await readFile(p,'utf8');JSON.parse(text.replace(/^\uFEFF/,''));for(const id of text.match(/sha256:[a-f0-9]{64}/g)??[])references.add(id);}}}
await plans('runs');
// Never delete a tagged release/dev image; only labeled dangling images are candidates.
let removed:boolean;
do {
removed=false;
const ids=[...new Set((await docker(['image','ls','-q','--no-trunc','--filter',`label=${SEC1_LABELS.owner}=${SEC1_OWNER}`,'--filter','dangling=true'])).stdout.trim().split(/\s+/).filter(Boolean))];
for(const id of ids){if(onlyImage&&id!==onlyImage)continue;const info=JSON.parse((await docker(['image','inspect',id])).stdout)[0];if(ledgerImages.has(info.Id)){console.log(JSON.stringify({protected:'image-ledger',description:'受台账保护',id:info.Id,apply}));continue;}if(info.Config.Labels?.[SEC1_LABELS.owner]!==SEC1_OWNER||info.RepoTags?.length||references.has(info.Id))continue;
  const used=(await docker(['ps','-aq','--filter',`ancestor=${info.Id}`])).stdout.trim();if(used)continue;
  console.log(JSON.stringify({candidate:'image',id:info.Id,apply}));if(apply){await docker(['image','rm','--no-prune',info.Id]);removed=true;}}
} while(apply&&removed);
const containers=onlyImage?[]:[...new Set((await Promise.all((run?[SEC1_LABELS.run,'sec1.builder']:[null]).map(label=>docker(['ps','-aq',...ownerFilter,...(label?['--filter',`label=${label}=${run}`]:[])])))).flatMap(r=>r.stdout.trim().split(/\s+/).filter(Boolean)))];
for(const id of containers){const info=await inspect(id);assertOwned(info);const labels=info.Config.Labels;
  if(run&&labels[SEC1_LABELS.run]!==run&&labels['sec1.builder']!==run)throw Error('Container run/builder ownership mismatch');
  if(run&&labels[SEC1_LABELS.run]!==run&&(Object.hasOwn(labels,SEC1_LABELS.run)||Object.hasOwn(labels,SEC1_LABELS.unit))){console.log(JSON.stringify({ignored:'inherited-builder-label',id:info.Id,run:labels[SEC1_LABELS.run]??null,unit:labels[SEC1_LABELS.unit]??null,builder:labels['sec1.builder'],apply}));continue;}
  if(info.State.Running)continue;console.log(JSON.stringify({candidate:'exited-container',id:info.Id,run:labels[SEC1_LABELS.run]??null,builder:labels['sec1.builder']??null,apply}));if(apply){if(!run)throw Error('Deleting containers requires --run to scope ownership');await docker(['rm',info.Id]);}}
console.log(JSON.stringify({dryRun:!apply,protectedPlanImages:[...references],protectedLedgerImages:[...ledgerImages]}));
