/** Injected page/sink only. This module launches no process or browser. */
import{createHash}from'node:crypto';
import{recordFor}from'./runtime-contract.mjs';import{shapePlan}from'./contract.mjs';
import{CAPTURE_ABI,MAX_NEW_OUTPUT_BYTES,validateHeader,validateChunk}from'./capture-contract.mjs';
export function preflightBatch(names){if(!Array.isArray(names)||names.length<1||names.length>4||new Set(names).size!==names.length)throw new Error('At most4 distinct fixtures per60second batch');let bytes=0;for(const name of names){const pin=recordFor(name);bytes+=shapePlan(pin.m,pin.n).stageBytes+16384;}if(bytes>MAX_NEW_OUTPUT_BYTES)throw new Error('Batch output cap');return Object.freeze({cases:names.length,maximumOutputBytes:bytes,maximumWallMilliseconds:60000,processGuardRequired:true});}
export async function captureFromPage(page,makeSink,{signal=new AbortController().signal}={}){
 let header,sink,committed=false,closed=false,cancellation;
 const call=(method,message)=>page.call(method,message);
 const check=()=>signal.throwIfAborted();
 const abort=()=>{cancellation??=call('cancelActive').catch(()=>{});};
 signal.addEventListener('abort',abort,{once:true});
 try{
  check();header=await call('startSelected');validateHeader(header);check();
  sink=await makeSink(header);check();await call('open',{abi:CAPTURE_ABI,id:header.id,kind:'open',total:header.total,hash:header.hash});
  let sequence=0,offset=0;
  while(offset<header.total){
   check();const packet=await call('chunk',{abi:CAPTURE_ABI,id:header.id,kind:'next',sequence,offset,total:header.total});
   const count=validateChunk(packet,header,sequence,offset),buffer=Buffer.allocUnsafeSlow(count);for(let i=0;i<count;i++)buffer[i]=packet.data[i];
   const hash=createHash('sha256').update(buffer).digest('hex');if(hash!==packet.hash)throw new Error('Capture chunk checksum changed');
   await sink.write(buffer,offset);check();
   await call('ack',{abi:CAPTURE_ABI,id:header.id,kind:'written',sequence,offset,total:header.total,bytes:count,hash});sequence++;offset+=count;
  }
  check();const result=await sink.finish();closed=result.closed===true;
  if(!closed||result.bytes!==header.total||result.hash!==header.hash)throw new Error('Capture complete file checksum/closure changed');check();
  const acknowledgement=await call('close',{abi:CAPTURE_ABI,id:header.id,kind:'close',sequence,offset,total:header.total,hash:result.hash,closed:true});
  if(acknowledgement?.id!==header.id||acknowledgement.closed!==true||acknowledgement.hash!==header.hash||acknowledgement.total!==header.total)throw new Error('Capture final acknowledgement changed');
  committed=true;return Object.freeze({header,file:result,closed:true});
 }finally{
  signal.removeEventListener('abort',abort);
  if(cancellation)await cancellation;
  if(!committed){
   // No parent-close assertion until pending writes/hash/close/unlink actually
   // settle. A failed cleanup retains the page receipt rather than inventing it.
   if(sink){await sink.abort();closed=true;}else closed=true;
   if(closed){try{const state=await call('cancelActive');const id=state?.id??header?.id;if(id)await call('abortClosed',{abi:CAPTURE_ABI,id,kind:'aborted',closed:true});}catch{ /* Closed/terminated page is separately verified by the external process guard. */ }}
  }
 }
}
export function playwrightPageAdapter(page){const methods=new Set(['status','startSelected','open','chunk','ack','close','abortClosed','cancelActive']);return Object.freeze({call(method,message){if(!methods.has(method))throw new Error('Unknown private capture method');return page.evaluate(({method,message})=>{const bridge=globalThis.aurialisPrivateAttentionCapture;if(!bridge||!Object.hasOwn(bridge,method)||typeof bridge[method]!=='function')throw new Error('Private capture bridge unavailable');return bridge[method](message);},{method,message});}});}
