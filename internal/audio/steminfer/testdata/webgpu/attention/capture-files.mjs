/** Device-local numerical evidence only, random private files; no process/network. */
import{mkdtemp,chmod,open,rename,unlink,rmdir,statfs}from'node:fs/promises';import{constants}from'node:fs';import path from'node:path';import{createHash}from'node:crypto';
import{MAX_NEW_OUTPUT_BYTES,validateHeader,validateMetadataHeader}from'./capture-contract.mjs';
const nativeIO=Object.freeze({mkdtemp,chmod,open,rename,unlink,rmdir,statfs});
/** The optional, closed I/O table is injected only by source-controlled units. */
function createSinkFactory(root,operations,metadata){
 if(typeof root!=='string'||!path.isAbsolute(root)||!Number.isInteger(constants.O_NOFOLLOW))throw new Error('Private absolute output root/no-follow support required');
 const names=Object.keys(nativeIO);if(!operations||Object.keys(operations).length!==names.length||names.some(name=>typeof operations[name]!=='function'))throw new Error('Closed file I/O operations required');
 const io=Object.freeze(Object.fromEntries(names.map(name=>[name,operations[name]])));
 let active,retainedBytes=0;const seen=new Set();
 return header=>{
  if(metadata)validateMetadataHeader(header);else validateHeader(header);const key=metadata?'adapter-metadata':header.name;if(active||seen.has(key))throw new Error('One capture file active; duplicate fixture refused');
  const total=header.total,expectedHash=header.hash,name=key,reservation=total+16384,owner=Symbol('capture-file');
  if(retainedBytes+reservation>MAX_NEW_OUTPUT_BYTES)throw new Error('Capture output admission exceeded');
  let directory,writer,reader,pending=Promise.resolve(),position=0,started=false,acquired=false,renamed=false,aborted=false,writing=false,finishing=false,abortTask,settled=false,finalHash;
  const hash=createHash('sha256'),intrinsicLength=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype),'byteLength').get;
  const remove=async filename=>{try{await io.unlink(filename);}catch(error){if(error.code!=='ENOENT')throw error;}};
  const removeDirectory=async()=>{try{await io.rmdir(directory);}catch(error){if(error.code!=='ENOENT')throw error;}};
  const part=()=>path.join(directory,metadata?'adapter-metadata.json.part':'stages.bin.part'),final=()=>path.join(directory,metadata?'adapter-metadata.json':'stages.bin');
  // Construction performs no I/O. The driver receives this complete cleanup
  // handle before acquire starts; failed acquisition retains its exact task.
  const sink=Object.freeze({
   acquire(){
    if(started||aborted)throw new Error('Capture file acquisition already started/aborted');started=true;
    const task=(async()=>{const free=await io.statfs(root,{bigint:true});if(free.bavail*free.bsize<6n*1024n**3n)throw new Error('Capture free-disk reserve unavailable');
     if(aborted)throw new Error('Capture file acquisition aborted');
     directory=await io.mkdtemp(path.join(root,'attention-capture-'));if(aborted)throw new Error('Capture file acquisition aborted');
     await io.chmod(directory,0o700);if(aborted)throw new Error('Capture file acquisition aborted');
     writer=await io.open(part(),constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);
     if(aborted)throw new Error('Capture file acquisition aborted');acquired=true;
    })();pending=task;return task;
   },
   async write(buffer,offset){const bytes=Buffer.isBuffer(buffer)?Reflect.apply(intrinsicLength,buffer,[]):0;if(!acquired||!writer||aborted||writing||finishing||!Buffer.isBuffer(buffer)||bytes<1||bytes>(metadata?256:2048)||offset!==position||position+bytes>total)throw new Error('Capture file write geometry/order changed');
    const snapshot=Buffer.allocUnsafeSlow(bytes);for(let i=0;i<bytes;i++)snapshot[i]=buffer[i];
    writing=true;const task=(async()=>{let written=0;while(written<bytes){const result=await writer.write(snapshot,written,bytes-written,position+written);if(result.bytesWritten<1||result.bytesWritten>bytes-written)throw new Error('Capture file write stalled');written+=result.bytesWritten;}hash.update(snapshot);position+=bytes;})();pending=task;try{await task;}finally{writing=false;}
   },
   async finish(){
    if(!acquired||!writer||aborted||writing||finishing||position!==total)throw new Error('Capture file truncated/closed');finishing=true;
    const task=(async()=>{finalHash=hash.digest('hex');if(finalHash!==expectedHash)throw new Error('Capture final file checksum changed');await writer.close();writer=undefined;
     reader=await io.open(part(),constants.O_RDONLY|constants.O_NOFOLLOW);
     let verificationPrimary;try{const state=await reader.stat();if(!state.isFile()||state.size!==total)throw new Error('Closed capture file geometry changed');const observed=createHash('sha256'),chunk=Buffer.allocUnsafeSlow(metadata?256:2048);let offset=0;while(offset<total){const read=await reader.read(chunk,0,Math.min(metadata?256:2048,total-offset),offset);if(read.bytesRead<1)throw new Error('Closed capture file truncated');observed.update(chunk.subarray(0,read.bytesRead));offset+=read.bytesRead;}if(observed.digest('hex')!==expectedHash)throw new Error('Closed capture file checksum changed');}catch(error){verificationPrimary=error;throw error;}finally{try{await reader.close();reader=undefined;}catch(error){if(metadata&&verificationPrimary)throw new AggregateError([verificationPrimary,error],String(verificationPrimary.message??verificationPrimary)+'; reader close: '+String(error.message??error));throw error;}}
     await io.rename(part(),final());renamed=true;if(aborted)throw new Error('Capture file aborted');if(active===owner)active=undefined;seen.add(name);return Object.freeze({path:final(),bytes:position,hash:finalHash,closed:true});})();pending=task;return task;
   },
   abort(){
    if(abortTask)return abortTask;aborted=true;
    const task=(async()=>{try{await pending;}catch{}if(reader){await reader.close();reader=undefined;}if(writer){await writer.close();writer=undefined;}
     if(directory){await remove(renamed?final():part());await removeDirectory();directory=undefined;}
     if(!settled){settled=true;retainedBytes-=reservation;seen.delete(name);if(active===owner)active=undefined;}
     return Object.freeze({closed:true});
    })();abortTask=task;void task.catch(()=>{if(abortTask===task)abortTask=undefined;});return task;
   }
  });
  active=owner;retainedBytes+=reservation;return sink;
 };
}

export function createFileSinkFactory(root,operations=nativeIO){return createSinkFactory(root,operations,false);}
export function createMetadataSinkFactory(root,operations=nativeIO){return createSinkFactory(root,operations,true);}
