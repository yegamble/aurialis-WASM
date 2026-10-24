/** No app imports. Whole-file precharge/snapshot precedes reads, hashes or Worker. */
import { shapePlan,parseFixture } from './contract.mjs';
import { analyzeStages } from './propagated.mjs';
import { RUNTIME_ABI,MODEL_CONTRACT,DEADLINE_MS,recordFor,allocationPlan,METADATA_ABI,METADATA_APPLICATION_BYTES,decodeMetadata } from './runtime-contract.mjs';
import { SHADER_SHA256 } from './shader.mjs';
let owner=null;
// Capture the real internal-slot getter/transfer primitive before publishing any
// caller-visible receipt. Own properties cannot hide an allocated backing store.
const applyIntrinsic=Reflect.apply;
const arrayBufferByteLength=Object.getOwnPropertyDescriptor(ArrayBuffer.prototype,'byteLength').get;
const typedArrayBuffer=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Float32Array.prototype),'buffer').get;
const transferClone=globalThis.structuredClone;
const bufferBytes=buffer=>applyIntrinsic(arrayBufferByteLength,buffer,[]);
const backingBuffer=view=>applyIntrinsic(typedArrayBuffer,view,[]);
const hash=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');
/** Dependencies are injected only by source-only tests; defaults create no GPU. */
export function createAttentionClient(environment={}){
  const reserve=environment.reserve??(bytes=>{if(bytes>16*1024*1024)throw new Error('Attention memory denied');return{release(){}};}),read=environment.read??(blob=>blob.arrayBuffer()),digest=environment.digest??hash,makeWorker=environment.makeWorker??(()=>new Worker(new URL('./worker.mjs',import.meta.url),{type:'module'}));
  return Object.freeze({run(name,blob,signal=new AbortController().signal){
    signal.throwIfAborted();if(owner)throw new Error('One attention fixture active; no queue');
    const record=recordFor(name),plan=shapePlan(record.m,record.n),allocation=allocationPlan(plan);
    if(!(blob instanceof Blob)||blob.size!==record.bytes)throw new Error('Attention Blob geometry changed');
    const lease=reserve(plan.chargedApplicationBytes);if(!lease||typeof lease.release!=='function')throw new Error('Invalid attention memory lease');
    const token={};owner=token;let worker,workerReject,snapshot,readBuffer,canceled,settled=false,cleanupTimer,receipt,comparison,resultBuffer,released=false;
    const ownedBuffers=[];
    const remember=buffer=>{try{bufferBytes(buffer);}catch{return;}ownedBuffers.push(buffer);};
    let resolveUser,rejectUser,resolveReleased;const fullyReleased=new Promise(resolve=>{resolveReleased=resolve;});
    const returned=new Promise((resolve,reject)=>{resolveUser=resolve;rejectUser=reject;});
    Object.defineProperty(returned,'whenSettled',{value:()=>fullyReleased});
    const settle=(error,value)=>{if(settled)return;settled=true;if(error)rejectUser(error);else resolveUser(value);};
    const release=()=>{
      if(released)return;
      clearTimeout(deadline);clearTimeout(cleanupTimer);signal.removeEventListener('abort',abort);
      if(worker){worker.onmessage=null;worker.onerror=null;worker.onmessageerror=null;worker.terminate();}
      // The inventory was captured privately before publication. Neither exposed
      // maps, typed-array .buffer properties nor ArrayBuffer .byteLength shadows
      // are consulted. Previously detached entries are safe to skip.
      const live=[...new Set(ownedBuffers)].filter(buffer=>bufferBytes(buffer)>0);
      if(live.length)transferClone(null,{transfer:live});
      if(ownedBuffers.some(buffer=>bufferBytes(buffer)!==0))throw new Error('Attention backing stores remain owned');
      snapshot=undefined;readBuffer=undefined;lease.release();released=true;if(owner===token)owner=null;resolveReleased();
    };
    const cancel=error=>{if(canceled)return;canceled=error;if(receipt){release();return;}settle(error);if(worker){try{worker.postMessage({abi:RUNTIME_ABI,id:token.id,kind:'cancel'});}catch{}cleanupTimer=setTimeout(()=>{worker.terminate();workerReject?.(error);},50);}};
    const abort=()=>cancel(signal.reason instanceof Error?signal.reason:new DOMException('Attention canceled','AbortError'));
    const deadline=setTimeout(()=>cancel(new Error('Attention fixture deadline; prompt GPU preemption is not guaranteed')),DEADLINE_MS);
    signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
    const check=()=>{if(canceled)throw canceled;signal.throwIfAborted();};
    void(async()=>{
      // Underlying Blob reads/digests cannot be aborted. The owner and lease
      // remain held until they actually settle, even if the caller has rejected.
      readBuffer=await read(blob);remember(readBuffer);check();if(!(readBuffer instanceof ArrayBuffer)||readBuffer.byteLength!==record.bytes)throw new Error('Attention read geometry changed');
      snapshot=readBuffer.slice(0);remember(snapshot);transferClone(null,{transfer:[readBuffer]});readBuffer=undefined;const actualHash=await digest(snapshot);check();if(actualHash!==record.sha256)throw new Error('Attention fixture checksum changed');
      const fixture=parseFixture(snapshot);token.id=crypto.randomUUID();worker=makeWorker();
      const report=await new Promise((resolve,reject)=>{
        workerReject=reject;worker.onerror=()=>reject(new Error('Attention Worker failed'));worker.onmessageerror=()=>reject(new Error('Attention transfer failed'));
        worker.onmessage=event=>{try{const data=event.data;if(!data||data.abi!==RUNTIME_ABI||data.id!==token.id||!['result','error'].includes(data.kind))throw new Error('Attention result identity changed');if(data.kind==='error')throw new Error(String(data.error).slice(0,1024));resolve(data.report);}catch(error){reject(error);}};
        const transfer=snapshot.slice(0);remember(transfer);worker.postMessage({abi:RUNTIME_ABI,id:token.id,model:MODEL_CONTRACT,kind:'attention',name,fixture:transfer},[transfer]);
      });check();
      resultBuffer=report?.result;remember(resultBuffer);
      if(!report||report.model!==MODEL_CONTRACT||report.shaderSHA256!==SHADER_SHA256||report.fixtureSHA256!==record.sha256||report.passes!==8||report.cleanupComplete!==true||report.canariesIntact!==true||report.chargedApplicationBytes!==plan.chargedApplicationBytes||report.gpuBytes!==allocation.gpuBytes||report.gpuWork!==plan.gpuWork||report.integerControlUpperBound!==allocation.integerControlUpperBound)throw new Error('Unpinned/incomplete attention report');
      comparison=analyzeStages(fixture,resultBuffer);
      for(const map of [comparison.bounds,comparison.grids])for(const view of Object.values(map))remember(backingBuffer(view));
      Object.freeze(ownedBuffers);check();clearTimeout(deadline);worker.terminate();worker.onmessage=null;worker.onerror=null;worker.onmessageerror=null;
      receipt=Object.freeze({...report,comparison,dispose:release});settle(null,receipt);
    })().catch(error=>settle(canceled??error)).finally(()=>{if(!receipt)release();});
    return returned;
  },metadata(signal=new AbortController().signal){
    signal.throwIfAborted();if(owner)throw new Error('One attention operation active; no queue');
    const lease=reserve(METADATA_APPLICATION_BYTES);if(!lease||typeof lease.release!=='function')throw new Error('Invalid metadata memory lease');
    const token={};owner=token;let worker,terminate,raw,receipt,workerReject,canceled,settled=false,released=false,cleanupTimer,resolveUser,rejectUser,resolveReleased;
    const fullyReleased=new Promise(resolve=>{resolveReleased=resolve;}),returned=new Promise((resolve,reject)=>{resolveUser=resolve;rejectUser=reject;});Object.defineProperty(returned,'whenSettled',{value:()=>fullyReleased});
    const settle=(error,value)=>{if(settled)return;settled=true;if(error)rejectUser(error);else resolveUser(value);};
    const release=()=>{if(released)return;clearTimeout(deadline);clearTimeout(cleanupTimer);signal.removeEventListener('abort',abort);if(worker){worker.onmessage=null;worker.onerror=null;worker.onmessageerror=null;terminate();}if(raw&&bufferBytes(raw)>0)transferClone(null,{transfer:[raw]});if(raw&&bufferBytes(raw)!==0)throw new Error('Metadata backing store remains owned');raw=undefined;lease.release();released=true;if(owner===token)owner=null;resolveReleased();};
    const cancel=error=>{if(canceled)return;canceled=error;if(receipt){release();return;}settle(error);if(worker){try{worker.postMessage({abi:METADATA_ABI,id:token.id,kind:'cancel'});}catch{}cleanupTimer=setTimeout(()=>{terminate();workerReject?.(error);},50);}};
    const abort=()=>cancel(signal.reason instanceof Error?signal.reason:new DOMException('Metadata canceled','AbortError'));
    const deadline=setTimeout(()=>cancel(new Error('Metadata deadline; host request settlement is not guaranteed by termination')),DEADLINE_MS);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
    const check=()=>{if(canceled)throw canceled;signal.throwIfAborted();};
    void(async()=>{check();token.id=crypto.randomUUID();worker=makeWorker();terminate=worker.terminate.bind(worker);
      const incoming=await new Promise((resolve,reject)=>{workerReject=reject;worker.onerror=()=>reject(new Error('Metadata Worker failed'));worker.onmessageerror=()=>reject(new Error('Metadata transfer failed'));worker.onmessage=event=>{try{const data=event.data;if(!data||data.abi!==METADATA_ABI||data.id!==token.id)throw new Error('Metadata result identity changed');if(data.kind==='error'){if(Object.keys(data).sort().join('|')!=='abi|error|id|kind')throw new Error('Metadata error fields changed');throw new Error(String(data.error).slice(0,1024));}if(data.kind!=='metadata-result'||Object.keys(data).sort().join('|')!=='abi|id|json|kind')throw new Error('Metadata result fields changed');resolve(data.json);}catch(error){reject(error);}};worker.postMessage({abi:METADATA_ABI,id:token.id,kind:'adapter-metadata'});});
      // Transfer ownership is recorded before geometry/parse refusal. Worker
      // producer state ends before parse; no parsed object survives this call.
      bufferBytes(incoming);raw=incoming;check();worker.onmessage=null;worker.onerror=null;worker.onmessageerror=null;terminate();decodeMetadata(raw);check();clearTimeout(deadline);
      receipt=Object.freeze({metadata:true,result:raw,dispose:release});settle(null,receipt);
    })().catch(error=>settle(canceled??error)).finally(()=>{if(!receipt)release();});return returned;
  }});
}
