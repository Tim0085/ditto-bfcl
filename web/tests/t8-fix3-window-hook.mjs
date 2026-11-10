import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
const write=fs.writeFileSync;
fs.writeFileSync=(path,data,...args)=>{
  if(/(?:start-permit|exit|collected)\.json\.pending-/.test(String(path))){
    write(path,String(data).slice(0,17),...args);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,500);
    write(path,data);return;
  }return write(path,data,...args);
};
syncBuiltinESMExports();
