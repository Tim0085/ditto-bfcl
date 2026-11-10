import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {childEnvironment} from '../src/ts/deploy.ts';

test('fix6 temp regression under TEMP/TMP only, all three, and all absent',async()=>{
  const location=process.env.TEMP??process.env.TMP??process.env.TMPDIR;
  // A caller with no temporary directory may run only the read-only case.
  for(const mode of location?['two','three','absent']:['absent']){
    const env=childEnvironment();for(const k of ['TEMP','TMP','TMPDIR'])delete env[k];
    if(location&&mode!=='absent'){env.TEMP=location;env.TMP=location;}if(mode==='three')env.TMPDIR=location;
    const saved=[process.env.TEMP,process.env.TMP,process.env.TMPDIR];let child:ReturnType<typeof spawn>;
    try{
      // Windows spawn can supplement TEMP from the caller. Match the requested parent state.
      for(const k of ['TEMP','TMP','TMPDIR'])delete process.env[k];
      child=spawn(process.execPath,['--experimental-transform-types','--test','tests/t7-fix6-temp.test.ts'],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});
    }finally{['TEMP','TMP','TMPDIR'].forEach((k,i)=>{if(saved[i]===undefined)delete process.env[k];else process.env[k]=saved[i];});}
    let stdout='',stderr='';child.stdout!.on('data',b=>stdout+=b);child.stderr!.on('data',b=>stderr+=b);
    const code=await new Promise(r=>child.once('close',r));console.log(JSON.stringify({mode,command:['node','--experimental-transform-types','--test','tests/t7-fix6-temp.test.ts'],code,stdout,stderr}));
    assert.equal(code,0,stdout+stderr);
    if(mode==='absent'){assert(stdout.includes('"readOnly":true'));assert(!stdout.includes('"kind":"python"'));}
  }
});
