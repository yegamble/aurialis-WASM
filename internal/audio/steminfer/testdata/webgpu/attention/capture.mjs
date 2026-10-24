/** Module-private receipt ownership. No browser/GPU operation without injected run. */
import {recordFor}from'./runtime-contract.mjs';import{shapePlan}from'./contract.mjs';
import{CAPTURE_ABI,CHUNK_BYTES,capturePlan,boundedSummary,checkIdentity,validHash,validID}from'./capture-contract.mjs';
const apply=Reflect.apply,byteLength=Object.getOwnPropertyDescriptor(ArrayBuffer.prototype,'byteLength').get;
const length=buffer=>apply(byteLength,buffer,[]);
const sha=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');
export function createCaptureOwner(client,{digest=sha,uuid=()=>crypto.randomUUID()}={}){
 let active=null,lastClosed='';
 const current=id=>{if(!active)throw new Error(id===lastClosed?'Capture closed':'No active capture');if(id!==active.id)throw new Error('Stale capture identity');return active;};
 const check=s=>{if(active!==s||s.canceled)throw new Error('Capture canceled');};
 const finish=s=>{
  if(s.closing)return s.closing;
  s.phase='closing';s.closing=(async()=>{if(s.operation)await s.operation.catch(()=>{});s.packet=null;s.receipt?.dispose();await s.settled;lastClosed=s.id;if(active===s)active=null;})();return s.closing;
 };
 return Object.freeze({
  status(){return Object.freeze(active?{id:active.id,name:active.pin.name,phase:active.phase,canceled:active.canceled,parentOpen:active.parentOpen,sequence:active.sequence,offset:active.offset,total:active.plan.stageBytes}:{phase:'idle',lastClosed});},
  async start(file){
   if(active)throw new Error('One capture active; no queue');
   if(!(file instanceof File))throw new Error('Select exactly one local fixture File');
   const pin=recordFor(file.name),plan=shapePlan(pin.m,pin.n);if(file.size!==pin.bytes)throw new Error('Selected fixture size changed');capturePlan(plan);
   const id=uuid();if(!validID(id)||id===lastClosed)throw new Error('Capture ID changed');
   const s={id,pin,plan,phase:'preparing',canceled:false,parentOpen:false,sequence:0,offset:0,packet:null,operation:null,receipt:null,closing:null,settled:Promise.resolve(),control:new AbortController()};active=s;
   try{
    const running=client.run(pin.name,file,s.control.signal);
    if(typeof running.whenSettled!=='function')throw new Error('Exact-run settlement latch unavailable');s.settled=running.whenSettled();
    s.receipt=await running;check(s);if(length(s.receipt.result)!==plan.stageBytes)throw new Error('Raw stage geometry changed');
    // Hash-only phase: no chunk/summary array or JSON allocation is live here.
    s.operation=digest(s.receipt.result);const hash=await s.operation;s.operation=null;check(s);if(!validHash(hash))throw new Error('Raw stage hash changed');s.hash=hash;
    const summary=boundedSummary(s.receipt,pin);s.phase='ready';
    return Object.freeze({abi:CAPTURE_ABI,id,name:pin.name,total:plan.stageBytes,chunkBytes:CHUNK_BYTES,hash,fixtureSHA256:pin.sha256,summary});
   }catch(error){s.operation=null;if(!s.receipt)s.control.abort(error);await finish(s);throw error;}
  },
  open(message){const s=current(message?.id);check(s);checkIdentity(message,s.id,'open',['abi','id','kind','total','hash']);if(s.phase!=='ready'||s.parentOpen||message.total!==s.plan.stageBytes||message.hash!==s.hash)throw new Error('Capture open changed');s.parentOpen=true;},
  async chunk(message){
   const s=current(message?.id);check(s);checkIdentity(message,s.id,'next',['abi','id','kind','sequence','offset','total']);
   if(!s.parentOpen||s.phase!=='ready'||s.operation||s.packet||s.offset===s.plan.stageBytes||message.sequence!==s.sequence||message.offset!==s.offset||message.total!==s.plan.stageBytes)throw new Error('Capture overlap/order changed');
   const count=Math.min(CHUNK_BYTES,s.plan.stageBytes-s.offset),bytes=new Uint8Array(s.receipt.result,s.offset,count);s.phase='chunk-hash';
   const operation=digest(bytes);s.operation=operation;
   try{const hash=await operation;check(s);if(!validHash(hash))throw new Error('Chunk hash changed');
    const packet=Object.freeze({abi:CAPTURE_ABI,id:s.id,kind:'chunk',sequence:s.sequence,offset:s.offset,total:s.plan.stageBytes,hash,data:Object.freeze(Array.from(bytes))});s.packet=packet;s.phase='awaiting-write';return packet;
   }finally{if(s.operation===operation)s.operation=null;}
  },
  ack(message){const s=current(message?.id);checkIdentity(message,s.id,'written',['abi','id','kind','sequence','offset','total','bytes','hash']);const p=s.packet;if(!s.parentOpen||!p||s.operation||message.sequence!==p.sequence||message.offset!==p.offset||message.total!==p.total||message.bytes!==p.data.length||message.hash!==p.hash)throw new Error('Capture write acknowledgement changed');s.offset+=p.data.length;s.sequence++;s.packet=null;s.phase='ready';},
  async close(message){const s=current(message?.id);check(s);checkIdentity(message,s.id,'close',['abi','id','kind','sequence','offset','total','hash','closed']);if(!s.parentOpen||s.packet||s.operation||s.phase!=='ready'||s.offset!==s.plan.stageBytes||message.sequence!==s.sequence||message.offset!==s.offset||message.total!==s.plan.stageBytes||message.hash!==s.hash||message.closed!==true)throw new Error('Capture incomplete or parent file not closed');await finish(s);return Object.freeze({id:s.id,closed:true,hash:s.hash,total:s.plan.stageBytes});},
  async cancel(id){const s=current(id);s.canceled=true;if(!s.receipt)s.control.abort(new Error('Capture canceled'));if(s.parentOpen)return Object.freeze({id:s.id,canceled:true,needsParentClose:true});await finish(s);return Object.freeze({id:s.id,canceled:true,needsParentClose:false});},
  async abortClosed(message){const s=current(message?.id);checkIdentity(message,s.id,'aborted',['abi','id','kind','closed']);if(message.closed!==true)throw new Error('Parent file cleanup not settled');s.canceled=true;if(!s.receipt)s.control.abort(new Error('Capture canceled'));await finish(s);return Object.freeze({id:s.id,closed:true,canceled:true});}
 });
}
