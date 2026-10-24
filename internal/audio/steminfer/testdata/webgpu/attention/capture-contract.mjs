/** Private fixed-size capture protocol; no browser/device/filesystem operations. */
import {recordFor,MODEL_CONTRACT} from './runtime-contract.mjs';
import {SHADER_SHA256}from'./shader.mjs';
import {shapePlan} from './contract.mjs';
export const CAPTURE_ABI='aurialis-private-attention-capture-1';
export const CHUNK_BYTES=2048;
export const MAX_NEW_OUTPUT_BYTES=64*1024*1024;
export const MAX_SUMMARY_CHARACTERS=8192;
export const captureLedger=Object.freeze({numericArrays:2*32*CHUNK_BYTES,utf16Protocol:2*2*(4*CHUNK_BYTES+1024),byteCopies:3*CHUNK_BYTES,controlAndSummary:65536,hashAllowance:4096});
export const capturePhaseBytes=Object.values(captureLedger).reduce((a,b)=>a+b,0);
export function capturePlan(plan){
 const hashPhaseBytes=plan.stageBytes+16384+4096;
 if(hashPhaseBytes>303104||capturePhaseBytes>303104)throw new Error('Capture slack exceeded');
 return Object.freeze({chunkBytes:CHUNK_BYTES,capturePhaseBytes,hashPhaseBytes,hashAndChunksExclusive:true,remainingAfterMaximumPhase:303104-Math.max(hashPhaseBytes,capturePhaseBytes)});
}
const hashPattern=/^[a-f0-9]{64}$/u;
export function validHash(value){return typeof value==='string'&&hashPattern.test(value);}
export function exactKeys(value,keys){if(!value||typeof value!=='object'||Object.keys(value).sort().join('|')!==keys.slice().sort().join('|'))throw new Error('Capture message fields changed');}
export function validID(id){return typeof id==='string'&&/^[a-z0-9-]{1,64}$/u.test(id);}
function text(value,limit){if(typeof value!=='string'||value.length>limit)throw new Error('Capture summary string cap');return value;}
function strings(values){if(!Array.isArray(values)||values.length>32)throw new Error('Capture feature count');return Object.freeze(values.map(value=>text(value,64)));}
const limitNames=['maxBufferSize','maxStorageBufferBindingSize','maxComputeInvocationsPerWorkgroup','maxComputeWorkgroupSizeX','maxComputeWorkgroupSizeY','maxComputeWorkgroupSizeZ','maxComputeWorkgroupStorageSize','maxComputeWorkgroupsPerDimension','maxStorageBuffersPerShaderStage','maxBindingsPerBindGroup'];
export function boundedSummary(receipt,pin){
 const p=shapePlan(pin.m,pin.n),c=receipt.capability,r=receipt.comparison;
 if(receipt.model!==MODEL_CONTRACT||receipt.shaderSHA256!==SHADER_SHA256)throw new Error('Capture source/model identity changed');
 if(!c||!r||!['ordinary-input-diagnostic','underflow-limited'].includes(r.classification)||!Array.isArray(r.reasons)||r.reasons.length>16||!Number.isFinite(r.maximumOutputIntervalWidth)||r.maximumOutputIntervalWidth<0)throw new Error('Invalid capture summary');
 exactKeys(c,['vendor','architecture','device','description','reportedFallback','hardwareStatus','backend','adapterFeatures','deviceFeatures','adapterLimits','deviceLimits']);
 const limits=values=>{exactKeys(values,limitNames);return Object.freeze(Object.fromEntries(limitNames.map(name=>{const value=values?.[name];if(!Number.isSafeInteger(value)||value<0)throw new Error('Invalid capability limit');return[name,value];})));};
 if(c.reportedFallback!==null&&typeof c.reportedFallback!=='boolean')throw new Error('Invalid fallback evidence');
 const capability=Object.freeze({vendor:text(c.vendor,512),architecture:text(c.architecture,512),device:text(c.device,512),description:text(c.description,512),reportedFallback:c.reportedFallback,hardwareStatus:text(c.hardwareStatus,128),backend:text(c.backend,128),adapterFeatures:strings(c.adapterFeatures),deviceFeatures:strings(c.deviceFeatures),adapterLimits:limits(c.adapterLimits),deviceLimits:limits(c.deviceLimits)});
 const summary=Object.freeze({scope:'private synthetic attention fixture; no model/audio/inference/performance claim',fixtureSHA256:pin.sha256,shaderSHA256:text(receipt.shaderSHA256,64),model:text(receipt.model,256),m:p.m,n:p.n,passes:8,gpuWork:p.gpuWork,referenceCoarseUnits:p.referenceWork,chargedApplicationBytes:p.chargedApplicationBytes,classification:r.classification,reasons:Object.freeze(r.reasons.map(reason=>text(reason,128))),maximumOutputIntervalWidth:r.maximumOutputIntervalWidth,capability});
 if(JSON.stringify(summary).length>MAX_SUMMARY_CHARACTERS)throw new Error('Capture summary JSON cap');return summary;
}
export function validateHeader(header){
 exactKeys(header,['abi','id','name','total','chunkBytes','hash','fixtureSHA256','summary']);
 const pin=recordFor(header.name),plan=shapePlan(pin.m,pin.n);
 exactKeys(header.summary,['scope','fixtureSHA256','shaderSHA256','model','m','n','passes','gpuWork','referenceCoarseUnits','chargedApplicationBytes','classification','reasons','maximumOutputIntervalWidth','capability']);
 const reconstructed=boundedSummary({capability:header.summary.capability,comparison:header.summary,shaderSHA256:header.summary.shaderSHA256,model:header.summary.model},pin);
 if(header.summary.fixtureSHA256!==pin.sha256||header.summary.m!==plan.m||header.summary.n!==plan.n||header.summary.passes!==8||header.summary.gpuWork!==plan.gpuWork||header.summary.referenceCoarseUnits!==plan.referenceWork||header.summary.chargedApplicationBytes!==plan.chargedApplicationBytes||header.summary.scope!==reconstructed.scope)throw new Error('Capture summary identity changed');
 if(header.abi!==CAPTURE_ABI||!validID(header.id)||header.total!==plan.stageBytes||header.chunkBytes!==CHUNK_BYTES||!validHash(header.hash)||header.fixtureSHA256!==pin.sha256||JSON.stringify(reconstructed).length>MAX_SUMMARY_CHARACTERS)throw new Error('Capture header mismatch');return plan;
}
export function checkIdentity(message,id,kind,keys){exactKeys(message,keys);if(message.abi!==CAPTURE_ABI||message.id!==id||message.kind!==kind)throw new Error('Stale capture identity');}
export function validateChunk(packet,header,sequence,offset){
 checkIdentity(packet,header.id,'chunk',['abi','id','kind','sequence','offset','total','hash','data']);
 const count=Math.min(CHUNK_BYTES,header.total-offset);
 if(count<1||packet.sequence!==sequence||packet.offset!==offset||packet.total!==header.total||!validHash(packet.hash)||!Array.isArray(packet.data)||packet.data.length!==count)throw new Error('Capture chunk geometry/order changed');
 for(let i=0;i<count;i++){const descriptor=Object.getOwnPropertyDescriptor(packet.data,String(i));if(!descriptor||!('value'in descriptor)||!Number.isInteger(descriptor.value)||descriptor.value<0||descriptor.value>255)throw new Error('Invalid capture byte');}
 return count;
}

export const METADATA_CAPTURE_ABI='aurialis-private-adapter-metadata-stream-1';
export const METADATA_CHUNK_BYTES=256;
export function metadataIdentity(message,id,kind,keys){exactKeys(message,keys);if(message.abi!==METADATA_CAPTURE_ABI||message.id!==id||message.kind!==kind)throw new Error('Stale metadata capture identity');}
export function validateMetadataHeader(header){exactKeys(header,['abi','id','total','chunkBytes','hash']);if(header.abi!==METADATA_CAPTURE_ABI||!validID(header.id)||!Number.isInteger(header.total)||header.total<2||header.total>8192||header.chunkBytes!==METADATA_CHUNK_BYTES||!validHash(header.hash))throw new Error('Metadata header changed');return header.total;}
export function validateMetadataChunk(packet,header,sequence,offset){
 metadataIdentity(packet,header.id,'chunk',['abi','id','kind','sequence','offset','total','hash','data']);const count=Math.min(METADATA_CHUNK_BYTES,header.total-offset);
 if(count<1||sequence>=32||packet.sequence!==sequence||packet.offset!==offset||packet.total!==header.total||!validHash(packet.hash)||!Array.isArray(packet.data)||packet.data.length!==count)throw new Error('Metadata chunk geometry/order changed');
 for(let i=0;i<count;i++){const d=Object.getOwnPropertyDescriptor(packet.data,String(i));if(!d||!('value'in d)||!Number.isInteger(d.value)||d.value<0||d.value>255)throw new Error('Invalid metadata byte');}return count;
}
