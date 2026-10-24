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

// Metadata is a separate closed command. It has no fixture/model/device path.
const metadataApply=Reflect.apply,metadataByteLength=Object.getOwnPropertyDescriptor(ArrayBuffer.prototype,'byteLength').get;
export const METADATA_ABI=ABI+'/adapter-metadata-1';
export const METADATA_MAX_BYTES=8192;
export const METADATA_APPLICATION_BYTES=65536;
export const metadataLedger=Object.freeze({recordRepresentation:18432,serializedUTF16:16384,utf8Buffer:8192,producerControl:6144,producerPhase:49152,parsePhase:49152,rawHashPhase:36864,rawReceipt:8192,numericPackets:2*32*256,utf16Protocol:2*2*(4*256+1024),byteCopies:3*256,streamControl:16384,hashAllowance:4096,streamPhase:54016,phasesExclusive:true});
export function validateMetadataMessage(message){
 if(!message||Object.keys(message).sort().join('|')!=='abi|id|kind'||message.abi!==METADATA_ABI||message.kind!=='adapter-metadata'||typeof message.id!=='string'||!/^[a-z0-9-]{1,64}$/u.test(message.id))throw new Error('Closed metadata message identity changed');
}
function metadataKeys(value,keys){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join('|')!==keys.slice().sort().join('|'))throw new Error('Metadata record fields changed');}
export function validateMetadataRecord(report){
 metadataKeys(report,['version','secureContext','request','info','features','limits','device','attribution','scope']);
 if(report.version!==1||report.secureContext!==true||report.request!=='default-no-hints'||report.device!=='not-requested'||report.scope!=='private-adapter-metadata-only')throw new Error('Metadata operation scope changed');
 metadataKeys(report.info,['vendor','architecture','device','description','isFallbackAdapter']);
 for(const key of ['vendor','architecture','device','description'])if(typeof report.info[key]!=='string'||report.info[key].length>512)throw new Error('Metadata identity string cap');
 if(typeof report.info.isFallbackAdapter!=='boolean')throw new Error('RED: required fallback status unavailable');
 if(!Array.isArray(report.features)||report.features.length>32||new Set(report.features).size!==report.features.length||report.features.some(x=>typeof x!=='string'||!/^[a-z0-9-]{1,64}$/u.test(x)))throw new Error('Metadata feature cap/type changed');
 metadataKeys(report.limits,LIMITS);for(const key of LIMITS)if(!Number.isSafeInteger(report.limits[key])||report.limits[key]<0)throw new Error('RED: required adapter limit unavailable');
 const attribution=['vendor','architecture','device','description'].some(k=>report.info[k]==='')?'LIMITED':'reported-only';if(report.attribution!==attribution)throw new Error('Metadata attribution changed');
 return report;
}
function jsonStringBytes(value){let bytes=2;for(let i=0;i<value.length;i++){const c=value.charCodeAt(i);if(c===34||c===92||[8,9,10,12,13].includes(c))bytes+=2;else if(c<32)bytes+=6;else if(c<128)bytes++;else if(c<2048)bytes+=2;else if(c>=0xd800&&c<=0xdbff&&i+1<value.length&&value.charCodeAt(i+1)>=0xdc00&&value.charCodeAt(i+1)<=0xdfff){bytes+=4;i++;}else if(c>=0xd800&&c<=0xdfff)bytes+=6;else bytes+=3;}return bytes;}
function jsonBytes(value){if(typeof value==='string')return jsonStringBytes(value);if(typeof value==='boolean')return value?4:5;if(typeof value==='number')return String(value).length;if(Array.isArray(value))return 2+Math.max(0,value.length-1)+value.reduce((n,x)=>n+jsonBytes(x),0);const entries=Object.entries(value);return 2+Math.max(0,entries.length-1)+entries.reduce((n,[k,v])=>n+jsonStringBytes(k)+1+jsonBytes(v),0);}
export function encodeMetadata(report){
 validateMetadataRecord(report);const count=jsonBytes(report);if(count>METADATA_MAX_BYTES)throw new Error('Metadata serialized evidence exceeds8KiB');
 const text=JSON.stringify(report),bytes=new TextEncoder().encode(text);if(bytes.byteLength!==count)throw new Error('Metadata UTF8 size invariant changed');return bytes.buffer;
}
export function decodeMetadata(buffer){
 let bytes;try{bytes=metadataApply(metadataByteLength,buffer,[]);}catch{throw new Error('Metadata result geometry changed');}if(bytes<2||bytes>METADATA_MAX_BYTES)throw new Error('Metadata result geometry changed');
 const text=new TextDecoder('utf-8',{fatal:true}).decode(buffer);let quoted=false,escaped=false,depth=0,objects=0,arrays=0,strings=0,scalars=0;
 // Refuse allocation-heavy malformed trees before JSON.parse. The closed schema
 // has3objects,1array,at most64strings and13number/boolean scalar tokens.
 for(let i=0;i<text.length;i++){const c=text[i];if(quoted){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;continue;}if(c==='"'){quoted=true;if(++strings>64)throw new Error('Metadata JSON string count');}else if(c==='{'||c==='['){if(++depth>3||c==='{'&&++objects>3||c==='['&&++arrays>1)throw new Error('Metadata JSON structure cap');}else if(c==='}'||c===']')depth--;else if(!/[\s,:]/u.test(c)){if(++scalars>13)throw new Error('Metadata JSON scalar count');while(i+1<text.length&&!/[\s,}\]]/u.test(text[i+1]))i++;}}
 if(quoted||escaped||depth!==0)throw new Error('Metadata JSON framing changed');return validateMetadataRecord(JSON.parse(text));
}
