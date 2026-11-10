import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
/** Preserve original bytes. Only line endings / terminal newlines are accepted differences. */
export function scoreDifference(host:Buffer,container:Buffer){
  const sha=(b:Buffer)=>createHash('sha256').update(b).digest('hex');
  const parts=(b:Buffer)=>{const text=b.toString('utf8');assert(Buffer.from(text).equals(b),'valid UTF-8 required');return text.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g)!.filter(Boolean);};
  const a=parts(host),b=parts(container),body=(s:string)=>s.replace(/[\r\n]+$/,''),ending=(s:string)=>s.slice(body(s).length);
  const canonical=(bytes:Buffer)=>Buffer.from(bytes.toString('utf8').replace(/\r\n|\r/g,'\n').replace(/\n+$/,''));
  assert(canonical(host).equals(canonical(container)),'Scoring differs beyond line endings / terminal newline');
  const differences:{line:number;hostByteOffset:number;containerByteOffset:number;hostEndingHex:string;containerEndingHex:string}[]=[];
  let ao=0,bo=0;
  for(let i=0;i<Math.max(a.length,b.length);i++){
    const al=a[i]??'',bl=b[i]??'';
    assert.equal(body(al),body(bl),'non-newline line content differs');
    if(ending(al)!==ending(bl))differences.push({line:i+1,hostByteOffset:ao+Buffer.byteLength(body(al)),containerByteOffset:bo+Buffer.byteLength(body(bl)),hostEndingHex:Buffer.from(ending(al)).toString('hex'),containerEndingHex:Buffer.from(ending(bl)).toString('hex')});
    ao+=Buffer.byteLength(al);bo+=Buffer.byteLength(bl);
  }
  const trimLineWhitespace=(bytes:Buffer)=>Buffer.from(bytes.toString('utf8').replace(/\r\n|\r/g,'\n').replace(/[ \t]+$/gm,'').replace(/\n+$/,''));
  assert(trimLineWhitespace(host).equals(trimLineWhitespace(container)));
  return {accepted:true,rawBytesEqual:host.equals(container),host:{bytes:host.length,lines:a.length,sha256:sha(host)},container:{bytes:container.length,lines:b.length,sha256:sha(container)},differenceCount:differences.length,differences,onlyNewlineDifference:true,afterRemovingLineEndWhitespaceBytesEqual:true,canonicalSha256:sha(canonical(host))};
}
