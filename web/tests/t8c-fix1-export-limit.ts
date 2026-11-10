import assert from 'node:assert/strict';
import {constants} from 'node:buffer';
import {join,resolve} from 'node:path';
import {existsSync} from 'node:fs';
import {read,json} from '../src/ts/scheduler/io.ts';
const oldExport=resolve(process.argv[2]),out=resolve(process.argv[3]),rows=read(join(oldExport,'steps.json'));
// Shared references bound the input allocation; reproduce the old whole-array
// serializer's string failure without allocating a 43,200-task object graph.
const row=rows.find((r:any)=>r.taskId),prettySize=JSON.stringify(row,null,2).split('\n').map(s=>'  '+s).join('\n').length+2;
const count=Math.ceil(constants.MAX_STRING_LENGTH/prettySize)+100,synthetic=Array(count).fill(row);let error='';const target=join(out,'too-large.json');
try{json(target,synthetic,true);}catch(e){error=String(e);}
assert.match(error,/RangeError: Invalid string length/);assert(!existsSync(target));
const proof={status:'REPRODUCED',method:'Unchanged io.json whole-array JSON.stringify, shared row references, no enlarged heap',referenceRows:rows.length,rowPrettyCodeUnits:prettySize,repeatedRows:count,projectedCodeUnits:prettySize*count,maxStringLength:constants.MAX_STRING_LENGTH,error,finalFileAbsent:true,peakRssBytes:process.resourceUsage().maxRSS*1024};json(join(out,'proof.json'),proof,true);console.log(JSON.stringify(proof));
