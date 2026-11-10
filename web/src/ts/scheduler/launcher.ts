import {join,resolve} from 'node:path';
import {mkdirSync} from 'node:fs';
import {DockerLauncher} from '../docker/launcher.ts';
import {docker,mountPath} from '../docker/common.ts';
import {LocalProcessLauncher} from './local-process.ts';
import {verifyWorktreeImage} from '../docker/image-context.ts';
import {ROOT} from './io.ts';
import type {StageConfig,Plan} from './plan.ts';
export type LauncherConfig={kind:'local-process'}|{kind:'docker';imageId?:string;tag:string;runtime:{clockTicks:number;pageBytes:number}};
export function validateLauncher(value:LauncherConfig|undefined){
  if(value===undefined||value.kind==='local-process')return;
  if(value.kind!=='docker')throw Error('Unknown run-unit launcher');
  new DockerLauncher(value.imageId??'',value.runtime,value.tag);
}
export async function freezeLauncher(stage:StageConfig){
  const value=stage.launcher;if(!value||value.kind==='local-process')return;
  const info=JSON.parse((await docker(['image','inspect','ditto-sec1-bfcl-web:'+value.tag])).stdout)[0];
  if(value.imageId&&value.imageId!==info.Id)throw Error('Configured image ID differs from tag');
  if(info.Config.Labels?.['sec1.owner']!=='ditto-sec1-bfcl-web'||info.Config.Labels?.['sec1.complete']!=='true')throw Error('Not a complete owned image');
  await verifyWorktreeImage(ROOT,info,value.tag);
  value.imageId=info.Id;validateLauncher(value);
}
export function launcherFor(root:string,plan:Plan){
  const value=plan.stage.launcher;validateLauncher(value);
  return value?.kind==='docker'?new DockerLauncher(value.imageId!,value.runtime,value.tag,root):new LocalProcessLauncher(join(root,'scheduler','units'));
}
export function checkFrozenMounts(root:string,plan:Plan){
  if(plan.stage.launcher?.kind!=='docker')return;
  for(const job of plan.jobs)for(const unit of job.units){
    const attempt=join(resolve(root),'blocks',job.blockId,unit.configId,`r${job.round}`,'attempt-1');
    for(const [name,target] of [['logs','/unit'],['output','/output'],['guards','/guard']]){
      try{mountPath(join(attempt,name));}catch(error){throw Error(`Cannot freeze ${job.key}/${unit.configId} mount ${target}: ${String(error)}`);}
    }
  }
}
export function requireFTemp(){
  const prefix='F:/Academic/Ditto/experiments/sec1/_tmp/';
  for(const name of ['TEMP','TMP']){
    const value=process.env[name];
    if(!value||!resolve(value).replaceAll('\\','/').toLowerCase().startsWith(prefix.toLowerCase()))throw Error(name+' must be set below '+prefix+' before starting the scheduler');
    mkdirSync(value,{recursive:true});
  }
}
