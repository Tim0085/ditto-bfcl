import { readFile,writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DockerLauncher } from '../src/ts/docker/launcher.ts';
const {spec,imageId,runtime}=JSON.parse(await readFile(process.argv[2],'utf8'));
const unit=await new DockerLauncher(imageId,runtime).start(spec);
void unit.wait().catch(error=>{console.error(error);process.exit(1);});
const deadline=Date.now()+30000;
for(;;){
  try{
    const lock=JSON.parse(await readFile(join(spec.logDir,'collector.lock'),'utf8'));
    if(!/^[a-f0-9]{64}$/.test(lock.containerId))throw Error('Lock ID must be full');
    await writeFile(join(spec.logDir,'child-lock.json'),JSON.stringify(lock));
    console.log(JSON.stringify({exitWithPendingWait:true,lock}));process.exit(0);
  }catch(error:any){if(error.code!=='ENOENT')throw error;}
  if(Date.now()>deadline)throw Error('No collector lock');
  await new Promise(r=>setTimeout(r,25));
}
