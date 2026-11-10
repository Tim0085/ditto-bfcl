import {openSync,readSync,closeSync,writeFileSync,mkdirSync,linkSync,unlinkSync,existsSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {StringDecoder} from 'node:string_decoder';
import {randomUUID,createHash} from 'node:crypto';

/** Only a chunk and one input record are decoded at once, including CRLF/tails. */
export function* jsonRows(path:string,strict=false):Generator<any>{
  if(!existsSync(path))return;let fd:number|undefined,line=0,carry='';const decoder=new StringDecoder('utf8'),buffer=Buffer.allocUnsafe(64*1024);
  const parse=(raw:string)=>{line++;try{const row=JSON.parse(raw);if(!strict&&(!row||typeof row!=='object'||Array.isArray(row)))throw Error('Object required');return row;}catch(error){if(strict)throw new SyntaxError(`Invalid JSONL ${path}:${line}: ${String(error)}`);return {malformed:true,source:path,line,reason:'Invalid auxiliary JSONL record'};}};
  try{
    fd=openSync(path,'r');for(;;){const n=readSync(fd,buffer,0,buffer.length,null);if(!n)break;carry+=decoder.write(buffer.subarray(0,n));let at:number;
      while((at=carry.indexOf('\n'))>=0){const raw=carry.slice(0,at);carry=carry.slice(at+1);if(raw)yield parse(raw);}
    }
    carry+=decoder.end();if(carry)yield parse(carry);
  }catch(error){if(strict)throw error;yield {malformed:true,source:path,reason:String(error)};}finally{if(fd!==undefined)closeSync(fd);}
}

/** Complete same-directory pending file, then exclusive publication. */
export class DetailTable {
  readonly pending:string;private fd:number;private buffer='';private closed=false;count=0;utf16CodeUnits=0;utf8Bytes=0;
  constructor(readonly path:string,readonly format:'jsonl'|'json-array'='jsonl'){
    mkdirSync(dirname(path),{recursive:true});this.pending=path+'.pending-'+randomUUID();this.fd=openSync(this.pending,'wx');
  }
  push(row:any){
    if(this.closed)throw Error('Export table is closed');
    const encoded=JSON.stringify(row,this.format==='json-array'?null:undefined,this.format==='json-array'?2:undefined);
    if(encoded===undefined)throw Error('Export row is not JSON serializable');
    const piece=this.format==='jsonl'?encoded+'\n':(this.count?',\n':'[\n')+encoded.split('\n').map(s=>'  '+s).join('\n');this.buffer+=piece;this.utf16CodeUnits+=piece.length;this.utf8Bytes+=Buffer.byteLength(piece);this.count++;
    if(this.buffer.length>=1024*1024)this.flush();
  }
  private flush(){if(this.buffer){writeFileSync(this.fd,this.buffer);this.buffer='';}}
  finish(){
    if(this.closed)throw Error('Export table already closed');
    const tail=this.format==='json-array'?(this.count?'\n]\n':'[]\n'):'';this.buffer+=tail;this.utf16CodeUnits+=tail.length;this.utf8Bytes+=Buffer.byteLength(tail);this.flush();closeSync(this.fd);this.closed=true;
    try{linkSync(this.pending,this.path);}finally{unlinkSync(this.pending);}
    return {file:this.path.slice(this.path.lastIndexOf('/')+1).split('\\').at(-1)!,format:this.format,encoding:'utf-8',rows:this.count,utf16CodeUnits:this.utf16CodeUnits,utf8Bytes:this.utf8Bytes};
  }
  abort(){if(!this.closed){closeSync(this.fd);this.closed=true;}if(existsSync(this.pending))unlinkSync(this.pending);}
}
export function jsonArray(path:string,rows:Iterable<any>){const writer=new DetailTable(path,'json-array');try{for(const row of rows)writer.push(row);return writer.finish();}finally{writer.abort();}}
export function fileHash(path:string){const h=createHash('sha256'),fd=openSync(path,'r'),b=Buffer.allocUnsafe(1024*1024);try{for(;;){const n=readSync(fd,b,0,b.length,null);if(!n)break;h.update(b.subarray(0,n));}}finally{closeSync(fd);}return h.digest('hex');}
export const exportRows=(directory:string,name:string)=>jsonRows(join(directory,name+'.jsonl'));
export function fileEqual(a:string,b:string){const fa=openSync(a,'r');let fb:number|undefined;const x=Buffer.allocUnsafe(1024*1024),y=Buffer.allocUnsafe(x.length);try{fb=openSync(b,'r');for(;;){const nx=readSync(fa,x,0,x.length,null),ny=readSync(fb,y,0,y.length,null);if(nx!==ny)return false;if(!nx)return true;if(!x.subarray(0,nx).equals(y.subarray(0,ny)))return false;}}finally{closeSync(fa);if(fb!==undefined)closeSync(fb);}}
