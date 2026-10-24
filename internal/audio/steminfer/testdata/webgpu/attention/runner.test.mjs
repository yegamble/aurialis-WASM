import{test}from'node:test';import assert from'node:assert/strict';import{readFileSync}from'node:fs';import{createHash}from'node:crypto';
import{execute}from'./gpu-runner.mjs';import{parseFixture}from'./contract.mjs';import{FIXTURES}from'./fixture-index.mjs';import{RUNTIME_ABI,MODEL_CONTRACT,LIMITS}from'./runtime-contract.mjs';
const raw=readFileSync(new URL('./unit-pattern-m1-n1.bin',import.meta.url));
const digest=async b=>createHash('sha256').update(new Uint8Array(b)).digest('hex');
function message(){return{abi:RUNTIME_ABI,model:MODEL_CONTRACT,id:'source-only-dummy',name:FIXTURES[0].name,kind:'attention',fixture:raw.buffer.slice(raw.byteOffset,raw.byteOffset+raw.byteLength)};}
function dummy(){
 const m=message(),fixture=parseFixture(m.fixture),buffers=[],passes=[],limits=Object.fromEntries(LIMITS.map(k=>[k,2**30]));let destroyed=0,callback=()=>{},canceled=false;
 const device={limits,features:new Set(),lost:new Promise(()=>{}),addEventListener(){},removeEventListener(){},destroy(){destroyed++;},pushErrorScope(){},async popErrorScope(){return null;},createShaderModule(){return{async getCompilationInfo(){return{messages:[]};}};},createBindGroupLayout(x){return x;},createPipelineLayout(x){return x;},async createComputePipelineAsync(x){return{name:x.compute.entryPoint};},createBindGroup(x){return x;},
 createBuffer({size}){const b={size,data:new ArrayBuffer(size),destroyed:false,destroy(){this.destroyed=true;},async mapAsync(){},getMappedRange(){return this.data;},unmap(){}};buffers.push(b);return b;},
 queue:{writeBuffer(buffer,offset,data){new Uint8Array(buffer.data).set(new Uint8Array(data.buffer,data.byteOffset,data.byteLength),offset);},submit(){}},
 createCommandEncoder(){return{beginComputePass(){let name,bind;return{setPipeline(p){name=p.name;},setBindGroup(_,group){bind=group;},dispatchWorkgroups(x,y,z){passes.push({name,x,y,z});const destination=bind.entries[2].resource.buffer;new Float32Array(destination.data,4,fixture.arrays[name].length).set(fixture.arrays[name]);},end(){}};},copyBufferToBuffer(from,a,to,b,size){new Uint8Array(to.data,b,size).set(new Uint8Array(from.data,a,size));},finish(){return{};}};}
 };
 const adapter={limits,features:new Set(),info:{description:'dummy source-unit adapter, not hardware'},async requestDevice(){return device;}};
 const env={gpu:{async requestAdapter(){return adapter;}},secureContext:true,BufferUsage:{STORAGE:1,COPY_DST:2,COPY_SRC:4,UNIFORM:8,MAP_READ:16},ShaderStage:{COMPUTE:1},MapMode:{READ:1},digest,check(){if(canceled)throw new DOMException('test cancellation','AbortError');},onCancel(fn){callback=fn;}};
 return{m,env,device,adapter,buffers,passes,get destroyed(){return destroyed;},cancel(){canceled=true;callback();}};
}
test('dummy-only runner stores and guards all8 stages then destroys every created buffer',async()=>{
 const d=dummy(),r=await execute(d.m,d.env);assert.equal(r.passes,8);assert.equal(r.cleanupComplete,true);assert.equal(d.passes.length,8);assert.equal(r.gpuBytes,d.buffers.reduce((sum,b)=>sum+b.size,0));assert.ok(d.buffers.every(b=>b.destroyed));assert.ok(d.destroyed>0);assert.ok(r.capability.description.includes('dummy'));assert.equal(d.passes[0].y,1);assert.equal(d.passes[7].x,1);
});
test('unavailable adapter and requestDevice rejection are RED with no fallback or buffers',async()=>{
 const d=dummy();d.env.gpu.requestAdapter=async()=>null;await assert.rejects(execute(d.m,d.env),/RED/);assert.equal(d.buffers.length,0);
 const e=dummy();e.adapter.requestDevice=async()=>{throw new Error('device denied');};await assert.rejects(execute(e.m,e.env),/device denied/);assert.equal(e.buffers.length,0);
});
test('cancel while requestDevice is pending destroys late acquired device before any buffers',async()=>{
 const d=dummy();let complete;d.adapter.requestDevice=()=>new Promise(resolve=>{complete=resolve;});const pending=execute(d.m,d.env);while(!complete)await new Promise(resolve=>setImmediate(resolve));d.cancel();complete(d.device);await assert.rejects(pending,{name:'AbortError'});assert.ok(d.destroyed>0);assert.equal(d.buffers.length,0);
});
test('shader failure, lost device and invalid limits never return partial stage authority',async()=>{
 const d=dummy();d.device.createShaderModule=()=>({async getCompilationInfo(){return{messages:[{type:'error'}]};}});await assert.rejects(execute(d.m,d.env),/compilation/);assert.ok(d.destroyed>0);
 const e=dummy();e.device.limits={...e.device.limits,maxComputeWorkgroupStorageSize:1023};await assert.rejects(execute(e.m,e.env),/limit/);assert.equal(e.buffers.length,0);assert.ok(e.destroyed>0);
 const f=dummy();f.device.lost=Promise.resolve({message:'dummy loss'});await assert.rejects(execute(f.m,f.env),/GPU lost/);assert.ok(f.destroyed>0);
});
