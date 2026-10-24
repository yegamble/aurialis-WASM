import{test}from'node:test';import assert from'node:assert/strict';import{readFileSync}from'node:fs';import{createHash}from'node:crypto';
import{shapePlan,parseFixture}from'./contract.mjs';import{STAGES}from'./propagated.mjs';import{synthetic,packed}from'./test-helpers.mjs';
import{FIXTURES}from'./fixture-index.mjs';import{SHADER_SOURCE,SHADER_SHA256}from'./shader.mjs';
import{RUNTIME_ABI,MODEL_CONTRACT,CANARY,recordFor,validateMessage,validateDevice,allocationPlan,unpackReadback}from'./runtime-contract.mjs';
test('literal shader bytes and all28 immutable fixture pins match the accepted originals',()=>{
 assert.equal(readFileSync(new URL('./attention.wgsl',import.meta.url),'utf8'),SHADER_SOURCE);assert.equal(createHash('sha256').update(SHADER_SOURCE).digest('hex'),SHADER_SHA256);assert.equal(FIXTURES.length,28);assert.equal(new Set(FIXTURES.map(x=>x.sha256)).size,28);
 assert.equal((SHADER_SOURCE.match(/@compute/gu)??[]).length,8);assert.match(SHADER_SOURCE,/key<p.n/);assert.doesNotMatch(SHADER_SOURCE,/exp2|clamp|epsilon|truncate/iu);
});
test('closed shape/index/work/device/allocation bounds refuse mutation before allocation',()=>{
 for(const m of [1,3,8])for(const n of [1,63,64,65,255,256,257,1723]){const p=shapePlan(m,n),a=allocationPlan(p);assert.equal(a.stages.length,8);assert.equal(a.stages.reduce((s,x)=>s+x.count,0),p.stageCells);assert.ok(a.gpuBytes<p.chargedApplicationBytes);const limits=Object.fromEntries(['maxBufferSize','maxStorageBufferBindingSize','maxComputeInvocationsPerWorkgroup','maxComputeWorkgroupSizeX','maxComputeWorkgroupSizeY','maxComputeWorkgroupSizeZ','maxComputeWorkgroupStorageSize','maxComputeWorkgroupsPerDimension','maxStorageBuffersPerShaderStage','maxBindingsPerBindGroup'].map(k=>[k,2**30]));const req=validateDevice(p,limits);for(const key of Object.keys(req))assert.throws(()=>validateDevice(p,{...limits,[key]:req[key]-1}),undefined,key);}
 const maximum=allocationPlan(shapePlan(8,1723));assert.equal(maximum.gpuBytes,1440000);assert.equal(maximum.integerControlUpperBound,30842624);assert.equal(maximum.workgroupStorageUpperBytes,221184);assert.equal(maximum.captureSlackAfterWorkgroups,303104);
 assert.throws(()=>recordFor('../escape'));assert.ok(Object.isFrozen(FIXTURES)&&FIXTURES.every(Object.isFrozen));
});
test('ABI model ID shape and exact geometry are independently guarded',()=>{
 const record=FIXTURES[0],f=synthetic(record.m,record.n),message={abi:RUNTIME_ABI,model:MODEL_CONTRACT,id:'unit-test',name:record.name,kind:'attention',fixture:f.view.buffer};assert.equal(validateMessage(message).record,record);
 for(const change of [{abi:'bad'},{model:'bad'},{id:'../escape'},{kind:'probe'},{extra:true},{fixture:new ArrayBuffer(0)}])assert.throws(()=>validateMessage({...message,...change}));
 const changed=structuredClone(message);new DataView(changed.fixture).setUint32(8,8,true);assert.throws(()=>validateMessage(changed));
});
test('all8 stage and6 input canaries plus finite/fully-written output are required',()=>{
 const f=synthetic(1,65,'normal'),p=f.plan,a=allocationPlan(p),raw=new Float32Array(a.readbackBytes/4);let i=0;const guards=[];for(const {name,count}of a.stages){raw[i]=CANARY;guards.push(i);raw.set(f.arrays[name],i+1);i+=count+1;raw[i]=CANARY;guards.push(i++);}for(let j=0;j<6;j++){raw[i]=CANARY;guards.push(i++);}assert.deepEqual(new Uint8Array(unpackReadback(p,raw.buffer)),new Uint8Array(packed(f)));
 for(const guard of guards){const copy=raw.slice();copy[guard]=0;assert.throws(()=>unpackReadback(p,copy.buffer),/canary/);}for(const value of [NaN,Infinity]){const copy=raw.slice();copy[1]=value;assert.throws(()=>unpackReadback(p,copy.buffer),/nonfinite/);}assert.throws(()=>unpackReadback(p,new ArrayBuffer(0)),/geometry/);
});
test('dispatch source encodes actual rows, all keys and sequential distinct stored passes',()=>{
 const source=readFileSync(new URL('./gpu-runner.mjs',import.meta.url),'utf8');assert.match(source,/i===2\|\|i===5/);assert.match(source,/Math.ceil\(p.n\/64\),p.m,1/);assert.match(source,/i===7\?1/);assert.match(source,/cleanupComplete:true/);assert.equal(STAGES.length,8);assert.equal(parseFixture(synthetic().view.buffer).plan.dimension,64);
});
