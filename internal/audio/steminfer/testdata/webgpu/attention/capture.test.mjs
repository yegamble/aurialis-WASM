import{test}from'node:test';import assert from'node:assert/strict';import{createHash}from'node:crypto';
import{createCaptureOwner}from'./capture.mjs';import{captureFromPage,preflightBatch,playwrightPageAdapter}from'./capture-driver.mjs';
import{CAPTURE_ABI,CHUNK_BYTES,capturePhaseBytes,capturePlan,validateHeader,validateChunk}from'./capture-contract.mjs';import{FIXTURES}from'./fixture-index.mjs';import{shapePlan}from'./contract.mjs';import{LIMITS,MODEL_CONTRACT}from'./runtime-contract.mjs';import{SHADER_SHA256}from'./shader.mjs';
const pin=FIXTURES.find(x=>x.m===1&&x.n===255),plan=shapePlan(pin.m,pin.n),file=()=>new File([new Uint8Array(pin.bytes)],pin.name);
const digest=async value=>createHash('sha256').update(new Uint8Array(value.buffer??value,value.byteOffset??0,value.byteLength)).digest('hex');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixtureOwner(options={}){
 const result=new Uint8Array(plan.stageBytes);for(let i=0;i<result.length;i++)result[i]=(i*13+7)&255;const original=result.slice();let disposed=0,resolveReleased;
 const released=new Promise(resolve=>{resolveReleased=resolve;});
 const limits=Object.fromEntries(LIMITS.map(k=>[k,2**30]));
 const comparison={classification:'ordinary-input-diagnostic',reasons:[],maximumOutputIntervalWidth:.01};Object.defineProperty(comparison,'bounds',{get(){throw new Error('Full bounds must not be read');}});Object.defineProperty(comparison,'grids',{get(){throw new Error('Full grids must not be read');}});
 const receipt={result:result.buffer,comparison,model:MODEL_CONTRACT,shaderSHA256:SHADER_SHA256,capability:{vendor:'dummy',architecture:'dummy',device:'dummy',description:'SOURCE TEST, NOT HARDWARE',reportedFallback:null,hardwareStatus:'not measured',backend:'dummy',adapterFeatures:[],deviceFeatures:[],adapterLimits:limits,deviceLimits:limits},dispose(){if(disposed)return;disposed++;structuredClone(null,{transfer:[result.buffer]});resolveReleased();}};
 const client={run(){const running=Promise.resolve(receipt);Object.defineProperty(running,'whenSettled',{value:()=>released});return running;}};
 let id=0;const owner=createCaptureOwner(options.client??client,{digest:options.digest??digest,uuid:()=>`source-unit-${++id}`});return{owner,original,receipt,get disposed(){return disposed;}};
}
const open=(o,h)=>o.open({abi:CAPTURE_ABI,id:h.id,kind:'open',total:h.total,hash:h.hash});
const next=(o,h,sequence,offset)=>o.chunk({abi:CAPTURE_ABI,id:h.id,kind:'next',sequence,offset,total:h.total});
const ack=(o,p)=>o.ack({abi:CAPTURE_ABI,id:p.id,kind:'written',sequence:p.sequence,offset:p.offset,total:p.total,bytes:p.data.length,hash:p.hash});
const abort=(o,h)=>o.abortClosed({abi:CAPTURE_ABI,id:h.id,kind:'aborted',closed:true});
function adapter(f,intercept=()=>{}){return{async call(method,message){const result=method==='startSelected'?await f.owner.start(file()):method==='cancelActive'?await f.owner.cancel(f.owner.status().id):await f.owner[method](message);return intercept(method,result)??result;}};}
function memorySink(){const parts=[];let closed=false,aborted=false;return{async acquire(){},parts,get aborted(){return aborted;},async write(b,offset){assert.equal(offset,parts.reduce((n,x)=>n+x.length,0));parts.push(Buffer.from(b));},async finish(){closed=true;const bytes=Buffer.concat(parts);return{closed,bytes:bytes.length,hash:createHash('sha256').update(bytes).digest('hex')};},async abort(){aborted=true;closed=true;return{closed:true};}};}
test('exclusive preparation/chunk ledgers fit existing slack and no full JSON reference is needed',async()=>{
 assert.equal(CHUNK_BYTES,2048);assert.equal(capturePhaseBytes,243712);assert.equal(capturePlan(shapePlan(8,1723)).hashPhaseBytes,298272);assert.equal(capturePlan(shapePlan(8,1723)).remainingAfterMaximumPhase,4832);
 const f=fixtureOwner(),sink=memorySink(),r=await captureFromPage(adapter(f),()=>sink);assert.equal(validateHeader(r.header).stageBytes,plan.stageBytes);assert.deepEqual(Buffer.concat(sink.parts),Buffer.from(f.original));assert.equal(f.disposed,1);assert.equal(f.owner.status().phase,'idle');
});
test('one chunk in flight, exact offsets/hashes, stale requests and duplicate/closed captures reject',async()=>{
 const f=fixtureOwner(),h=await f.owner.start(file());open(f.owner,h);
 try{await assert.rejects(f.owner.start(file()),/no queue/);const pending=next(f.owner,h,0,0);await assert.rejects(next(f.owner,h,0,0),/overlap/);const packet=await pending;assert.equal(validateChunk(packet,h,0,0),2048);await assert.rejects(next(f.owner,h,0,0),/overlap/);assert.throws(()=>ack(f.owner,{...packet,hash:'0'.repeat(64)}),/acknowledgement/);ack(f.owner,packet);assert.throws(()=>ack(f.owner,packet),/acknowledgement/);await assert.rejects(next(f.owner,{...h,id:'stale'},1,2048),/Stale/);await assert.rejects(next(f.owner,h,2,2048),/order/);await assert.rejects(f.owner.close({abi:CAPTURE_ABI,id:h.id,kind:'close',sequence:1,offset:2048,total:h.total,hash:h.hash,closed:true}),/incomplete/);}finally{await abort(f.owner,h);}await assert.rejects(next(f.owner,h,0,0),/closed/);
});
test('raw hash preparation cancellation holds receipt until actual digest settlement',async()=>{
 let complete;const f=fixtureOwner({digest:()=>new Promise(resolve=>{complete=resolve;})}),starting=f.owner.start(file());await tick();const cancel=f.owner.cancel(f.owner.status().id);assert.equal(f.disposed,0);await assert.rejects(f.owner.start(file()),/no queue/);complete('1'.repeat(64));await assert.rejects(starting,/canceled/);await cancel;assert.equal(f.disposed,1);assert.equal(f.owner.status().phase,'idle');
});
test('early run rejection cannot release selected-file session before exact run settlement',async()=>{
 let rejectRun,completeRelease;const released=new Promise(resolve=>{completeRelease=resolve;});const client={run(_name,_file,signal){const promise=new Promise((_resolve,reject)=>{rejectRun=reject;});Object.defineProperty(promise,'whenSettled',{value:()=>released});signal.addEventListener('abort',()=>rejectRun(new Error('read canceled')),{once:true});return promise;}};
 const f=fixtureOwner({client}),starting=f.owner.start(file());await tick();const cancel=f.owner.cancel(f.owner.status().id);await tick();assert.notEqual(f.owner.status().phase,'idle');await assert.rejects(f.owner.start(file()),/no queue/);completeRelease();await assert.rejects(starting,/canceled/);await cancel;assert.equal(f.owner.status().phase,'idle');
});
test('parent cancellation waits in-flight write, hash and file cleanup before disposal',async()=>{
 const f=fixtureOwner(),sink=memorySink(),controller=new AbortController();let finishWrite,writing=false;const write=sink.write;sink.write=async(...args)=>{writing=true;await new Promise(resolve=>{finishWrite=resolve;});return write(...args);};
 const pending=captureFromPage(adapter(f),()=>sink,{signal:controller.signal});while(!writing)await tick();controller.abort();await tick();assert.equal(f.disposed,0);assert.equal(sink.aborted,false);finishWrite();await assert.rejects(pending,{name:'AbortError'});assert.equal(sink.aborted,true);assert.equal(f.disposed,1);
});
test('truncated reordered corrupted and stale packets cannot commit and cleanup remains honest',async()=>{
 for(const mutate of [p=>({...p,sequence:p.sequence+1}),p=>({...p,offset:p.offset+1}),p=>({...p,id:'stale'}),p=>({...p,data:p.data.slice(1)}),p=>({...p,data:p.data.map((b,i)=>i?b:b^1)})]){
  const f=fixtureOwner(),sink=memorySink();await assert.rejects(captureFromPage(adapter(f,(method,result)=>method==='chunk'?mutate(result):undefined),()=>sink));assert.equal(sink.aborted,true);assert.equal(f.disposed,1);
 }
 const f=fixtureOwner(),sink=memorySink();sink.finish=async()=>({closed:false,bytes:0,hash:'0'.repeat(64)});await assert.rejects(captureFromPage(adapter(f),()=>sink),/closure/);assert.equal(f.disposed,1);
});
test('failed parent cleanup never invents a close acknowledgement or releases receipt',async()=>{
 const f=fixtureOwner(),sink=memorySink();sink.write=async()=>{throw new Error('write failed');};sink.abort=async()=>{throw new Error('cleanup unconfirmed');};await assert.rejects(captureFromPage(adapter(f),()=>sink),/cleanup unconfirmed/);assert.equal(f.disposed,0);const state=f.owner.status();await f.owner.abortClosed({abi:CAPTURE_ABI,id:state.id,kind:'aborted',closed:true});assert.equal(f.disposed,1);
});
test('headers are closed and bounded before serialization; exact source/model and parent hash required',async()=>{
 const f=fixtureOwner(),h=await f.owner.start(file());
 try{
  for(const mutate of [h=>({...h,hash:'invalid'}),h=>({...h,summary:{...h.summary,extra:new Uint8Array(16)}}),h=>({...h,summary:{...h.summary,model:'wrong'}}),h=>({...h,summary:{...h.summary,capability:{...h.summary.capability,extra:'x'}}}),h=>({...h,summary:{...h.summary,capability:{...h.summary.capability,description:'x'.repeat(513)}}}),h=>({...h,summary:{...h.summary,capability:{...h.summary.capability,adapterFeatures:Array(33).fill('x')}}})])assert.throws(()=>validateHeader(mutate(h)));
 }finally{await f.owner.cancel(h.id);}
 const g=fixtureOwner(),sink=memorySink();await assert.rejects(captureFromPage(adapter(g,(method,result)=>method==='startSelected'?{...result,id:'stale'}:undefined),()=>sink));assert.equal(g.disposed,1);
});

test('four-fixture batch admission and literal page methods have no browser/process launcher',()=>{
 const names=FIXTURES.slice(0,4).map(x=>x.name),plan=preflightBatch(names);assert.equal(plan.cases,4);assert.equal(plan.maximumWallMilliseconds,60000);assert.equal(plan.processGuardRequired,true);for(const values of [[],[...names,names[0]],[names[0],names[0]],['unknown']])assert.throws(()=>preflightBatch(values));const adapter=playwrightPageAdapter({evaluate(){throw new Error('No browser may execute in source unit');}});assert.throws(()=>adapter.call('constructor'),/Unknown/);
});


test('parent opens before construction; rejected or asynchronous factories retain unconfirmed ownership',async()=>{
 for(const make of [()=>{throw new Error('setup cleanup failed');},async()=>{throw new Error('setup cleanup failed');},()=>({})]){
  const f=fixtureOwner(),base=adapter(f);let entered=false,opened=false;
  const page={async call(method,message){const result=await base.call(method,message);if(method==='open')opened=true;return result;}};
  await assert.rejects(captureFromPage(page,h=>{entered=true;assert.equal(opened,true);return make(h);}));
  assert.equal(entered,true);assert.equal(f.disposed,0);assert.notEqual(f.owner.status().phase,'idle');
  await tick();await f.owner.abortClosed({abi:CAPTURE_ABI,id:f.owner.status().id,kind:'aborted',closed:true});
 }
});
test('managed acquisition failure and delayed cleanup withhold acknowledgement until actual settlement',async()=>{
 const f=fixtureOwner(),sink=memorySink();let acquired=false,completeCleanup,cleaning=false;
 sink.acquire=async()=>{acquired=true;throw new Error('setup failed after partial file');};
 sink.abort=async()=>{cleaning=true;await new Promise(resolve=>{completeCleanup=resolve;});return{closed:true};};
 const pending=captureFromPage(adapter(f),()=>sink);const rejection=assert.rejects(pending,/partial file/);
 while(!cleaning)await tick();assert.equal(acquired,true);assert.equal(f.disposed,0);assert.notEqual(f.owner.status().phase,'idle');
 completeCleanup();await rejection;assert.equal(f.disposed,1);
});
test('cancellation while acquiring retains the exact handle and rejects an unconfirmed abort result',async()=>{
 const f=fixtureOwner(),sink=memorySink(),controller=new AbortController();let completeAcquire,acquiring=false,aborts=0;
 sink.acquire=()=>{acquiring=true;return new Promise(resolve=>{completeAcquire=resolve;});};
 sink.abort=async()=>{aborts++;return{closed:false};};
 const pending=captureFromPage(adapter(f),()=>sink,{signal:controller.signal});const rejection=assert.rejects(pending,/closure unconfirmed/);
 while(!acquiring)await tick();controller.abort();await tick();assert.equal(f.disposed,0);assert.equal(aborts,0);
 completeAcquire();await rejection;assert.equal(aborts,1);assert.equal(f.disposed,0);
 await f.owner.abortClosed({abi:CAPTURE_ABI,id:f.owner.status().id,kind:'aborted',closed:true});
});
test('managed methods are captured before acquisition can mutate caller-visible methods',async()=>{
 const f=fixtureOwner(),sink=memorySink();sink.acquire=async()=>{sink.write=()=>{throw new Error('mutated write');};sink.finish=()=>{throw new Error('mutated finish');};sink.abort=()=>{throw new Error('mutated abort');};};
 const result=await captureFromPage(adapter(f),()=>sink);assert.equal(result.closed,true);assert.equal(f.disposed,1);
});
