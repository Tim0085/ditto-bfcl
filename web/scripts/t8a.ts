import {parseArgs} from 'node:util';
import {resolve,join} from 'node:path';
import {freeze,type StageConfig,type Plan} from '../src/ts/scheduler/plan.ts';
import {LocalProcessLauncher} from '../src/ts/scheduler/local-process.ts';
import {runSchedule} from '../src/ts/scheduler/scheduler.ts';
import {profile} from '../src/ts/scheduler/profile.ts';
import {exportRun} from '../src/ts/scheduler/export.ts';
import {recoverEgress,interruptHungEgress} from '../src/ts/scheduler/egress.ts';
import {connect} from '../src/ts/scheduler/control.ts';
import {HostScorer,scoreJob} from '../src/ts/scheduler/scoring.ts';
import {read} from '../src/ts/scheduler/io.ts';
import {launcherFor,freezeLauncher,requireFTemp} from '../src/ts/scheduler/launcher.ts';
import {isLivePlan,checkLiveRun} from '../src/ts/scheduler/live.ts';
requireFTemp();
const {positionals,values}=parseArgs({allowPositionals:true,options:{stage:{type:'string'},root:{type:'string'},output:{type:'string'},authorization:{type:'string'},'targeted-split':{type:'string'},live:{type:'boolean'},'key-file':{type:'string'},'live-authorization':{type:'string'}}});
const root=resolve(values.root??'');if(!values.root)throw new Error('--root is required');
// The key file is only a path here: this process never opens it. The flag is not --env-file on purpose:
// Node reads any --env-file argument itself, before the guard loads, even after the script name.
const liveFlags=values.live||values['key-file']!==undefined||values['live-authorization']!==undefined;
if(liveFlags&&(positionals[0]!=='run'||!values.live))throw new Error('--live, --key-file and --live-authorization go together, on run only');
// T9 C2: on a real plan, an empty value or one that names no file (for example the key itself pasted in) stops here, before
// the authorization record and the egress, and is not echoed. Empty is checked before resolve(), which turns '' into the package
// root. The plan's own checks of the authorization text come first, with their usual messages. The file check is a raw
// attribute lookup in egress-live-launch.mjs, answered only for this run's own --key-file; the file is not opened.
const keyArgument=values['key-file'];
if(positionals[0]==='run'&&values.live&&keyArgument!==undefined){const plan=read<Plan>(join(root,'plan.json'));
  if(isLivePlan(plan)){
    if(!keyArgument.trim())throw new Error('密钥文件路径不存在或为空');
    checkLiveRun(plan,{keyFile:resolve(keyArgument),authorization:values['live-authorization']});
    const {keyFilePresent}=await import(new URL('./egress-live-launch.mjs',import.meta.url).href);
    if(!keyFilePresent(resolve(keyArgument)))throw new Error('密钥文件路径不存在或为空');
  }}
switch(positionals[0]){
  case 'plan': {if(!values.stage)throw new Error('--stage required');const stage=read<StageConfig>(values.stage);if(values['targeted-split'])stage.targetedSplit=resolve(values['targeted-split']);await freezeLauncher(stage);console.log(JSON.stringify({planHash:freeze(stage,root).hash}));break;}
  case 'run':console.log(JSON.stringify(await runSchedule(root,launcherFor(root,read<Plan>(join(root,'plan.json'))),{resumeAuthorization:values.authorization,live:values.live?{keyFile:values['key-file']===undefined?undefined:resolve(values['key-file']),authorization:values['live-authorization']}:undefined})));break;
  case 'stop':await connect(join(root,'scheduler'),true);console.log('Planned stop requested');break;
  case 'profile':{// Several roots: profile --root A --root B --root C --output X. The parse above keeps only the last --root;
    // its strict check has already passed, so every --root token here carries a value. One root keeps the old default output.
    const roots=parseArgs({allowPositionals:true,strict:false,tokens:true,options:{root:{type:'string'},output:{type:'string'}}}).tokens!.flatMap(t=>t.kind==='option'&&t.name==='root'&&typeof t.value==='string'?[resolve(t.value)]:[]);
    if(roots.length>1&&!values.output)throw new Error('--output is required with more than one --root');
    console.log(JSON.stringify(profile(roots.length>1?roots:root,resolve(values.output??join(root,'targeted-split.json')))));break;}
  case 'export':if(!values.output)throw new Error('--output required (new directory)');exportRun(root,resolve(values.output));console.log('Export complete');break;
  case 'recover':console.log(JSON.stringify(await recoverEgress(root,values.authorization??'')));break;
  case 'interrupt-egress':console.log(JSON.stringify(await interruptHungEgress(root,values.authorization??'')));break;
  case 'score':{const plan=read<Plan>(join(root,'plan.json'));const scorer=new HostScorer(plan.stage.python,join(root,'scheduler','guards','score'));for(const job of plan.jobs)await scoreJob(root,plan,job,scorer,true);console.log('Scores appended');break;}
  default:throw new Error('Command: plan | run | stop | profile | export | score | recover | interrupt-egress');
}
