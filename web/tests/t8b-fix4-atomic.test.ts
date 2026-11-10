import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
test('publish and request-history rename share Windows transient-error retry; other errors remain failures',async()=>{
  const dir=await fs.mkdtemp(join(tmpdir(),'t8b-fix4-rename-')),original=fs.rename;let attempts=0;
  fs.rename=async(...args)=>{if(++attempts<=3)throw Object.assign(Error('transient file sharing'),{code:['EPERM','EACCES','EBUSY'][attempts-1]});return original(...args);};syncBuiltinESMExports();
  try{
    const {save,renameWithRetry}=await import('../src/ts/docker/common.ts');
    await save(join(dir,'requested.tmp'),{status:'requested'});assert.equal(attempts,4);
    attempts=0;await renameWithRetry(join(dir,'requested.tmp'),join(dir,'request.json'));assert.equal(attempts,4);
    assert.deepEqual(JSON.parse(await fs.readFile(join(dir,'request.json'),'utf8')),{status:'requested'});
    await assert.rejects(renameWithRetry(join(dir,'missing'),join(dir,'target')),{code:'ENOENT'});
    console.log(JSON.stringify({publishAttempts:4,requestHistoryAttempts:4,otherErrorsNotRetried:true,dir}));
  }finally{fs.rename=original;syncBuiltinESMExports();}
});
