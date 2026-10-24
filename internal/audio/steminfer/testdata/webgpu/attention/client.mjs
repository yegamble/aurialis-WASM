/** No app imports. Whole-file precharge/snapshot precedes reads, hashes or Worker. */
import { shapePlan,parseFixture } from './contract.mjs';
import { analyzeStages } from './propagated.mjs';
import { RUNTIME_ABI,MODEL_CONTRACT,DEADLINE_MS,recordFor,allocationPlan } from './runtime-contract.mjs';
import { SHADER_SHA256 } from './shader.mjs';
let owner=null;
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
    let resolveUser,rejectUser;const returned=new Promise((resolve,reject)=>{resolveUser=resolve;rejectUser=reject;});
    const settle=(error,value)=>{if(settled)return;settled=true;if(error)rejectUser(error);else resolveUser(value);};
    const release=()=>{if(released)return;released=true;clearTimeout(deadline);clearTimeout(cleanupTimer);signal.removeEventListener('abort',abort);if(worker){worker.onmessage=null;worker.onerror=null;worker.onmessageerror=null;worker.terminate();}const buffers=[readBuffer,snapshot,resultBuffer,...Object.values(comparison?.bounds??{}).map(a=>a.buffer),...Object.values(comparison?.grids??{}).map(a=>a.buffer)].filter(b=>b instanceof ArrayBuffer&&b.byteLength);if(buffers.length)structuredClone(null,{transfer:[...new Set(buffers)]});snapshot=undefined;lease.release();if(owner===token)owner=null;};
    const cancel=error=>{if(canceled)return;canceled=error;if(receipt){release();return;}settle(error);if(worker){try{worker.postMessage({abi:RUNTIME_ABI,id:token.id,kind:'cancel'});}catch{}cleanupTimer=setTimeout(()=>{worker.terminate();workerReject?.(error);},50);}};
    const abort=()=>cancel(signal.reason instanceof Error?signal.reason:new DOMException('Attention canceled','AbortError'));
    const deadline=setTimeout(()=>cancel(new Error('Attention fixture deadline; prompt GPU preemption is not guaranteed')),DEADLINE_MS);
    signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
    const check=()=>{if(canceled)throw canceled;signal.throwIfAborted();};
    void(async()=>{
      // Underlying Blob reads/digests cannot be aborted. The owner and lease
      // remain held until they actually settle, even if the caller has rejected.
      readBuffer=await read(blob);check();if(!(readBuffer instanceof ArrayBuffer)||readBuffer.byteLength!==record.bytes)throw new Error('Attention read geometry changed');
      snapshot=readBuffer.slice(0);structuredClone(null,{transfer:[readBuffer]});readBuffer=undefined;const actualHash=await digest(snapshot);check();if(actualHash!==record.sha256)throw new Error('Attention fixture checksum changed');
      const fixture=parseFixture(snapshot);token.id=crypto.randomUUID();worker=makeWorker();
      const report=await new Promise((resolve,reject)=>{
        workerReject=reject;worker.onerror=()=>reject(new Error('Attention Worker failed'));worker.onmessageerror=()=>reject(new Error('Attention transfer failed'));
        worker.onmessage=event=>{try{const data=event.data;if(!data||data.abi!==RUNTIME_ABI||data.id!==token.id||!['result','error'].includes(data.kind))throw new Error('Attention result identity changed');if(data.kind==='error')throw new Error(String(data.error).slice(0,1024));resolve(data.report);}catch(error){reject(error);}};
        const transfer=snapshot.slice(0);worker.postMessage({abi:RUNTIME_ABI,id:token.id,model:MODEL_CONTRACT,kind:'attention',name,fixture:transfer},[transfer]);
      });check();
      resultBuffer=report?.result;
      if(!report||report.model!==MODEL_CONTRACT||report.shaderSHA256!==SHADER_SHA256||report.fixtureSHA256!==record.sha256||report.passes!==8||report.cleanupComplete!==true||report.canariesIntact!==true||report.chargedApplicationBytes!==plan.chargedApplicationBytes||report.gpuBytes!==allocation.gpuBytes||report.gpuWork!==plan.gpuWork||report.integerControlUpperBound!==allocation.integerControlUpperBound)throw new Error('Unpinned/incomplete attention report');
      comparison=analyzeStages(fixture,resultBuffer);check();clearTimeout(deadline);worker.terminate();worker.onmessage=null;worker.onerror=null;worker.onmessageerror=null;
      receipt=Object.freeze({...report,comparison,dispose:release});settle(null,receipt);
    })().catch(error=>settle(canceled??error)).finally(()=>{if(!receipt)release();});
    return returned;
  }});
}
