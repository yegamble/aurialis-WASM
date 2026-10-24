/** Closed private fixture bridge; no production caller or audio/model loading. */
import { ABI, shapePlan, parseFixture, validateFixture } from './contract.mjs';
import { STAGES } from './propagated.mjs';
import { FIXTURES } from './fixture-index.mjs';
export const RUNTIME_ABI=ABI+'/eight-pass-1';
export const MODEL_CONTRACT='mega53-f16-0d51845078d4c075d825ba18f776f9af96e50d34d3491102a1215b6dbaf684b7/post-rope-one-head-d64/attend-6fdad13686bb7e84d029ec66f9dbe76e65c93ebf';
export const CANARY=123456.75;
export const DEADLINE_MS=5000;
export const LIMITS=Object.freeze(['maxBufferSize','maxStorageBufferBindingSize','maxComputeInvocationsPerWorkgroup','maxComputeWorkgroupSizeX','maxComputeWorkgroupSizeY','maxComputeWorkgroupSizeZ','maxComputeWorkgroupStorageSize','maxComputeWorkgroupsPerDimension','maxStorageBuffersPerShaderStage','maxBindingsPerBindGroup']);
export function recordFor(name) { const record=FIXTURES.find(item=>item.name===name);if(!record)throw new Error('Unregistered attention fixture');return record; }
export function allocationPlan(plan) {
  const stages=STAGES.map(name=>({name,count:name==='maximum'||name==='denominator'?plan.m:name==='output'?plan.output:plan.cells}));
  const inputCounts=[plan.output,plan.n*64,plan.n*64], inputGPUBytes=plan.inputBytes+24, stageGPUBytes=plan.stageBytes+64;
  const readbackBytes=stageGPUBytes+24, gpuBytes=inputGPUBytes+stageGPUBytes+readbackBytes+16;
  // Maximum live CPU interval storage is two Float64 endpoints per stage cell.
  // The conservative charged envelope includes caller Blob, raw read, private
  // snapshot, transferable clone and digest input (5F); upload/init/internal
  // staging (4I); GPU stages, readback, mapped copy, returned stages, interval
  // arrays (4S), initialization scratch and diagnostics (10S); plus fixed slack.
  const ledger=Object.freeze({fixtureAndDigestCopies:5*plan.fixtureBytes,inputUploadCopies:4*plan.inputBytes,stageAndIntervalCopies:10*plan.stageBytes,guardAndMetadataAllowance:65536,fixedCaptureAllowance:524288});
  if(Object.values(ledger).reduce((a,b)=>a+b,0)!==plan.chargedApplicationBytes || gpuBytes>plan.chargedApplicationBytes)throw new Error('Application allocation ledger changed');
  const padded64=64*Math.ceil(plan.n/64),padded256=256*Math.ceil(plan.n/256);
  // Conservative source-level integer arithmetic/comparison ledger, independent
  // of the closed floating-data operation cap. Includes loop/address/guard work;
  // excludes memory loads/stores/barriers and says nothing about machine code.
  const integerStages=Object.freeze({raw:16*plan.m*padded64*64+32*plan.m*padded64,scaled:16*plan.m*padded64,maximum:plan.m*(16*(padded256+255)+64*256),shifted:32*plan.m*padded64,exponential:16*plan.m*padded64,denominator:plan.m*(16*(padded256+255)+64*256),probability:32*plan.m*padded64,output:16*plan.m*64*plan.n+32*plan.m*64});
  const integerControlUpperBound=Object.values(integerStages).reduce((a,b)=>a+b,0);
  // The module declares1024B even for an entrypoint that may not use it.
  // Do not assume compiler dead-code elimination or simultaneous residency.
  const workgroupStorageUpperBytes=1024*Math.max(plan.m*Math.ceil(plan.n/64),plan.m);
  const captureSlackAfterWorkgroups=ledger.fixedCaptureAllowance-workgroupStorageUpperBytes;
  if(captureSlackAfterWorkgroups<0)throw new Error('Workgroup storage exceeds fixed slack');
  if(!Number.isSafeInteger(integerControlUpperBound))throw new Error('Integer-work ledger overflow');
  return Object.freeze({workgroupStorageUpperBytes,captureSlackAfterWorkgroups,integerStages,integerControlUpperBound,stages,inputCounts,inputGPUBytes,stageGPUBytes,readbackBytes,gpuBytes,uniformBytes:16,ledger});
}
export function validateDevice(plan,limits) {
  const allocation=allocationPlan(plan), largest=Math.max(4*plan.n*64+8,4*plan.cells+8,allocation.readbackBytes);
  const required={maxBufferSize:largest,maxStorageBufferBindingSize:largest,maxComputeInvocationsPerWorkgroup:256,maxComputeWorkgroupSizeX:256,maxComputeWorkgroupSizeY:1,maxComputeWorkgroupSizeZ:1,maxComputeWorkgroupStorageSize:1024,maxComputeWorkgroupsPerDimension:Math.max(8,Math.ceil(plan.n/64)),maxStorageBuffersPerShaderStage:3,maxBindingsPerBindGroup:4};
  for(const [key,value] of Object.entries(required))if(!Number.isSafeInteger(limits[key])||limits[key]<value)throw new Error('Attention device limit: '+key);
  return required;
}
export function validateMessage(message) {
  if(!message || Object.keys(message).sort().join('|')!=='abi|fixture|id|kind|model|name' || message.abi!==RUNTIME_ABI || message.model!==MODEL_CONTRACT || message.kind!=='attention' || typeof message.id!=='string' || !/^[a-z0-9-]{1,64}$/u.test(message.id))throw new Error('Closed attention message identity changed');
  const record=recordFor(message.name),plan=shapePlan(record.m,record.n);
  if(!(message.fixture instanceof ArrayBuffer)||message.fixture.byteLength!==record.bytes||record.bytes!==plan.fixtureBytes)throw new Error('Attention input geometry changed');
  const fixture=parseFixture(message.fixture);if(fixture.plan.m!==record.m||fixture.plan.n!==record.n)throw new Error('Attention fixture shape differs from pin');validateFixture(fixture);
  return {record,fixture,allocation:allocationPlan(plan)};
}
export function unpackReadback(plan,buffer) {
  const a=allocationPlan(plan);
  if(!(buffer instanceof ArrayBuffer)||buffer.byteLength!==a.readbackBytes)throw new Error('Attention readback geometry changed');
  const source=new Float32Array(buffer),result=new Float32Array(plan.stageCells);let offset=0,target=0;
  for(const {count} of a.stages){if(source[offset]!==CANARY||source[offset+count+1]!==CANARY)throw new Error('Attention stage canary changed');for(let i=0;i<count;i++){const value=source[offset+1+i];if(!Number.isFinite(value))throw new Error('Attention stage nonfinite/unwritten');result[target++]=value;}offset+=count+2;}
  for(let i=0;i<6;i++)if(source[offset+i]!==CANARY)throw new Error('Attention input canary changed');
  return result.buffer;
}
