import { readFile } from 'node:fs/promises';
import { DockerLauncher } from '../src/ts/docker/launcher.ts';
const {imageId,runtime,spec}=JSON.parse(await readFile(process.argv[2],'utf8'));
const unit=await new DockerLauncher(imageId,runtime).start(spec);
console.log(JSON.stringify({started:unit.unitId,pid:process.pid}));
// No wait(): the launching process exits while Docker owns the running unit.
