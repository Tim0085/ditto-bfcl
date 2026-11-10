import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import {syncBuiltinESMExports} from 'node:module';
import {join} from 'node:path';
const [mode,target,phase='delay']=process.argv.slice(2);
const pause=ms=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms);
if(mode==='write'){
  const write=fs.writeFileSync;
  fs.writeFileSync=(p,data,...args)=>{
    if(String(p).startsWith(target+'.pending-')){
      write(p,String(data).slice(0,17),...args);write(target+'.barrier','partial');
      if(phase==='partial')for(;;)pause(50);
      pause(500);write(p,data);
      if(phase==='before-link'){write(target+'.barrier','complete');for(;;)pause(50);}
      return;
    }return write(p,data,...args);
  };
  syncBuiltinESMExports();const {json}=await import('../src/ts/scheduler/io.ts');
  try{json(target,{pid:process.pid,payload:'x'.repeat(10000)},true);console.log('winner');}catch(e){if(e.code!=='EEXIST')throw e;console.log('exists');process.exitCode=2;}
}else if(mode==='control'){
  const {json}=await import('../src/ts/scheduler/io.ts');
  const spec=JSON.parse(fs.readFileSync(target));
  const end=net.Socket.prototype.end;
  net.Socket.prototype.end=function(...args){
    if(args[0]==='{"ok":true}\n'){
      this.destroy();fs.writeFileSync(join(spec.logDir,'ack-dropped'),'barrier');
      return this;
    }return end.apply(this,args);
  };
  const {control}=await import('../src/ts/scheduler/control.ts');
  const channel=await control(spec.logDir,spec.runId+'/'+spec.unitId,()=>{});
  if(phase==='broken'){channel.close();fs.writeFileSync(join(spec.logDir,'closed'),'closed');}
  else {
    // Autonomous exit has begun before the scheduler can issue stop. The file
    // barrier holds its final publication, independently of the stop callback.
    fs.writeFileSync(join(spec.logDir,'exiting-started'),'autonomous exit before stop');
    const timer=setInterval(()=>{if(fs.existsSync(join(spec.logDir,'release-exit'))){clearInterval(timer);json(join(spec.logDir,'exit.json'),{exitCode:0,signal:null,killed:false,stoppedByPlan:fs.existsSync(join(spec.logDir,'stop.json')),oomKilled:null,startedAt:new Date().toISOString(),endedAt:new Date().toISOString(),summary:null},true);process.exit(0);}},10);
  }
  setInterval(()=>{},1000);
}else if(mode==='docker'){
  const input=JSON.parse(fs.readFileSync(target));const write=fsp.writeFile.bind(fsp);
  fsp.writeFile=async(p,data,...args)=>{
    if(String(p).startsWith(join(input.spec.logDir,'exit.json.pending-'))){
      await write(p,String(data).slice(0,17),...args);await write(join(input.root,'partial-written'),'barrier');
      for(;;)await new Promise(r=>setTimeout(r,50));
    }return write(p,data,...args);
  };
  syncBuiltinESMExports();const {DockerLauncher}=await import('../src/ts/docker/launcher.ts');
  await (await new DockerLauncher(input.imageId,input.runtime).adopt(input.spec.runId,input.spec.unitId)).wait();
}
