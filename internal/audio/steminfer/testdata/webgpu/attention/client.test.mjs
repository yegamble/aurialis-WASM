import{test}from'node:test';import assert from'node:assert/strict';import{readFileSync}from'node:fs';import{createHash}from'node:crypto';
import{createAttentionClient}from'./client.mjs';import{FIXTURES}from'./fixture-index.mjs';import{parseFixture}from'./contract.mjs';import{packed}from'./test-helpers.mjs';
import{RUNTIME_ABI,MODEL_CONTRACT,allocationPlan}from'./runtime-contract.mjs';import{SHADER_SHA256}from'./shader.mjs';
const pin=FIXTURES[0],path=new URL('./unit-pattern-m1-n1.bin',import.meta.url);
// Source tests use a single unchanged recorded CPU fixture, never a GPU interface.
const bytes=readFileSync(path),blob=()=>new Blob([bytes]);
class FakeWorker{constructor(){this.terminated=0;}postMessage(message,transfer=[]){this.message=structuredClone(message,{transfer});}terminate(){this.terminated++;}reply(report){this.onmessage?.({data:{abi:RUNTIME_ABI,id:this.message.id,kind:'result',report}});}}
function setup(options={}){let held=0,released=0;const workers=[];const client=createAttentionClient({reserve(n){held=n;return{release(){released++;held=0;}};},digest:async data=>createHash('sha256').update(new Uint8Array(data)).digest('hex'),makeWorker(){const w=new FakeWorker();workers.push(w);return w;},...options});return{client,workers,get held(){return held;},get released(){return released;}};}
async function turn(){await new Promise(resolve=>setImmediate(resolve));}
function report(worker){const f=parseFixture(worker.message.fixture);return{model:MODEL_CONTRACT,shaderSHA256:SHADER_SHA256,fixtureSHA256:pin.sha256,passes:8,result:packed(f),cleanupComplete:true,canariesIntact:true,chargedApplicationBytes:f.plan.chargedApplicationBytes,gpuBytes:allocationPlan(f.plan).gpuBytes,gpuWork:f.plan.gpuWork,integerControlUpperBound:allocationPlan(f.plan).integerControlUpperBound};}
test('precharge precedes read/hash/Worker and disposed result detaches aliases before releasing',async()=>{
 let s;const order=[];s=setup({read:async b=>{assert.ok(s.held>0);order.push('read');return b.arrayBuffer();}});const pending=s.client.run(pin.name,blob());await turn();assert.deepEqual(order,['read']);const w=s.workers[0];w.reply(report(w));const r=await pending;assert.equal(s.released,0);assert.throws(()=>s.client.run(pin.name,blob()),/no queue/);const alias=new Float32Array(r.result),bound=r.comparison.bounds.output;r.dispose();assert.equal(alias.byteLength,0);assert.equal(bound.byteLength,0);assert.equal(s.released,1);r.dispose();assert.equal(s.released,1);
});
test('abort rejects promptly but lease and one-entry gate survive until underlying read settles',async()=>{
 let complete;const s=setup({read:()=>new Promise(resolve=>{complete=resolve;})}),controller=new AbortController(),pending=s.client.run(pin.name,blob(),controller.signal);controller.abort();await assert.rejects(pending,{name:'AbortError'});assert.ok(s.held>0);assert.throws(()=>s.client.run(pin.name,blob()),/no queue/);complete(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));await turn();assert.equal(s.released,1);assert.equal(s.workers.length,0);
});
test('private snapshot survives caller/read-buffer mutation during checksum await',async()=>{
 let finishHash,owned;const raw=bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength),s=setup({read:async()=>raw,digest:data=>{owned=data;return new Promise(resolve=>{finishHash=resolve;});}}),pending=s.client.run(pin.name,blob());await turn();assert.equal(raw.byteLength,0);new Uint8Array(bytes.buffer,bytes.byteOffset,1)[0]^=0;finishHash(createHash('sha256').update(new Uint8Array(owned)).digest('hex'));await turn();const w=s.workers[0];assert.equal(new DataView(w.message.fixture).getUint32(16,true),64);w.reply(report(w));const r=await pending;r.dispose();
});
test('unknown pins, bytes, hashes and denied reserve never create Worker',async()=>{
 const denied=setup({reserve(){throw new Error('denied');}});assert.throws(()=>denied.client.run(pin.name,blob()),/denied/);assert.throws(()=>denied.client.run('unknown',blob()),/Unregistered/);assert.throws(()=>denied.client.run(pin.name,new Blob([])),/geometry/);
 for(const options of [{digest:async()=> '0'.repeat(64)},{read:async()=>new ArrayBuffer(0)}]){const s=setup(options);await assert.rejects(s.client.run(pin.name,blob()));await turn();assert.equal(s.workers.length,0);assert.equal(s.released,1);}
});
test('stale identities, malformed geometry and non-atomic cleanup cannot grant a result',async()=>{
 for(const mutation of [{model:'wrong'},{shaderSHA256:'wrong'},{fixtureSHA256:'0'.repeat(64)},{passes:7},{cleanupComplete:false},{canariesIntact:false},{result:new ArrayBuffer(0)}]){const s=setup(),pending=s.client.run(pin.name,blob());await turn();const w=s.workers[0];w.reply({...report(w),...mutation});await assert.rejects(pending);await turn();assert.equal(s.released,1);}
 const s=setup(),pending=s.client.run(pin.name,blob());await turn();const w=s.workers[0];w.onmessage({data:{abi:RUNTIME_ABI,id:'stale',kind:'result'}});await assert.rejects(pending,/identity/);await turn();assert.equal(s.released,1);
});
test('deadline requests cancellation then hard-terminates; no GPU preemption guarantee',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});const s=setup(),pending=s.client.run(pin.name,blob());await turn();const w=s.workers[0];t.mock.timers.tick(5000);await assert.rejects(pending,/preemption is not guaranteed/);assert.ok(s.held>0);t.mock.timers.tick(50);await turn();assert.ok(w.terminated>0);assert.equal(s.released,1);
});
test('cancel during pending hash retains snapshot/lease until actual hash settlement',async()=>{
 let finishHash,captured;const s=setup({digest:data=>{captured=data;return new Promise(resolve=>{finishHash=resolve;});}}),controller=new AbortController(),pending=s.client.run(pin.name,blob(),controller.signal);await turn();controller.abort();await assert.rejects(pending,{name:'AbortError'});assert.ok(s.held>0);assert.ok(captured.byteLength>0);assert.equal(s.workers.length,0);finishHash(pin.sha256);await turn();assert.equal(captured.byteLength,0);assert.equal(s.released,1);
});
test('abort after returned receipt detaches stage/bound aliases and releases once',async()=>{
 const s=setup(),controller=new AbortController(),pending=s.client.run(pin.name,blob(),controller.signal);await turn();const w=s.workers[0];w.reply(report(w));const r=await pending,alias=new Float32Array(r.result);controller.abort();assert.equal(alias.byteLength,0);assert.equal(s.released,1);r.dispose();assert.equal(s.released,1);
});
test('Worker errors and malformed messages clean up, and old late handlers cannot affect a new owner',async()=>{
 const s=setup(),first=s.client.run(pin.name,blob());await turn();const old=s.workers[0],late=old.onmessage;old.onerror();await assert.rejects(first,/Worker failed/);await turn();assert.equal(s.released,1);
 const second=s.client.run(pin.name,blob());await turn();const current=s.workers[1];late({data:{abi:RUNTIME_ABI,id:'late',kind:'result'}});assert.ok(s.held>0);current.reply(report(current));const r=await second;r.dispose();assert.equal(s.released,2);
});
test('reservation or private-copy failure leaves gate reusable with no Worker',async()=>{
 const fail=setup({read:async()=>{throw new Error('read failed');}});await assert.rejects(fail.client.run(pin.name,blob()),/read failed/);await turn();assert.equal(fail.released,1);assert.equal(fail.workers.length,0);
 const next=setup(),pending=next.client.run(pin.name,blob());await turn();const w=next.workers[0];w.reply(report(w));const r=await pending;r.dispose();
});
// Captured test intrinsics bypass caller-owned .buffer/.byteLength shadows.
const intrinsicBufferBytes=Object.getOwnPropertyDescriptor(ArrayBuffer.prototype,'byteLength').get;
const originalViewBuffer=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Float32Array.prototype),'buffer').get;
const actualBytes=b=>Reflect.apply(intrinsicBufferBytes,b,[]);
const actualBuffer=view=>Reflect.apply(originalViewBuffer,view,[]);
test('receipt maps reject deletion/reassignment and private inventory survives view buffer shadows',async()=>{
 const s=setup(),pending=s.client.run(pin.name,blob());await turn();const w=s.workers[0];w.reply(report(w));const r=await pending,bound=r.comparison.bounds.output,grid=r.comparison.grids.output,boundBuffer=actualBuffer(bound),gridBuffer=actualBuffer(grid);
 try{
  assert.equal(Reflect.deleteProperty(r.comparison.bounds,'output'),false);assert.equal(Reflect.set(r.comparison.grids,'output',new Int16Array(0)),false);
  assert.ok(Object.isFrozen(r.comparison.bounds)&&Object.isFrozen(r.comparison.grids));
  Object.defineProperty(bound,'buffer',{value:new ArrayBuffer(0)});Object.defineProperty(grid,'buffer',{value:new ArrayBuffer(0)});
  r.dispose();assert.equal(actualBytes(boundBuffer),0);assert.equal(actualBytes(gridBuffer),0);assert.equal(bound.byteLength,0);assert.equal(grid.byteLength,0);assert.equal(s.released,1);
 }finally{r.dispose();}
});
test('own byteLength zero cannot hide stage bound or grid backing buffers from disposal',async()=>{
 const s=setup(),pending=s.client.run(pin.name,blob());await turn();const w=s.workers[0];w.reply(report(w));const r=await pending,buffers=[r.result,actualBuffer(r.comparison.bounds.output),actualBuffer(r.comparison.grids.output)];
 try{
  for(const b of buffers){assert.ok(actualBytes(b)>0);Object.defineProperty(b,'byteLength',{value:0});assert.ok(actualBytes(b)>0);}
  r.dispose();for(const b of buffers)assert.equal(actualBytes(b),0);r.dispose();assert.equal(s.released,1);
 }finally{r.dispose();}
});
test('partly pre-detached aliases and post-receipt abort detach the remaining closed inventory once',async()=>{
 const s=setup(),controller=new AbortController(),pending=s.client.run(pin.name,blob(),controller.signal);await turn();const w=s.workers[0];w.reply(report(w));const r=await pending,bound=r.comparison.bounds.output,grid=r.comparison.grids.output,boundBuffer=actualBuffer(bound),gridBuffer=actualBuffer(grid),other=actualBuffer(r.comparison.bounds.raw);
 try{
  structuredClone(null,{transfer:[r.result,boundBuffer]});Object.defineProperty(gridBuffer,'byteLength',{value:0});
  controller.abort();assert.equal(actualBytes(boundBuffer),0);assert.equal(actualBytes(gridBuffer),0);assert.equal(actualBytes(other),0);assert.equal(bound.byteLength,0);assert.equal(grid.byteLength,0);r.dispose();assert.equal(s.released,1);
 }finally{r.dispose();}
});
test('exact-run settlement latch cannot be replaced by a later active run',async()=>{
 const s=setup(),first=s.client.run(pin.name,blob()),firstSettled=first.whenSettled();let releasedFirst=false;void firstSettled.then(()=>{releasedFirst=true;});await turn();s.workers[0].reply(report(s.workers[0]));const a=await first;assert.equal(releasedFirst,false);a.dispose();await firstSettled;assert.equal(releasedFirst,true);
 const second=s.client.run(pin.name,blob()),secondSettled=second.whenSettled();let releasedSecond=false;void secondSettled.then(()=>{releasedSecond=true;});await firstSettled;assert.equal(releasedSecond,false);await turn();s.workers[1].reply(report(s.workers[1]));const b=await second;assert.equal(releasedSecond,false);b.dispose();await secondSettled;assert.equal(releasedSecond,true);
});

test('attention invalid envelopes/report stores detach before exact settlement/refund',async()=>{
 for(const variant of ['wrong-abi','wrong-id','error','invalid-report','direct-report','unknown-kind']){
  let atRefund,refunds=0;const incoming=new ArrayBuffer(8192),extra=new ArrayBuffer(32),top=new ArrayBuffer(16);Object.defineProperty(incoming,'byteLength',{value:0});
  const s=setup({reserve(){return{release(){atRefund=[actualBytes(incoming),actualBytes(extra),actualBytes(top)];refunds++;}};}}),pending=s.client.run(pin.name,blob());await turn();const w=s.workers[0],data={abi:RUNTIME_ABI,id:w.message.id,kind:'result',report:{...report(w),model:'invalid-model',result:incoming,extra},top};
  if(variant==='wrong-abi')data.abi='wrong-abi';if(variant==='wrong-id')data.id='wrong-id';if(variant==='error'){data.kind='error';data.error='original attention Worker error';}if(variant==='direct-report'){data.report=incoming;data.extra=extra;}if(variant==='unknown-kind')data.kind='unknown';
  w.onmessage({data});await assert.rejects(pending,variant==='error'?/original attention Worker error/:/identity|Unpinned/);await pending.whenSettled();assert.equal(refunds,1);assert.deepEqual(atRefund,[0,0,0]);assert.equal(actualBytes(incoming),0);assert.equal(actualBytes(top),0);
 }
});
test('attention late/duplicate report stores detach without touching newer owner or live result',async()=>{
 const s=setup(),first=s.client.run(pin.name,blob());await turn();const old=s.workers[0],late=old.onmessage;old.onerror();await assert.rejects(first,/Worker failed/);await first.whenSettled();const second=s.client.run(pin.name,blob());await turn();const current=s.workers[1],handler=current.onmessage,lateStore=new ArrayBuffer(8192),lateExtra=new ArrayBuffer(32);
 const originalIncludes=Array.prototype.includes;Array.prototype.includes=()=>true;try{late({data:{abi:RUNTIME_ABI,id:old.message.id,kind:'result',report:{result:lateStore,extra:lateExtra}}});}finally{Array.prototype.includes=originalIncludes;}const stateAfterLate={held:s.held,refunded:s.released,bytes:actualBytes(lateStore),extra:actualBytes(lateExtra)};const valid=report(current);handler({data:{abi:RUNTIME_ABI,id:current.message.id,kind:'result',report:valid}});const duplicate=new ArrayBuffer(4096);handler({data:{abi:RUNTIME_ABI,id:current.message.id,kind:'result',report:{result:duplicate}}});const duplicateBytes=actualBytes(duplicate),receipt=await second;try{assert.ok(actualBytes(receipt.result)>0);assert.ok(stateAfterLate.held>0);assert.equal(stateAfterLate.refunded,1);assert.equal(stateAfterLate.bytes,0);assert.equal(stateAfterLate.extra,0);assert.equal(duplicateBytes,0);}finally{receipt.dispose();await second.whenSettled();}assert.equal(s.released,2);
});
test('attention cancellation before reply disposes report store and preserves original cancellation',async()=>{
 const s=setup(),controller=new AbortController(),pending=s.client.run(pin.name,blob(),controller.signal);await turn();const w=s.workers[0],handler=w.onmessage,incoming=new ArrayBuffer(8192);controller.abort(new Error('original attention source cancel'));await assert.rejects(pending,/original attention source cancel/);handler({data:{abi:RUNTIME_ABI,id:w.message.id,kind:'result',report:{result:incoming}}});await pending.whenSettled();assert.equal(actualBytes(incoming),0);assert.equal(s.released,1);
});
