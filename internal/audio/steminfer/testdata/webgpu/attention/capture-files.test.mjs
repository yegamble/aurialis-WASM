import{test}from'node:test';import assert from'node:assert/strict';import{mkdtemp,rm,readFile,stat,readdir,chmod,open,rename,unlink,rmdir,statfs}from'node:fs/promises';import{tmpdir}from'node:os';import path from'node:path';import{readFileSync,constants}from'node:fs';import{createHash}from'node:crypto';
import{createFileSinkFactory}from'./capture-files.mjs';import{boundedSummary,CAPTURE_ABI,CHUNK_BYTES}from'./capture-contract.mjs';import{FIXTURES}from'./fixture-index.mjs';import{parseFixture,shapePlan}from'./contract.mjs';import{packed}from'./test-helpers.mjs';import{LIMITS,MODEL_CONTRACT}from'./runtime-contract.mjs';import{SHADER_SHA256}from'./shader.mjs';
const pin=FIXTURES[0],raw=readFileSync(new URL('./unit-pattern-m1-n1.bin',import.meta.url)),f=parseFixture(raw.buffer.slice(raw.byteOffset,raw.byteOffset+raw.byteLength)),data=Buffer.from(packed(f));
function header(selected=pin){const limits=Object.fromEntries(LIMITS.map(k=>[k,2**30])),summary=boundedSummary({model:MODEL_CONTRACT,shaderSHA256:SHADER_SHA256,comparison:{classification:'ordinary-input-diagnostic',reasons:[],maximumOutputIntervalWidth:.01},capability:{vendor:'dummy',architecture:'dummy',device:'dummy',description:'SOURCE UNIT ONLY',hardwareStatus:'not measured',backend:'dummy',reportedFallback:null,adapterFeatures:[],deviceFeatures:[],adapterLimits:limits,deviceLimits:limits}},selected);return{abi:CAPTURE_ABI,id:'local-file-unit',name:selected.name,total:shapePlan(selected.m,selected.n).stageBytes,chunkBytes:CHUNK_BYTES,hash:createHash('sha256').update(data).digest('hex'),fixtureSHA256:selected.sha256,summary};}
test('private numeric file writes/hash/close settle with exact bytes and restrictive permissions',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'aurialis-capture-unit-'));try{const make=createFileSinkFactory(root),sink=make(header());await sink.acquire();await sink.write(data,0);const result=await sink.finish();assert.deepEqual(await readFile(result.path),data);assert.equal((await stat(result.path)).mode&0o777,0o600);assert.equal((await stat(path.dirname(result.path))).mode&0o777,0o700);assert.throws(()=>make(header()),/duplicate/);}finally{await rm(root,{recursive:true,force:true});}
});
test('truncated checksum-mismatched and overlapping writes cannot commit; abort removes private output',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'aurialis-capture-unit-'));try{
  let make=createFileSinkFactory(root),sink=make(header());await sink.acquire();await assert.rejects(sink.finish(),/truncated/);await sink.abort();assert.deepEqual(await readdir(root),[]);
  make=createFileSinkFactory(root);sink=make(header());await sink.acquire();await sink.write(Buffer.alloc(data.length),0);await assert.rejects(sink.finish(),/checksum/);await sink.abort();assert.deepEqual(await readdir(root),[]);
  make=createFileSinkFactory(root);sink=make(header());await sink.acquire();const writing=sink.write(data,0);await assert.rejects(sink.write(data,0),/order/);await writing;await sink.abort();await sink.abort();assert.deepEqual(await readdir(root),[]);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('pending writes own their bounded byte snapshot rather than mutable caller Buffer',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'aurialis-capture-unit-'));try{const sink=createFileSinkFactory(root)(header());await sink.acquire();const caller=Buffer.from(data),pending=sink.write(caller,0);caller.fill(0);await pending;const r=await sink.finish();assert.deepEqual(await readFile(r.path),data);}finally{await rm(root,{recursive:true,force:true});}
});

const tick=()=>new Promise(resolve=>setImmediate(resolve));
const nativeIO={mkdtemp,chmod,open,rename,unlink,rmdir,statfs};
test('construction is I/O-free and abort before acquire settles once without refunding another owner',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'aurialis-capture-unit-'));try{
  let calls=0;const io=Object.fromEntries(Object.entries(nativeIO).map(([name,operation])=>[name,(...args)=>{calls++;return operation(...args);} ]));
  const make=createFileSinkFactory(root,io),first=make(header());assert.equal(calls,0);assert.deepEqual(await first.abort(),{closed:true});assert.equal(calls,0);
  const second=make(header());assert.deepEqual(await first.abort(),{closed:true});assert.throws(()=>make(header()),/active/);await second.acquire();await second.abort();assert.deepEqual(await readdir(root),[]);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('failed setup retains managed cleanup; close unlink and rmdir failures are individually retryable',async()=>{
 for(const fail of ['close','unlink','rmdir']){
  const root=await mkdtemp(path.join(tmpdir(),'aurialis-capture-unit-'));try{
   let failOnce=true,created=false;const io={...nativeIO,
    async open(...args){const writer=await open(...args);created=true;return{async close(){if(fail==='close'&&failOnce){failOnce=false;throw new Error('injected close failure');}await writer.close();}};},
    async unlink(...args){if(fail==='unlink'&&failOnce){failOnce=false;throw new Error('injected unlink failure');}return unlink(...args);},
    async rmdir(...args){if(fail==='rmdir'&&failOnce){failOnce=false;throw new Error('injected rmdir failure');}return rmdir(...args);}
   };
   const make=createFileSinkFactory(root,io),sink=make(header());await sink.acquire();assert.equal(created,true);
   await assert.rejects(sink.abort(),new RegExp(`injected ${fail}`));assert.throws(()=>make(header()),/active/);assert.notDeepEqual(await readdir(root),[]);
   assert.deepEqual(await sink.abort(),{closed:true});assert.deepEqual(await sink.abort(),{closed:true});assert.deepEqual(await readdir(root),[]);
   const next=make(header());await sink.abort();assert.throws(()=>make(header()),/active/);await next.abort();
  }finally{await rm(root,{recursive:true,force:true});}
 }
 const root=await mkdtemp(path.join(tmpdir(),'aurialis-capture-unit-'));try{
  let cleanupFails=true;const make=createFileSinkFactory(root,{...nativeIO,async chmod(){throw new Error('setup chmod failure');},async rmdir(...args){if(cleanupFails){cleanupFails=false;throw new Error('setup cleanup failure');}return rmdir(...args);}}),sink=make(header());
  await assert.rejects(sink.acquire(),/setup chmod/);await assert.rejects(sink.abort(),/setup cleanup/);assert.throws(()=>make(header()),/active/);await sink.abort();assert.deepEqual(await readdir(root),[]);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('abort waits delayed acquisition and delayed close before releasing file admission',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'aurialis-capture-unit-'));try{
  let releaseOpen,opening=false,releaseClose,closing=false;const io={...nativeIO,async open(...args){opening=true;const writer=await open(...args);await new Promise(resolve=>{releaseOpen=resolve;});return{async close(){closing=true;await new Promise(resolve=>{releaseClose=resolve;});await writer.close();}};}};
  const make=createFileSinkFactory(root,io),sink=make(header()),acquiring=sink.acquire();const rejected=assert.rejects(acquiring,/aborted/);
  while(!opening||!releaseOpen)await tick();const cleanup=sink.abort();assert.equal(cleanup,sink.abort());assert.throws(()=>make(header()),/active/);assert.equal(closing,false);
  releaseOpen();await rejected;while(!closing)await tick();assert.throws(()=>make(header()),/active/);assert.notDeepEqual(await readdir(root),[]);
  releaseClose();assert.deepEqual(await cleanup,{closed:true});assert.equal(cleanup,sink.abort());assert.deepEqual(await readdir(root),[]);
 }finally{await rm(root,{recursive:true,force:true});}
});

test('aborting an older finished capture cannot release a newer sink admission',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'aurialis-capture-unit-'));try{
  const make=createFileSinkFactory(root),first=make(header());await first.acquire();await first.write(data,0);await first.finish();
  const second=make(header(FIXTURES[1]));assert.deepEqual(await first.abort(),{closed:true});assert.throws(()=>make(header()),/active/);
  await first.abort();assert.throws(()=>make(header()),/active/);await second.abort();assert.deepEqual(await readdir(root),[]);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('failed closed-file reader close and partial setup file cleanup retain retry authority',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'aurialis-capture-unit-'));try{
  let failClose=true;const io={...nativeIO,async open(...args){const handle=await open(...args);if(args[1]!==(constants.O_RDONLY|constants.O_NOFOLLOW))return handle;return{stat:handle.stat.bind(handle),read:handle.read.bind(handle),async close(){if(failClose){failClose=false;throw new Error('reader close unconfirmed');}await handle.close();}};}};
  const make=createFileSinkFactory(root,io),sink=make(header());await sink.acquire();await sink.write(data,0);await assert.rejects(sink.finish(),/reader close unconfirmed/);assert.throws(()=>make(header()),/active/);await sink.abort();assert.deepEqual(await readdir(root),[]);
  let failUnlink=true;const partial=createFileSinkFactory(root,{...nativeIO,async open(...args){const handle=await open(...args);await handle.close();throw new Error('partial setup file exists');},async unlink(...args){if(failUnlink){failUnlink=false;throw new Error('partial file unlink unconfirmed');}return unlink(...args);}}),managed=partial(header());
  await assert.rejects(managed.acquire(),/partial setup file exists/);await assert.rejects(managed.abort(),/unlink unconfirmed/);assert.throws(()=>partial(header()),/active/);await managed.abort();assert.deepEqual(await readdir(root),[]);
 }finally{await rm(root,{recursive:true,force:true});}
});
