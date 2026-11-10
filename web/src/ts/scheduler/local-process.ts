import {spawn} from 'node:child_process';
import {mkdirSync,openSync,closeSync,existsSync,statSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {platform} from 'node:os';
import type {RunUnit,RunUnitLauncher,RunUnitSpec,RunUnitExit} from '../run-unit.ts';
import {ROOT,env,id,json,read,maybe,files,alive,sleep,now,log} from './io.ts';
import {connect,type Endpoint} from './control.ts';
import {killOwnedTree,findShell} from './process-tree.ts';
export class LocalProcessLauncher implements RunUnitLauncher {
  readonly kind='local-process' as const;
  constructor(readonly registry:string,readonly testImports:string[]=[],readonly startupTimeoutMs=60000){mkdirSync(registry,{recursive:true});}
  toUnitView(spec:RunUnitSpec){return spec.block;}
  async start(spec:RunUnitSpec){
    id(spec.unitId);id(spec.runId);const record=join(this.registry,spec.unitId+'.json');
    if(existsSync(record))throw new Error('Unit already registered; adopt it');
    mkdirSync(spec.logDir,{recursive:true});mkdirSync(spec.outputRoot,{recursive:true});
    json(join(spec.logDir,'spec.json'),spec,true);json(join(spec.logDir,'block.json'),this.toUnitView(spec),true);
    json(record,spec,true);const out=openSync(join(spec.logDir,'stdout.log'),'wx'),err=openSync(join(spec.logDir,'stderr.log'),'wx');
    let child;
    try{child=spawn(process.execPath,['--experimental-transform-types',join(ROOT,'src/ts/scheduler/unit-shell.ts'),join(spec.logDir,'spec.json')],{cwd:ROOT,env:env(spec.guardReportDir,this.testImports),detached:true,windowsHide:true,stdio:['ignore',out,err]});}finally{closeSync(out);closeSync(err);}
    child.on('error',error=>json(join(spec.logDir,'launch-error.json'),{error:String(error)}));child.unref();
    const spawnedAt=now(),until=Date.now()+this.startupTimeoutMs;
    while(!existsSync(join(spec.logDir,'control.json'))){if(child.exitCode!==null||existsSync(join(spec.logDir,'launch-error.json'))||Date.now()>until){
      // No start permit was issued: even a late handshake cannot import the CLI or send requests.
      let killed=false;if(child.pid&&child.exitCode===null&&child.signalCode===null&&alive(child.pid)){await killOwnedTree(child.pid,spec.guardReportDir,spawnedAt);killed=true;}
      if(!existsSync(join(spec.logDir,'exit.json')))json(join(spec.logDir,'exit.json'),{exitCode:child.exitCode??2,signal:child.signalCode??null,killed,stoppedByPlan:false,oomKilled:null,startedAt:spawnedAt,endedAt:now(),summary:null},true);
      throw new Error('Unit failed to open control channel: '+spec.unitId);
    }await sleep(25);}
    const endpoint=await connect(spec.logDir);if(endpoint.identity!==spec.runId+'/'+spec.unitId)throw new Error('Unit identity mismatch');
    json(join(spec.logDir,'start-permit.json'),{at:now(),unitId:spec.unitId},true);return this.unit(spec);
  }
  async adopt(runId:string,unitId:string){const spec=maybe<RunUnitSpec>(join(this.registry,id(unitId)+'.json'));if(!spec)return;if(spec.runId!==runId)throw new Error('Unit ownership mismatch');
    if(!existsSync(join(spec.logDir,'control.json'))&&!existsSync(join(spec.logDir,'exit.json'))){
      const deadline=statSync(join(this.registry,id(unitId)+'.json')).mtimeMs+60000;
      while(!existsSync(join(spec.logDir,'control.json'))&&Date.now()<deadline&&!existsSync(join(spec.logDir,'launch-error.json')))await sleep(50);
      if(!existsSync(join(spec.logDir,'control.json'))){const pids=await findShell(join(spec.logDir,'spec.json'),spec.guardReportDir);if(pids.length)throw new Error('Unresponsive pending launch still exists; refusing duplicate');json(join(spec.logDir,'exit.json'),{exitCode:2,signal:null,killed:false,stoppedByPlan:false,oomKilled:null,startedAt:new Date(statSync(join(this.registry,id(unitId)+'.json')).mtimeMs).toISOString(),endedAt:now(),summary:null},true);}
    }
    if(!existsSync(join(spec.logDir,'exit.json'))&&!existsSync(join(spec.logDir,'start-permit.json'))){const endpoint=await connect(spec.logDir);if(endpoint.identity!==spec.runId+'/'+spec.unitId)throw new Error('Unit identity mismatch');json(join(spec.logDir,'start-permit.json'),{at:now(),unitId:spec.unitId,adopted:true},true);}
    return this.unit(spec);}
  async list(runId:string){return files(this.registry).filter(p=>p.endsWith('.json')).map(p=>read<RunUnitSpec>(p)).filter(s=>s.runId===runId).map(s=>s.unitId).sort();}
  private unit(spec:RunUnitSpec):RunUnit{
    const directory=spec.logDir,exitPath=join(directory,'exit.json');
    const isAlive=async()=>{if(existsSync(exitPath))return false;try{await connect(directory);return true;}catch(error){if(existsSync(exitPath))return false;const endpoint=maybe<Endpoint>(join(directory,'control.json'));if(endpoint&&alive(endpoint.pid)){log(join(directory,'observations.jsonl'),{at:now(),kind:'control-unavailable-process-present'});return true;}return false;}};
    let waiting:Promise<RunUnitExit>|undefined;
    const wait=():Promise<RunUnitExit>=>waiting??=(async()=>{
      while(await isAlive())await sleep(100);
      const exit=maybe<RunUnitExit>(exitPath);if(exit)return exit;
      const endpoint=read<Endpoint>(join(directory,'control.json')),actions=maybe<any>(join(directory,'kill.json'));
      const result:RunUnitExit={exitCode:null,signal:actions?'SIGKILL':null,killed:!!actions,stoppedByPlan:existsSync(join(directory,'stop.json')),oomKilled:null,startedAt:endpoint.startedAt,endedAt:now(),summary:maybe(join(spec.outputRoot,'configs',String(spec.block.configId),'block-summary.json'))??null};
      json(exitPath,result,true);return result;
    })();
    async function command(stop=false){try{return await connect(directory,stop);}catch(error){
      // Allow normal shutdown/record publication under load, but bound a live control failure.
      const deadline=Date.now()+5000;
      for(;;){if(maybe<RunUnitExit>(exitPath))return;const e=maybe<Endpoint>(join(directory,'control.json'));
        if(e&&!alive(e.pid))return;if(Date.now()>=deadline)throw error;await sleep(50);}
    }}
    return {unitId:spec.unitId,isAlive,wait,
      stop:async reason=>{if(!await isAlive())return;json(join(directory,'stop.json'),{reason,at:now()});if(platform()==='win32')await command(true);else{const e=await command();if(e)try{process.kill(e.pid,'SIGTERM');}catch(error){if((error as any).code!=='ESRCH')throw error;}}},
      kill:async reason=>{if(!await isAlive())return;const e=await command();if(!e)return;json(join(directory,'kill.json'),{reason,at:now(),pid:e.pid});const pids=await killOwnedTree(e.pid,spec.guardReportDir,e.startedAt);log(join(directory,'control.jsonl'),{at:now(),kind:'force-kill',pids});}};
  }
}
