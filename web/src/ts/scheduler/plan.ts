import {readFileSync} from 'node:fs';
import {join,relative,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import type {Block} from '../config-main.ts';
import {validateBlock} from '../config-main.ts';
import type {Copies} from '../deploy.ts';
import type {EgressConfig} from '../egress/config.ts';
import {validateConfig} from '../egress/config.ts';
import {ROOT,read,json,files,digest,id} from './io.ts';
import {validateLauncher,checkFrozenMounts,type LauncherConfig} from './launcher.ts';
import {WEB_CATEGORIES,WEB_PROFILE_NUMBERS,categoryDataFile} from '../tool-actions.ts';
export const categories=[...WEB_CATEGORIES];
export const capabilities=['Context','Infer','Interaction','Memory'] as const;
export const primary=['WebSearchAPI'];
export const profileNumbers=WEB_PROFILE_NUMBERS;
export interface Configuration {id:string;group:Block['group'];c:number;copies?:Copies|'profile';comparison:string[]}
export interface StageConfig {version:1;runId:string;stage:string;seed:number;rounds:number;blockSize:number;launcher?:LauncherConfig;configs:Configuration[];batches:{id:string;configs:string[];caseIds:string[]|'all'|'profile';lanes?:string[][][]}[];targetedSplit?:string;prices?:{source:string;date:string;valley:{cachedInput:number;uncachedInput:number;output:number};peak:{cachedInput:number;uncachedInput:number;output:number}};
  python:string;egress:EgressConfig & {webFetchProxy?:string};endpoint:{host:'127.0.0.1';port:number};sampling:Block['sampling'];startupConcurrency:number;
  stall:{idleMs:number;stopGraceMs:number;pollMs:number};score:{timeoutMs:number;concurrency:number};hostSampleMs:number;}
export interface PlannedJob {key:string;batch:string;blockId:string;category:string;round:number;caseIds:string[];environmentCounts:Record<string,number>;units:{configId:string;seed:string;caseIds:string[];copies?:Copies}[]}
export interface Plan {version:1;runId:string;stage:StageConfig;targeted:any;fingerprints:Record<string,string>;jobs:PlannedJob[];hash:string}
export function catalog(){return categories.flatMap(c=>readFileSync(join(ROOT,categoryDataFile(c,'tasks')),'utf8').trim().split('\n').map(l=>JSON.parse(l)));}
export function shuffle<T>(items:T[],seed:string){let state=Number.parseInt(digest(seed).slice(0,8),16);const next=()=>{state=(state+0x6d2b79f5)|0;let t=Math.imul(state^(state>>>15),1|state);t^=t+Math.imul(t^(t>>>7),61|t);return ((t^(t>>>14))>>>0)/4294967296;};const a=[...items];for(let i=a.length-1;i>0;i--){const j=Math.floor(next()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a;}
export function fingerprints(){const paths=[...files(join(ROOT,'src')),...files(join(ROOT,'vendor/ditto')),...files(join(ROOT,'vendor/bfcl_eval')),...files(join(ROOT,'vendor/python')),...files(join(ROOT,'data')),...files(join(ROOT,'scripts')).filter(p=>p.endsWith('.py')||p.endsWith('.ps1')||p.endsWith('t8a.ts')||p.includes('docker-')),join(ROOT,'package.json'),join(ROOT,'tsconfig.json'),join(ROOT,'scripts/egress-offline-guard.mjs'),join(ROOT,'scripts/offline-guard-runtime.mjs'),join(ROOT,'scripts/egress-live-guard.mjs'),join(ROOT,'scripts/egress-live-launch.mjs')];return Object.fromEntries(paths.sort().map(p=>[relative(ROOT,p).replaceAll('\\','/'),createHash('sha256').update(readFileSync(p)).digest('hex')]));}
// T9 two lanes: lanes run side by side, the groups of a lane one after another. Every
// comparison stays inside one concurrency tier, so a tier must share a group to share its time.
function validateLanes(batch:StageConfig['batches'][number],configs:Configuration[]){
  if(!Object.hasOwn(batch,'lanes'))return;
  const lanes:unknown=batch.lanes,list=(v:unknown)=>Array.isArray(v)&&v.length>0;
  if(!list(lanes)||!(lanes as unknown[]).every(l=>list(l)&&(l as unknown[]).every(g=>list(g)&&(g as unknown[]).every(c=>typeof c==='string'))))throw new Error(`Invalid lanes in batch ${batch.id}: expected nonempty lanes of nonempty groups of config ids`);
  const slots=new Map<string,string>();
  for(const [l,groups] of batch.lanes!.entries())for(const [g,group] of groups.entries())for(const cid of group){
    if(!batch.configs.includes(cid))throw new Error(`Lanes of batch ${batch.id} name config ${cid}, which is not in the batch`);
    if(slots.has(cid))throw new Error(`Config ${cid} appears twice in the lanes of batch ${batch.id}`);
    slots.set(cid,`${l}/${g}`);
  }
  for(const cid of batch.configs)if(!slots.has(cid))throw new Error(`Config ${cid} of batch ${batch.id} is missing from its lanes`);
  const tiers=new Map<number,string>();
  for(const c of configs){const peer=tiers.get(c.c);if(peer!==undefined&&slots.get(peer)!==slots.get(c.id))throw new Error(`Concurrency ${c.c} is split across lane groups in batch ${batch.id}: ${peer} and ${c.id}`);tiers.set(c.c,c.id);}
}
/** Lanes of one block in frozen order. Without lanes: one lane, one group, every unit. */
export function laneOrder(plan:Plan,job:PlannedJob):{lane?:number;laneGroup?:number;configs:string[]}[][]{
  const lanes=plan.stage.batches.find(b=>b.id===job.batch)?.lanes;
  return lanes?lanes.map((groups,l)=>groups.map((configs,g)=>({lane:l+1,laneGroup:g+1,configs}))):[[{configs:job.units.map(u=>u.configId)}]];
}
/** Lane and group numbers of a config, counted from 1; empty for a batch without lanes. */
export function lanePlace(plan:Plan,job:PlannedJob,cid:string){const group=laneOrder(plan,job).flat().find(g=>g.lane&&g.configs.includes(cid));return group?{lane:group.lane!,laneGroup:group.laneGroup!}:{};}
// T9 B: every limit of a real stage is a finite positive number at freezing; the plan hash then fixes them.
function validateLiveStage(stage:StageConfig){
  const e=stage.egress,budget=e.settings?.budget,rates=budget?.peakCnyPerMillion,policy=e.dispatchPolicy,rate=(p:any)=>({cachedInput:p?.cachedInput,uncachedInput:p?.uncachedInput,output:p?.output});
  if(e.backend!=='live'||e.mode!=='live')throw new Error('A real stage needs egress backend and mode both live');
  if(stage.launcher?.kind!=='docker')throw new Error('A real stage needs the docker launcher');
  const limits={referenceUsd:budget?.referenceUsd,referenceCny:budget?.referenceCny,...Object.fromEntries(Object.entries(rate(rates)).map(([k,v])=>['peakCnyPerMillion.'+k,v])),maxRequests:budget?.maxRequests,perTaskRequests:e.perTaskRequests,'dispatchPolicy.maxInFlight':policy?.maxInFlight,'dispatchPolicy.requestsPerMinute':policy?.requestsPerMinute,'dispatchPolicy.minIntervalMs':policy?.minIntervalMs,'dispatchPolicy.maxCooldownMs':policy?.maxCooldownMs,...Object.fromEntries((['valley','peak'] as const).flatMap(band=>Object.entries(rate(stage.prices?.[band])).map(([k,v])=>[`prices.${band}.${k}`,v])))};
  for(const [name,value] of Object.entries(limits))if(typeof value!=='number'||!Number.isFinite(value)||value<=0)throw new Error(`A real stage needs a finite positive ${name}`);
  // T9 C2: also what the ledger and the cost export need, so that a stage that freezes can also start its egress (ledger.ts open()).
  const b=budget as any,r=rates as any,peak=(stage.prices as any).peak;
  for(const name of ['referenceUsd','referenceCny']){const micro=Math.floor(b[name]*1e6);if(!Number.isSafeInteger(micro)||micro<1)throw new Error(`A real stage needs ${name} x 1e6, rounded down, to be a safe integer of at least 1`);}
  const three='cachedInput,output,uncachedInput';
  if(Object.keys(r).sort().join()!==three)throw new Error('A real stage needs exactly cachedInput, uncachedInput and output in peakCnyPerMillion');
  if(r.cachedInput>r.uncachedInput)throw new Error('A real stage needs peakCnyPerMillion.cachedInput no larger than uncachedInput');
  if(Object.keys(peak).sort().join()!==three||three.split(',').some(k=>peak[k]!==r[k]))throw new Error('A real stage needs prices.peak equal to budget.peakCnyPerMillion, item by item');
  for(const k of ['inputPerMillion','outputPerMillion']){const v=(e.settings?.model as any)?.referencePrice?.[k];if(typeof v!=='number'||!Number.isFinite(v)||v<=0)throw new Error(`A real stage needs a finite positive referencePrice.${k}`);}
}
export function generate(stage:StageConfig):Plan {
  validateLauncher(stage.launcher);
  id(stage.runId);if(stage.version!==1||!stage.configs.length||!stage.batches.length)throw new Error('Invalid stage');
  if(stage.egress.backend==='live'||stage.egress.mode==='live'){
    validateLiveStage(stage);
    stage={...stage,egress:{...stage.egress,webFetchProxy:stage.egress.webFetchProxy??'http://host.docker.internal:7897'}};
  }
  for(const n of [stage.rounds,stage.blockSize,stage.startupConcurrency,stage.stall.idleMs,stage.stall.stopGraceMs,stage.stall.pollMs,stage.score.timeoutMs,stage.score.concurrency,stage.hostSampleMs])if(!Number.isSafeInteger(n)||n<1)throw new Error('Invalid stage limits');
  if(stage.endpoint.host!=='127.0.0.1')throw new Error('Only loopback egress supported');validateConfig(stage.egress);
  if(new Set(stage.configs.map(c=>id(c.id))).size!==stage.configs.length)throw new Error('Duplicate configs');
  if(new Set(stage.batches.map(b=>id(b.id))).size!==stage.batches.length)throw new Error('Duplicate batch ids');
  const targeted=stage.targetedSplit?read(resolve(ROOT,stage.targetedSplit)):null;
  if(stage.configs.some(c=>c.copies==='profile')&&(!targeted?.byCategory||targeted.status!=='complete'))throw new Error('A completed targeted-split.json is required');
  const tasks=catalog(),byId=new Map(tasks.map(t=>[t.id,t])),jobs:PlannedJob[]=[],identities=new Set<string>();
  for(let round=1;round<=stage.rounds;round++)for(const batch of stage.batches){
    id(batch.id);const selected=batch.caseIds==='all'?tasks.map(t=>t.id):batch.caseIds==='profile'?categories.flatMap(c=>profileNumbers.map(n=>c+'_'+n)):batch.caseIds;
    if(!selected.length||new Set(selected).size!==selected.length||selected.some(c=>!byId.has(c)))throw new Error('Invalid case selection');
    if(!batch.configs.length||new Set(batch.configs).size!==batch.configs.length)throw new Error('Empty or duplicate batch configs');
    const configs=batch.configs.map(cid=>{const c=stage.configs.find(c=>c.id===cid);if(!c)throw new Error('Unknown batch config');return c;});
    validateLanes(batch,configs);
    for(const c of configs)for(const caseId of selected){const key=`${c.id}/r${round}/${caseId}`;if(identities.has(key))throw new Error('Duplicate config/round/case identity across batches');identities.add(key);}
    for(const category of categories){const ids=selected.filter(c=>c.startsWith(category+'_'));if(!ids.length)continue;
      const pools=primary.map(p=>shuffle(ids.filter(cid=>{const matched=primary.filter(p=>byId.get(cid).involved_classes.includes(p));if(matched.length!==1)throw new Error('Ambiguous primary environment');return matched[0]===p;}),`${stage.seed}/${category}/${p}`));
      // Fair round-robin across shuffled strata; full 200/50 => rotating 13/13/12/12.
      const interleaved:string[]=[];while(pools.some(p=>p.length))for(const pool of pools)if(pool.length)interleaved.push(pool.shift()!);
      for(let offset=0;offset<interleaved.length;offset+=stage.blockSize){const caseIds=interleaved.slice(offset,offset+stage.blockSize),blockId=`${batch.id}-${category}-${offset/stage.blockSize+1}`;
        const units=configs.map(c=>{const copies=c.copies==='profile'?targeted.byCategory[category]?.copies:c.copies;
          const seed=`${stage.seed}/${stage.runId}/${c.id}/r${round}/${blockId}`;
          validateBlock({runId:stage.runId,configId:c.id,group:c.group,c:c.c,round,copies,caseIds,modelEndpoint:'http://127.0.0.1:1',model:stage.egress.settings.model.model,maxOutputTokens:stage.egress.settings.model.maxOutputTokens,perTaskRequests:stage.egress.perTaskRequests,mode:stage.egress.mode,debug:true,python:stage.python,outputRoot:ROOT,sampling:stage.sampling,egress:stage.egress,startupConcurrency:stage.startupConcurrency});
          return {configId:c.id,seed,caseIds:shuffle(caseIds,seed),...(copies?{copies}:{})};});
        jobs.push({key:`r${round}-${blockId}`,batch:batch.id,blockId,category,round,caseIds,environmentCounts:Object.fromEntries(primary.map(p=>[p,caseIds.filter(cid=>byId.get(cid).involved_classes.includes(p)).length])),units});
      }
    }
  }
  const body={version:1 as const,runId:stage.runId,stage:structuredClone(stage),targeted,fingerprints:fingerprints(),jobs};return {...body,hash:digest(body)};
}
export function freeze(stage:StageConfig,root:string){const plan=generate(stage);checkFrozenMounts(root,plan);json(join(root,'plan.json'),plan,true);return plan;}
export function checkPlan(plan:Plan,checkCode=true){const {hash,...body}=plan;if(digest(body)!==hash)throw new Error('Frozen plan was changed');if(checkCode&&digest(plan.fingerprints)!==digest(fingerprints()))throw new Error('Frozen source/data fingerprints changed; create a new run');}
export function matrix():Configuration[]{
  const configs:Configuration[]=[];
  for(const c of [1,4,8]){configs.push({id:`direct-c${c}`,group:'Direct',c,comparison:['direct']});configs.push({id:`mono-${c}-c${c}`,group:'Monolithic',c,copies:{All:c},comparison:['direct',...(c>1?['cost']:[]),...(c===8?['equal']:[])]});
    if(c!==8)configs.push({id:`mono-8-c${c}`,group:'Monolithic',c,copies:{All:8},comparison:['equal']});
    configs.push({id:`uniform-8-c${c}`,group:'Uniform',c,copies:{Context:2,Infer:2,Interaction:2,Memory:2},comparison:['equal']},{id:`targeted-8-c${c}`,group:'Targeted',c,copies:'profile',comparison:['equal']});
    if(c>1)configs.push({id:`uniform-${4*c}-c${c}`,group:'Uniform',c,copies:{Context:c,Infer:c,Interaction:c,Memory:c},comparison:['cost']},{id:`targeted-${c+3}-c${c}`,group:'Targeted',c,copies:{Context:1,Infer:c,Interaction:1,Memory:1},comparison:['cost']});
  }return configs;
}
