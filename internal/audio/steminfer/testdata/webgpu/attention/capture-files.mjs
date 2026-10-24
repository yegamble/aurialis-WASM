/** Device-local numerical evidence only, random private files; no process/network. */
import{mkdtemp,chmod,open,rename,unlink,rmdir,statfs}from'node:fs/promises';import{constants}from'node:fs';import path from'node:path';import{createHash}from'node:crypto';
import{MAX_NEW_OUTPUT_BYTES,validateHeader}from'./capture-contract.mjs';
export function createFileSinkFactory(root){
 if(typeof root!=='string'||!path.isAbsolute(root)||!Number.isInteger(constants.O_NOFOLLOW))throw new Error('Private absolute output root/no-follow support required');
 let active=false,retainedBytes=0;const seen=new Set();
 return async header=>{
  validateHeader(header);if(active||seen.has(header.name))throw new Error('One capture file active; duplicate fixture refused');
  const reservation=header.total+16384;if(retainedBytes+reservation>MAX_NEW_OUTPUT_BYTES)throw new Error('Capture output admission exceeded');
  active=true;retainedBytes+=reservation;let directory,handle,pending=Promise.resolve(),position=0,closed=false,renamed=false,aborted=false,writing=false,finishing=false,abortTask,finalHash;const hash=createHash('sha256');
  const intrinsicLength=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype),'byteLength').get;
  const remove=async name=>{try{await unlink(name);}catch(error){if(error.code!=='ENOENT')throw error;}};
  try{
   const free=await statfs(root,{bigint:true});if(free.bavail*free.bsize<6n*1024n**3n)throw new Error('Capture free-disk reserve unavailable');
   directory=await mkdtemp(path.join(root,'attention-capture-'));await chmod(directory,0o700);
   handle=await open(path.join(directory,'stages.bin.part'),constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
  }catch(error){if(handle)await handle.close();if(directory){await remove(path.join(directory,'stages.bin.part'));await rmdir(directory);}retainedBytes-=reservation;active=false;throw error;}
  return Object.freeze({
   async write(buffer,offset){const bytes=Buffer.isBuffer(buffer)?Reflect.apply(intrinsicLength,buffer,[]):0;if(closed||aborted||writing||finishing||!Buffer.isBuffer(buffer)||bytes<1||bytes>2048||offset!==position||position+bytes>header.total)throw new Error('Capture file write geometry/order changed');
    // Set pending before the first await. Abort waits this exact operation.
    const snapshot=Buffer.allocUnsafeSlow(bytes);for(let i=0;i<bytes;i++)snapshot[i]=buffer[i];
    writing=true;const task=(async()=>{let written=0;while(written<bytes){const result=await handle.write(snapshot,written,bytes-written,position+written);if(result.bytesWritten<1||result.bytesWritten>bytes-written)throw new Error('Capture file write stalled');written+=result.bytesWritten;}hash.update(snapshot);position+=bytes;})();pending=task;try{await task;}finally{writing=false;}
   },
   async finish(){
    if(closed||aborted||writing||finishing||position!==header.total)throw new Error('Capture file truncated/closed');finishing=true;
    const task=(async()=>{finalHash=hash.digest('hex');if(finalHash!==header.hash)throw new Error('Capture final file checksum changed');await handle.close();closed=true;
    const reader=await open(path.join(directory,'stages.bin.part'),constants.O_RDONLY|constants.O_NOFOLLOW);
    try{const state=await reader.stat();if(!state.isFile()||state.size!==header.total)throw new Error('Closed capture file geometry changed');const observed=createHash('sha256'),chunk=Buffer.allocUnsafeSlow(2048);let offset=0;while(offset<header.total){const read=await reader.read(chunk,0,Math.min(2048,header.total-offset),offset);if(read.bytesRead<1)throw new Error('Closed capture file truncated');observed.update(chunk.subarray(0,read.bytesRead));offset+=read.bytesRead;}if(observed.digest('hex')!==header.hash)throw new Error('Closed capture file checksum changed');}finally{await reader.close();}
    await rename(path.join(directory,'stages.bin.part'),path.join(directory,'stages.bin'));renamed=true;if(aborted)throw new Error('Capture file aborted');active=false;seen.add(header.name);return Object.freeze({path:path.join(directory,'stages.bin'),bytes:position,hash:finalHash,closed:true});})();pending=task;return task;
   },
   abort(){if(abortTask)return abortTask;aborted=true;abortTask=(async()=>{try{await pending;}catch{}if(!closed){await handle.close();closed=true;}await remove(path.join(directory,renamed?'stages.bin':'stages.bin.part'));await rmdir(directory);retainedBytes-=reservation;seen.delete(header.name);active=false;})();return abortTask;}

  });
 };
}
