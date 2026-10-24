/** Injected page/sink only. This module launches no process or browser. */
import{createHash}from'node:crypto';
import{recordFor}from'./runtime-contract.mjs';import{shapePlan}from'./contract.mjs';
import{CAPTURE_ABI,MAX_NEW_OUTPUT_BYTES,validateHeader,validateChunk,METADATA_CAPTURE_ABI,validateMetadataHeader,validateMetadataChunk}from'./capture-contract.mjs';
export function preflightBatch(names){if(!Array.isArray(names)||names.length<1||names.length>4||new Set(names).size!==names.length)throw new Error('At most4 distinct fixtures per60second batch');let bytes=0;for(const name of names){const pin=recordFor(name);bytes+=shapePlan(pin.m,pin.n).stageBytes+16384;}if(bytes>MAX_NEW_OUTPUT_BYTES)throw new Error('Batch output cap');return Object.freeze({cases:names.length,maximumOutputBytes:bytes,maximumWallMilliseconds:60000,processGuardRequired:true});}
async function streamFromPage(page,makeSink,{signal=new AbortController().signal}={},wire){
 let header,sink,constructionStarted=false,committed=false,closed=false,cancellation,primary;
 const call=(method,message)=>page.call(wire.methods[method],message);
 const check=()=>signal.throwIfAborted();
 const abort=()=>{cancellation??=call('cancelActive').catch(()=>{});};
 signal.addEventListener('abort',abort,{once:true});
 try{
  check();header=await call('startSelected');wire.header(header);check();
  // Parent ownership precedes even factory invocation. The cleanup handle must
  // exist synchronously before any acquisition task can create a resource.
  await call('open',{abi:wire.abi,id:header.id,kind:'open',total:header.total,hash:header.hash});check();
  constructionStarted=true;const candidate=makeSink(header);
  if(candidate&&typeof candidate.then==='function'){Promise.resolve(candidate).catch(()=>{});throw new Error('Capture factory must return a synchronous managed handle');}
  if(!candidate||['acquire','write','finish','abort'].some(name=>typeof candidate[name]!=='function'))throw new Error('Capture managed handle incomplete');
  sink=Object.freeze(Object.fromEntries(['acquire','write','finish','abort'].map(name=>[name,candidate[name].bind(candidate)])));
  check();await sink.acquire();check();
  let sequence=0,offset=0;
  while(offset<header.total){
   check();const packet=await call('chunk',{abi:wire.abi,id:header.id,kind:'next',sequence,offset,total:header.total});
   const count=wire.chunk(packet,header,sequence,offset),buffer=Buffer.allocUnsafeSlow(count);for(let i=0;i<count;i++)buffer[i]=packet.data[i];
   const hash=createHash('sha256').update(buffer).digest('hex');if(hash!==packet.hash)throw new Error('Capture chunk checksum changed');
   await sink.write(buffer,offset);check();
   await call('ack',{abi:wire.abi,id:header.id,kind:'written',sequence,offset,total:header.total,bytes:count,hash});sequence++;offset+=count;
  }
  check();const result=await sink.finish();closed=result.closed===true;
  if(!closed||result.bytes!==header.total||result.hash!==header.hash)throw new Error('Capture complete file checksum/closure changed');check();
  const acknowledgement=await call('close',{abi:wire.abi,id:header.id,kind:'close',sequence,offset,total:header.total,hash:result.hash,closed:true});
  if(acknowledgement?.id!==header.id||acknowledgement.closed!==true||acknowledgement.hash!==header.hash||acknowledgement.total!==header.total)throw new Error('Capture final acknowledgement changed');
  committed=true;return Object.freeze({header,file:result,closed:true});
 }catch(error){primary=error;throw error;}finally{
  try{
  signal.removeEventListener('abort',abort);
  if(cancellation)await cancellation;
  if(!committed){
   // No parent-close assertion until pending writes/hash/close/unlink actually
   // settle. A failed cleanup retains the page receipt rather than inventing it.
   if(sink){const result=await sink.abort();closed=result?.closed===true;if(!closed)throw new Error('Capture cleanup closure unconfirmed');}
   else closed=!constructionStarted;
   if(closed){try{const state=await call('cancelActive');const id=state?.id??header?.id;if(id)await call('abortClosed',{abi:wire.abi,id,kind:'aborted',closed:true});}catch(error){if(wire.preserveFailures)throw error; /* Closed/terminated page is separately verified by the external process guard. */ }}
  }
  }catch(error){if(wire.preserveFailures&&primary&&error!==primary)throw new AggregateError([primary,error],String(primary.message??primary)+'; cleanup: '+String(error.message??error));throw error;}
 }
}
const attentionMethods=Object.freeze(Object.fromEntries(['startSelected','open','chunk','ack','close','cancelActive','abortClosed'].map(x=>[x,x])));
const metadataMethods=Object.freeze({startSelected:'startAdapterMetadata',open:'openMetadata',chunk:'metadataChunk',ack:'ackMetadata',close:'closeMetadata',cancelActive:'cancelMetadata',abortClosed:'abortMetadataClosed'});
export function captureFromPage(page,makeSink,options={}){return streamFromPage(page,makeSink,options,{methods:attentionMethods,header:validateHeader,chunk:validateChunk,abi:CAPTURE_ABI,preserveFailures:true});}
export async function metadataFromOwnedPage(page,makeSink,beforeWork,options={}){if(typeof beforeWork!=='function')throw new Error('Fresh metadata ownership ACK required');options.signal?.throwIfAborted();await beforeWork();options.signal?.throwIfAborted();return streamFromPage(page,makeSink,options,{methods:metadataMethods,header:validateMetadataHeader,chunk:validateMetadataChunk,abi:METADATA_CAPTURE_ABI,preserveFailures:true});}
export function playwrightPageAdapter(page){const methods=new Set(['status','startSelected','open','chunk','ack','close','abortClosed','cancelActive','metadataStatus','startAdapterMetadata','openMetadata','metadataChunk','ackMetadata','closeMetadata','cancelMetadata','abortMetadataClosed']);return Object.freeze({call(method,message){if(!methods.has(method))throw new Error('Unknown private capture method');return page.evaluate(({method,message})=>{const bridge=globalThis.aurialisPrivateAttentionCapture;if(!bridge||!Object.hasOwn(bridge,method)||typeof bridge[method]!=='function')throw new Error('Private capture bridge unavailable');return bridge[method](message);},{method,message});}});}
