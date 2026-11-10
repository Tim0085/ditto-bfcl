import assert from 'node:assert/strict';
import {join,resolve} from 'node:path';
import {readFileSync} from 'node:fs';
import {publishImage} from '../src/ts/docker/release.ts';
import {docker} from '../src/ts/docker/common.ts';
import {json} from '../src/ts/scheduler/io.ts';
const out=resolve(process.argv[2]),ledger=join(out,'images.json'),version='0.0.8801',tag='ditto-sec1-bfcl:'+version,production=readFileSync('docker/images.json');
const source=JSON.parse((await docker(['image','inspect','ditto-sec1-bfcl:dev'])).stdout)[0];assert.equal(source.Config.Labels['sec1.owner'],'ditto-sec1-bfcl');json(ledger,[],true);
try{
 const row=await publishImage({version,ledger,logs:join(out,'tests')});assert.equal(row.imageId,source.Id);assert.equal(row.tests.length,27);assert(row.tests.every((t:any)=>t.exitCode===0));assert(readFileSync('docker/images.json').equals(production));
 json(join(out,'verification.json'),{status:'PASS',purpose:'Full publication gate on the isolated final source using a separate test ledger; this is not the formal exp1-v2 release',row,productionLedgerByteIdentical:true},true);console.log(JSON.stringify({status:'PASS',imageId:row.imageId,tests:row.tests.length,productionLedgerByteIdentical:true}));
}finally{
 const state=await docker(['image','inspect',tag],true);if(state.code===0){const info=JSON.parse(state.stdout)[0];assert.equal(info.Id,source.Id);assert.equal(info.Config.Labels['sec1.owner'],'ditto-sec1-bfcl');assert(info.RepoTags.includes('ditto-sec1-bfcl:dev'));await docker(['image','rm','--no-prune',tag]);assert.equal(JSON.parse((await docker(['image','inspect',source.Id])).stdout)[0].Id,source.Id);}
 assert(readFileSync('docker/images.json').equals(production));
}
