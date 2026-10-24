/** Entirely injected SOURCE controls; never invokes navigator/GPU/browser. */
import{test}from'node:test';import assert from'node:assert/strict';import{createHash}from'node:crypto';import{readFileSync}from'node:fs';import vm from'node:vm';
import{METADATA_ABI,METADATA_APPLICATION_BYTES,metadataLedger,LIMITS,encodeMetadata,decodeMetadata,validateMetadataMessage}from'./runtime-contract.mjs';
import{executeMetadata}from'./gpu-runner.mjs';import{createAttentionClient}from'./client.mjs';import{createMetadataOwner}from'./capture.mjs';
import{METADATA_CAPTURE_ABI,METADATA_CHUNK_BYTES,validateMetadataHeader,validateMetadataChunk}from'./capture-contract.mjs';import{metadataFromOwnedPage,playwrightPageAdapter}from'./capture-driver.mjs';
const tick=()=>new Promise(resolve=>setImmediate(resolve)),hash=async b=>createHash('sha256').update(new Uint8Array(b.buffer??b,b.byteOffset??0,b.byteLength)).digest('hex');
const info=()=>({vendor:'',architecture:'',device:'',description:'',isFallbackAdapter:false}),limits=()=>Object.fromEntries(LIMITS.map(k=>[k,2**20]));
function report(){return{version:1,secureContext:true,request:'default-no-hints',info:info(),features:[],limits:limits(),device:'not-requested',attribution:'LIMITED',scope:'private-adapter-metadata-only'};}
const message={abi:METADATA_ABI,id:'source-unit',kind:'adapter-metadata'};
function adapter(){return{info:info(),features:new Set(['shader-f16']),limits:limits(),get requestDevice(){throw new Error('No device may be requested');}};}
function environment(value=adapter()){return{gpu:{async requestAdapter(...args){assert.deepEqual(args,[]);return value;}},secureContext:true,check(){}};}
function fakeClient(mode='success'){
 let charged=0,releases=0,worker,lastMessage;
 const client=createAttentionClient({reserve(bytes){assert.equal(bytes,METADATA_APPLICATION_BYTES);charged+=bytes;return{release(){charged-=bytes;releases++;}};},makeWorker(){worker={terminations:0,terminate(){this.terminations++;},postMessage(data){lastMessage=data;if(data.kind==='cancel'||mode==='held')return;queueMicrotask(()=>{if(mode==='error')worker.onerror?.({});else worker.onmessage?.({data:{abi:METADATA_ABI,id:data.id,kind:'metadata-result',json:encodeMetadata(report())}});});}};return worker;}});
 return{client,get worker(){return worker;},get message(){return lastMessage;},get charged(){return charged;},get releases(){return releases;}};
}
function ownerFixture(){let disposed=0,resolveRelease;const raw=encodeMetadata(report()),release=new Promise(resolve=>{resolveRelease=resolve;});const receipt={result:raw,dispose(){if(disposed)return;disposed++;structuredClone(null,{transfer:[raw]});resolveRelease();}};const client={metadata(){const p=Promise.resolve(receipt);Object.defineProperty(p,'whenSettled',{value:()=>release});return p;}};const owner=createMetadataOwner(client,{digest:hash,uuid:()=>`metadata-unit-${disposed}`});return{owner,raw,get disposed(){return disposed;}};}
const methods={startAdapterMetadata:'start',openMetadata:'open',metadataChunk:'chunk',ackMetadata:'ack',closeMetadata:'close',abortMetadataClosed:'abortClosed'};
function pageFor(f,intercept=()=>{}){return{async call(method,data){const result=method==='cancelMetadata'?await f.owner.cancel(f.owner.status().id):await f.owner[methods[method]](data);return intercept(method,result)??result;}};}
function sink(){const parts=[];return{parts,async acquire(){},async write(value,offset){assert.equal(offset,parts.reduce((n,b)=>n+b.length,0));parts.push(Buffer.from(value));},async finish(){const b=Buffer.concat(parts);return{closed:true,bytes:b.length,hash:createHash('sha256').update(b).digest('hex')};},async abort(){return{closed:true};}};}

test('metadata producer calls only default adapter and preserves valid redaction and fallback',async()=>{
 const a=adapter();a.info.isFallbackAdapter=true;const result=decodeMetadata(await executeMetadata(message,environment(a)));assert.equal(result.info.isFallbackAdapter,true);assert.equal(result.attribution,'LIMITED');assert.equal(result.device,'not-requested');assert.deepEqual(result.features,['shader-f16']);
 for(const change of [{abi:'bad'},{id:'../escape'},{kind:'attention'},{fixture:new ArrayBuffer(0)}])await assert.rejects(executeMetadata({...message,...change},{gpu:{requestAdapter(){throw new Error('Must not be reached');}},secureContext:true,check(){}}));
 assert.throws(()=>validateMetadataMessage({...message,extra:1}));
});
test('required API feature types counts and limits refuse without device work',async()=>{
 for(const env of [{...environment(),secureContext:false},{...environment(),gpu:null},environment(null)])await assert.rejects(executeMetadata(message,env),/RED/);
 for(const change of [a=>{delete a.info.isFallbackAdapter;},a=>{a.info.vendor=null;},a=>{a.info.description='x'.repeat(513);},a=>{a.features=Array(33).fill('x');},a=>{a.features=['duplicate','duplicate'];},a=>{a.features=['bad feature'];},a=>{a.limits.maxBufferSize=NaN;},a=>{delete a.limits.maxBufferSize;}]){const a=adapter();change(a);await assert.rejects(executeMetadata(message,environment(a)));}
 let visits=0;const a=adapter();a.features={*[Symbol.iterator](){for(let i=0;i<1000;i++){visits++;yield`feature-${i}`;}}};await assert.rejects(executeMetadata(message,environment(a)),/cap/);assert.equal(visits,33);
});
test('producer UTF8 preflight supports full8192bytes and refuses overflow before encoding',()=>{
 const r=report();for(const k of ['vendor','architecture','device','description'])r.info[k]='a'.repeat(512);r.attribution='reported-only';r.features=Array.from({length:32},(_,i)=>('feature-'+i+'-').padEnd(64,'a'));
 const base=encodeMetadata(r).byteLength;let delta=8192-base;assert.ok(delta>0);for(const key of ['vendor','architecture','device','description']){let value='';for(let i=0;i<512;i++){if(delta>=5){value+='\0';delta-=5;}else if(delta>0){value+='é';delta--;}else value+='a';}r.info[key]=value;}assert.equal(delta,0);const exact=encodeMetadata(r);assert.equal(exact.byteLength,8192);assert.equal(decodeMetadata(exact).features.length,32);
 r.info.description=r.info.description.replace('a','é');const Old=globalThis.TextEncoder;let entered=false;globalThis.TextEncoder=class{constructor(){entered=true;throw new Error('No allocation before cap refusal');}};try{assert.throws(()=>encodeMetadata(r),/8KiB/);assert.equal(entered,false);}finally{globalThis.TextEncoder=Old;}
});
test('metadata decode refuses oversized shadowed hostile trees and malformed required fields',()=>{
 const big=new ArrayBuffer(8193);Object.defineProperty(big,'byteLength',{value:2});assert.throws(()=>decodeMetadata(big),/geometry/);
 for(const text of ['[[[[0]]]]','{"x":'+Array(100).fill('"a"').join(',')+'}','{"x":'+('['.repeat(100))+'0'+(']'.repeat(100))+'}','null'])assert.throws(()=>decodeMetadata(new TextEncoder().encode(text).buffer));
 const r=report();r.info.isFallbackAdapter=null;assert.throws(()=>decodeMetadata(new TextEncoder().encode(JSON.stringify(r)).buffer),/fallback/);assert.throws(()=>decodeMetadata(Uint8Array.of(255,255).buffer));
});
test('metadata receipt shares global gate and private byte ownership until dispose',async()=>{
 const f=fakeClient();const running=f.client.metadata(),receipt=await running;try{assert.equal(f.charged,65536);assert.throws(()=>f.client.metadata(),/no queue/);assert.throws(()=>createAttentionClient().metadata(),/no queue/);assert.throws(()=>f.client.run('unknown',new Blob()),/no queue/);Object.defineProperty(receipt.result,'byteLength',{value:0});}finally{receipt.dispose();receipt.dispose();}await running.whenSettled();assert.equal(f.charged,0);assert.equal(f.releases,1);assert.equal(Object.getOwnPropertyDescriptor(ArrayBuffer.prototype,'byteLength').get.call(receipt.result),0);
 const again=f.client.metadata();const next=await again;next.dispose();await again.whenSettled();assert.equal(f.releases,2);
});
test('cancel retains gate through forced termination and ignores stale replies after reuse',async()=>{
 const f=fakeClient('held'),control=new AbortController(),p=f.client.metadata(control.signal);const reject=assert.rejects(p,/canceled|abort/iu);await tick();const old=f.worker.onmessage,oldID=f.message.id;control.abort();await reject;assert.equal(f.charged,65536);assert.throws(()=>f.client.metadata(),/no queue/);await p.whenSettled();assert.equal(f.releases,1);assert.ok(f.worker.terminations>=1);
 const g=fakeClient('held'),q=g.client.metadata();await tick();old({data:{abi:METADATA_ABI,id:oldID,kind:'metadata-result',json:encodeMetadata(report())}});assert.equal(g.charged,65536);g.worker.onmessage({data:{abi:METADATA_ABI,id:g.message.id,kind:'metadata-result',json:encodeMetadata(report())}});const receipt=await q;receipt.dispose();await q.whenSettled();assert.equal(g.releases,1);
});
test('worker errors malformed identities and bad JSON all settle one lease',async()=>{
 const error=fakeClient('error'),p=error.client.metadata();await assert.rejects(p,/Worker failed/);await p.whenSettled();assert.equal(error.releases,1);
 for(const change of [{id:'stale'},{extra:true},{json:new ArrayBuffer(0)}]){const f=fakeClient('held'),q=f.client.metadata();await tick();f.worker.onmessage({data:{abi:METADATA_ABI,id:f.message.id,kind:'metadata-result',json:encodeMetadata(report()),...change}});await assert.rejects(q);await q.whenSettled();assert.equal(f.releases,1);}
 const controller=new AbortController();controller.abort();assert.throws(()=>fakeClient().client.metadata(controller.signal));
});
test('metadata stream reuses ACK machinery with256byte chunks and closed original hash',async()=>{
 const f=ownerFixture(),output=sink(),events=[];const page=pageFor(f,(method)=>{events.push(method);});const result=await metadataFromOwnedPage(page,()=>output,async()=>{events.push('ownership-ACK');});assert.equal(events[0],'ownership-ACK');assert.equal(result.header.chunkBytes,256);assert.equal(validateMetadataHeader(result.header),result.header.total);assert.ok(output.parts.every(x=>x.length<=256));assert.equal(f.disposed,1);assert.equal(f.owner.status().phase,'idle');const bytes=Buffer.concat(output.parts);assert.equal(decodeMetadata(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)).version,1);
 assert.equal(metadataLedger.streamPhase,54016);assert.equal(metadataLedger.producerPhase,49152);assert.equal(metadataLedger.parsePhase,49152);assert.equal(metadataLedger.rawHashPhase,36864);assert.ok(metadataLedger.phasesExclusive);assert.equal(METADATA_CHUNK_BYTES,256);
});
test('metadata noqueue duplicate offset stale/truncated/corrupt packets refuse and keep cleanup honest',async()=>{
 for(const mutate of [p=>({...p,sequence:p.sequence+1}),p=>({...p,offset:p.offset+1}),p=>({...p,id:'stale'}),p=>({...p,data:p.data.slice(1)}),p=>({...p,data:p.data.map((x,i)=>i?x:x^1)})]){const f=ownerFixture();await assert.rejects(metadataFromOwnedPage(pageFor(f,(method,value)=>method==='metadataChunk'?mutate(value):undefined),()=>sink(),async()=>{}));assert.equal(f.disposed,1);}
 const f=ownerFixture(),h=await f.owner.start();f.owner.open({abi:METADATA_CAPTURE_ABI,id:h.id,kind:'open',total:h.total,hash:h.hash});const pending=f.owner.chunk({abi:METADATA_CAPTURE_ABI,id:h.id,kind:'next',sequence:0,offset:0,total:h.total});await assert.rejects(f.owner.chunk({abi:METADATA_CAPTURE_ABI,id:h.id,kind:'next',sequence:0,offset:0,total:h.total}),/overlap/);const packet=await pending;assert.equal(validateMetadataChunk(packet,h,0,0),256);await f.owner.abortClosed({abi:METADATA_CAPTURE_ABI,id:h.id,kind:'aborted',closed:true});assert.equal(f.disposed,1);
});
test('metadata ownership refusal and original plus failed cleanup are separately preserved',async()=>{
 const f=ownerFixture();let pageCalls=0;await assert.rejects(metadataFromOwnedPage({call(){pageCalls++;}},()=>sink(),async()=>{throw new Error('ACK refused');}),/ACK refused/);assert.equal(pageCalls,0);
 const output=sink();output.write=async()=>{throw new Error('original write failure');};output.abort=async()=>{throw new Error('cleanup unconfirmed');};await assert.rejects(metadataFromOwnedPage(pageFor(f),()=>output,async()=>{}),error=>error instanceof AggregateError&&error.errors[0].message==='original write failure'&&error.errors[1].message==='cleanup unconfirmed');assert.equal(f.disposed,0);await f.owner.abortClosed({abi:METADATA_CAPTURE_ABI,id:f.owner.status().id,kind:'aborted',closed:true});assert.equal(f.disposed,1);
});
test('actual Worker source branch uses only injected metadata interface, never GPU constants',async()=>{
 const source=readFileSync(new URL('./worker.mjs',import.meta.url),'utf8').replace(/^import .*;\n/gmu,'');let calls=0,closed=0;const replies=[];
 const context={self:{isSecureContext:true,postMessage(data,transfer){replies.push(structuredClone(data,{transfer}));},close(){closed++;}},navigator:{gpu:{}},executeMetadata:async(value,env)=>{assert.equal(value.kind,'adapter-metadata');assert.equal(env.gpu,context.navigator.gpu);calls++;return encodeMetadata(report());},execute(){throw new Error('No attention may execute');},METADATA_ABI,RUNTIME_ABI:'unreleased-attention',DOMException,crypto:globalThis.crypto};for(const key of ['GPUBufferUsage','GPUShaderStage','GPUMapMode'])Object.defineProperty(context,key,{get(){throw new Error('No GPU constants accessed');}});vm.runInNewContext(source,context);context.self.onmessage({data:message});context.self.onmessage({data:message});await tick();assert.equal(calls,1);assert.equal(closed,1);assert.equal(replies[0].kind,'metadata-result');assert.equal(decodeMetadata(replies[0].json).device,'not-requested');
});

test('adapter rejection and cancellation after pending default request preserve originals',async()=>{
 const original=new Error('original adapter rejection');await assert.rejects(executeMetadata(message,{...environment(),gpu:{requestAdapter:()=>Promise.reject(original)}}),error=>error===original);
 let resolve,canceled=false;const pending=executeMetadata(message,{...environment(),gpu:{requestAdapter:()=>new Promise(yes=>{resolve=yes;})},check(){if(canceled)throw new DOMException('canceled source request','AbortError');}});canceled=true;resolve(adapter());await assert.rejects(pending,{name:'AbortError'});
});
test('reserve and constructor refusal leave metadata gate reusable with one refund',async()=>{
 assert.throws(()=>createAttentionClient({reserve(){throw new Error('reserve refused');}}).metadata(),/reserve refused/);
 let refunds=0;const client=createAttentionClient({reserve(){return{release(){refunds++;}};},makeWorker(){throw new Error('constructor refused');}});const failed=client.metadata();await assert.rejects(failed,/constructor refused/);await failed.whenSettled();assert.equal(refunds,1);
 const f=fakeClient(),p=f.client.metadata();const r=await p;r.dispose();await p.whenSettled();assert.equal(f.releases,1);
});
test('post-receipt abort and prior detachment cannot refund another metadata run',async()=>{
 const f=fakeClient(),c=new AbortController(),p=f.client.metadata(c.signal),r=await p;structuredClone(null,{transfer:[r.result]});c.abort();await p.whenSettled();assert.equal(f.releases,1);
 const q=f.client.metadata(),next=await q;r.dispose();assert.equal(f.charged,65536);next.dispose();await q.whenSettled();assert.equal(f.releases,2);
});
test('deadline rejects early while lease waits exact forced-termination settlement',async()=>{
 const oldSet=globalThis.setTimeout,oldClear=globalThis.clearTimeout,timers=new Map();globalThis.setTimeout=(callback,ms)=>{const key={ms};timers.set(ms,callback);return key;};globalThis.clearTimeout=()=>{};
 try{const f=fakeClient('held'),p=f.client.metadata(),rejection=assert.rejects(p,/deadline/);await tick();timers.get(5000)();await rejection;assert.equal(f.charged,65536);assert.throws(()=>f.client.metadata(),/no queue/);timers.get(50)();await p.whenSettled();assert.equal(f.releases,1);}finally{globalThis.setTimeout=oldSet;globalThis.clearTimeout=oldClear;}
});
test('metadata hash/parse phases precede streaming and cancellation waits hash settlement',async()=>{
 let complete,hashing=false,disposed=0,release;const raw=encodeMetadata(report()),settled=new Promise(resolve=>{release=resolve;});const client={metadata(){const p=Promise.resolve({result:raw,dispose(){disposed++;structuredClone(null,{transfer:[raw]});release();}});Object.defineProperty(p,'whenSettled',{value:()=>settled});return p;}};
 const owner=createMetadataOwner(client,{uuid:()=> 'metadata-hash-unit',digest:()=>{hashing=true;return new Promise(resolve=>{complete=resolve;});}}),starting=owner.start();await tick();assert.equal(hashing,true);const canceled=owner.cancel(owner.status().id);await tick();assert.equal(disposed,0);assert.notEqual(owner.status().phase,'idle');complete('a'.repeat(64));await assert.rejects(starting,/canceled/);await canceled;assert.equal(disposed,1);assert.equal(owner.status().phase,'idle');
 const sum=metadataLedger.rawReceipt+metadataLedger.numericPackets+metadataLedger.utf16Protocol+metadataLedger.byteCopies+metadataLedger.streamControl+metadataLedger.hashAllowance;assert.equal(sum,54016);assert.equal(metadataLedger.recordRepresentation+metadataLedger.serializedUTF16+metadataLedger.utf8Buffer+metadataLedger.producerControl,49152);assert.ok(sum<=65536);
});
test('metadata acquisition/write cancellation waits parent close before receipt disposal',async()=>{
 const f=ownerFixture(),o=sink(),c=new AbortController();let writeStarted=false,finishWrite,closeStarted=false,finishClose;
 o.write=()=>{writeStarted=true;return new Promise(resolve=>{finishWrite=resolve;});};o.abort=()=>{closeStarted=true;return new Promise(resolve=>{finishClose=()=>resolve({closed:true});});};
 const pending=metadataFromOwnedPage(pageFor(f),()=>o,async()=>{},{signal:c.signal});const rejected=assert.rejects(pending,{name:'AbortError'});while(!writeStarted)await tick();c.abort();await tick();assert.equal(f.disposed,0);assert.equal(closeStarted,false);finishWrite();while(!closeStarted)await tick();assert.equal(f.disposed,0);finishClose();await rejected;assert.equal(f.disposed,1);
});
test('metadata managed construction cannot invent cleanup and exact maximum is32chunks',async()=>{
 const f=ownerFixture();await assert.rejects(metadataFromOwnedPage(pageFor(f),()=>{throw new Error('factory after sideeffect');},async()=>{}),/factory/);assert.equal(f.disposed,0);await f.owner.abortClosed({abi:METADATA_CAPTURE_ABI,id:f.owner.status().id,kind:'aborted',closed:true});assert.equal(f.disposed,1);
 for(const change of [{total:8193},{total:1},{chunkBytes:257},{id:'../x'},{extra:1}])assert.throws(()=>validateMetadataHeader({abi:METADATA_CAPTURE_ABI,id:'unit',total:8192,chunkBytes:256,hash:'a'.repeat(64),...change}));
 const h={abi:METADATA_CAPTURE_ABI,id:'unit',total:8192,chunkBytes:256,hash:'a'.repeat(64)};assert.equal(validateMetadataHeader(h),8192);for(let i=0;i<32;i++)assert.equal(validateMetadataChunk({abi:METADATA_CAPTURE_ABI,id:'unit',kind:'chunk',sequence:i,offset:i*256,total:8192,hash:'a'.repeat(64),data:Array(256).fill(0)},h,i,i*256),256);assert.throws(()=>validateMetadataChunk({abi:METADATA_CAPTURE_ABI,id:'unit',kind:'chunk',sequence:32,offset:8192,total:8192,hash:'a'.repeat(64),data:[]},h,32,8192));
});

test('closed page adapter forwards all metadata methods and refuses unknown names without browser',async()=>{
 const prior=globalThis.aurialisPrivateAttentionCapture,seen=[];
 const names=['startAdapterMetadata','openMetadata','metadataChunk','ackMetadata','closeMetadata','cancelMetadata','abortMetadataClosed'];
 globalThis.aurialisPrivateAttentionCapture=Object.fromEntries(names.map(name=>[name,value=>{seen.push([name,value]);return name;}]));
 try{const page=playwrightPageAdapter({evaluate:async(fn,arg)=>fn(arg)});for(const name of names)assert.equal(await page.call(name,'source-only'),name);assert.deepEqual(seen,names.map(name=>[name,'source-only']));assert.throws(()=>page.call('requestDevice',{}),/Unknown/);}finally{if(prior===undefined)delete globalThis.aurialisPrivateAttentionCapture;else globalThis.aurialisPrivateAttentionCapture=prior;}
});
test('maximum raw metadata transport is exactly32 single-flight chunks with no retained extra copy',async()=>{
 const raw=Uint8Array.from({length:8192},(_,i)=>i%256).buffer;let disposed=0,release;const settled=new Promise(resolve=>{release=resolve;});
 const owner=createMetadataOwner({metadata(){const p=Promise.resolve({result:raw,dispose(){disposed++;structuredClone(null,{transfer:[raw]});release();}});Object.defineProperty(p,'whenSettled',{value:()=>settled});return p;}},{uuid:()=> 'maximum-raw-source',digest:hash});
 const output=sink(),events=[];const result=await metadataFromOwnedPage(pageFor({owner},(method)=>{events.push(method);}),()=>output,async()=>{});assert.equal(result.header.total,8192);assert.equal(output.parts.length,32);assert.ok(output.parts.every(part=>part.length===256));assert.equal(events.filter(x=>x==='metadataChunk').length,32);assert.equal(events.filter(x=>x==='ackMetadata').length,32);assert.equal(disposed,1);assert.equal(raw.byteLength,0);
});
test('cancellation during ownership ACK cannot create page or sink side effects',async()=>{
 const controller=new AbortController();let resolve,sideeffects=0;const pending=metadataFromOwnedPage({call(){sideeffects++;}},()=>{sideeffects++;},()=>new Promise(done=>{resolve=done;}),{signal:controller.signal});const rejected=assert.rejects(pending,{name:'AbortError'});controller.abort();resolve();await rejected;assert.equal(sideeffects,0);
});
