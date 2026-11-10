import { resolve,dirname,basename } from "node:path";
import { randomUUID } from "node:crypto";
import { docker,directory,labels,removeExited,inspect,save,safePath,mountPath } from "../src/ts/docker/common.ts";
import { DockerLauncher } from "../src/ts/docker/launcher.ts";
export async function scoreInContainer(imageId:string,input:string,output:string,logDir:string,tag="dev"){
  input=safePath(resolve(input));output=safePath(resolve(output));mountPath(dirname(input));mountPath(dirname(output));await directory(dirname(output));await directory(logDir);
  await new DockerLauncher(imageId,{clockTicks:100,pageBytes:4096},tag).verifyImage();
  const runId='t8b-score',unitId=randomUUID();
  const args=['create','--pull=never','--name',`sec1-${runId}-${unitId}`,...labels(runId,unitId),'--network','none','--init','--cap-drop=ALL','--security-opt','no-new-privileges','--cpus=2','--memory=4g','--memory-swap=4g','--pids-limit=128',
    '--mount',`type=bind,source=${dirname(input)},target=/input,readonly`,'--mount',`type=bind,source=${dirname(output)},target=/output`,imageId,'python3','-B','src/python/score.py','--input',`/input/${basename(input)}`,'--output',`/output/${basename(output)}`];
  const id=(await docker(args)).stdout.trim();await docker(['start',id]);await docker(['wait',id]);const state=await inspect(id);
  const log=await docker(['logs',id]);await save(resolve(logDir,unitId+'.json'),{command:['docker',...args],state,log});await removeExited(id,runId,unitId);if(state.State.ExitCode!==0)throw Error(JSON.stringify(log));return state.State.ExitCode;
}
if(process.argv[1]?.endsWith('docker-score.ts')){const [image,input,output,logs,tag]=process.argv.slice(2);if(!logs)throw Error('Usage: docker-score.ts IMAGE_ID INPUT OUTPUT LOG_DIR [TAG]');await scoreInContainer(image,input,output,logs,tag);}
