/** GPU implementation requires an explicit interface; source tests inject only dummy objects. */
import { MODEL_CONTRACT,CANARY,LIMITS,validateMessage,validateDevice,unpackReadback,validateMetadataMessage,encodeMetadata } from './runtime-contract.mjs';
import { SHADER_SOURCE,SHADER_SHA256 } from './shader.mjs';
function capability(adapter,device){const fields=Object.fromEntries(['vendor','architecture','device','description'].map(k=>[k,String(adapter.info?.[k]??'not exposed').slice(0,512)]));const fallback=adapter.info?.isFallbackAdapter??adapter.isFallbackAdapter??null,software=fallback===true||/swiftshader|llvmpipe|lavapipe|software|basic render|\bwarp\b/iu.test(Object.values(fields).join(' '));return{...fields,reportedFallback:fallback,hardwareStatus:software?'software/fallback adapter':'requires independent browser/OS hardware evidence',backend:'not exposed by WebGPU',adapterFeatures:[...adapter.features].sort(),deviceFeatures:[...device.features].sort(),adapterLimits:Object.fromEntries(LIMITS.map(k=>[k,adapter.limits[k]])),deviceLimits:Object.fromEntries(LIMITS.map(k=>[k,device.limits[k]]))};}
export async function execute(message,environment){
  const {gpu,secureContext,BufferUsage,ShaderStage,MapMode,digest,check,onCancel}=environment;
  const {record,fixture,allocation}=validateMessage(message),p=fixture.plan;
  if(await digest(message.fixture)!==record.sha256 || await digest(new TextEncoder().encode(SHADER_SOURCE))!==SHADER_SHA256)throw new Error('Attention pinned bytes changed');check();
  if(!secureContext||!gpu)throw new Error('RED: WebGPU unavailable in secure Worker');
  const adapter=await gpu.requestAdapter();check();if(!adapter)throw new Error('RED: no WebGPU adapter');
  const device=await adapter.requestDevice({label:'private all-key attention fixture'});const buffers=[];let mapped=false,readback,disposed=false,scopes=0;
  let rejectGPU,gpuError;const failure=new Promise((_,reject)=>{rejectGPU=reject;});void failure.catch(()=>{});
  const fail=error=>{gpuError??=error;rejectGPU(gpuError);};
  const guarded=async promise=>{if(gpuError)throw gpuError;const value=await Promise.race([promise,failure]);if(gpuError)throw gpuError;check();return value;};
  const errorListener=event=>fail(new Error(String(event.error?.message??'uncaptured GPU error').slice(0,512)));
  device.addEventListener('uncapturederror',errorListener);void device.lost.then(reason=>{if(!disposed)fail(new Error('GPU lost: '+String(reason.message).slice(0,512)));});
  onCancel(()=>{fail(new DOMException('Attention canceled','AbortError'));for(const b of buffers)b.destroy();device.destroy();});
  const make=(size,usage,label)=>{const b=device.createBuffer({size,usage,label});buffers.push(b);return b;};
  let report;
  try{
    check();validateDevice(p,adapter.limits);validateDevice(p,device.limits);
    device.pushErrorScope('out-of-memory');scopes++;device.pushErrorScope('validation');scopes++;
    const shader=device.createShaderModule({code:SHADER_SOURCE,label:'eight observable all-key stages'});
    if((await guarded(shader.getCompilationInfo())).messages.some(x=>x.type==='error'))throw new Error('Attention WGSL compilation failed');check();
    const layout=device.createBindGroupLayout({entries:[0,1,2,3].map(binding=>({binding,visibility:ShaderStage.COMPUTE,buffer:{type:binding<2?'read-only-storage':binding===2?'storage':'uniform'}}))}),pipelineLayout=device.createPipelineLayout({bindGroupLayouts:[layout]});
    const pipelines=[];for(const {name} of allocation.stages){pipelines.push(await guarded(device.createComputePipelineAsync({layout:pipelineLayout,compute:{module:shader,entryPoint:name}})));check();}
    const storage=BufferUsage.STORAGE|BufferUsage.COPY_DST|BufferUsage.COPY_SRC,inputs=[];
    for(const name of ['q','k','v']){const values=fixture.arrays[name],b=make(values.byteLength+8,storage,name+' guarded');const initial=new Float32Array(values.length+2);initial[0]=CANARY;initial[initial.length-1]=CANARY;initial.set(values,1);device.queue.writeBuffer(b,0,initial);inputs.push(b);}
    const stages=[];for(const {name,count} of allocation.stages){const b=make(count*4+8,storage,name+' guarded'),initial=new Float32Array(count+2);initial.fill(NaN);initial[0]=CANARY;initial[count+1]=CANARY;device.queue.writeBuffer(b,0,initial);stages.push(b);}
    const uniform=make(16,BufferUsage.UNIFORM|BufferUsage.COPY_DST,'closed shape');device.queue.writeBuffer(uniform,0,Uint32Array.of(p.m,p.n,64,0));
    readback=make(allocation.readbackBytes,BufferUsage.COPY_DST|BufferUsage.MAP_READ,'all stages and input guards');
    if(buffers.reduce((sum,b)=>sum+b.size,0)!==allocation.gpuBytes)throw new Error('Attention GPU allocation ledger changed');
    const [q,k,v]=inputs,[raw,scaled,maximum,shifted,exponential,denominator,probability,output]=stages;
    const pairs=[[q,k],[raw,q],[scaled,q],[scaled,maximum],[shifted,q],[exponential,q],[exponential,denominator],[probability,v]];
    const encoder=device.createCommandEncoder();
    for(let i=0;i<8;i++){const pass=encoder.beginComputePass();pass.setPipeline(pipelines[i]);pass.setBindGroup(0,device.createBindGroup({layout,entries:[...pairs[i],stages[i],uniform].map((buffer,binding)=>({binding,resource:{buffer}}))}));if(i===2||i===5)pass.dispatchWorkgroups(p.m,1,1);else pass.dispatchWorkgroups(i===7?1:Math.ceil(p.n/64),p.m,1);pass.end();}
    let offset=0;for(const b of stages){encoder.copyBufferToBuffer(b,0,readback,offset,b.size);offset+=b.size;}for(const b of inputs){encoder.copyBufferToBuffer(b,0,readback,offset,4);encoder.copyBufferToBuffer(b,b.size-4,readback,offset+4,4);offset+=8;}
    check();device.queue.submit([encoder.finish()]);await guarded(readback.mapAsync(MapMode.READ));mapped=true;check();
    const result=unpackReadback(p,readback.getMappedRange());readback.unmap();mapped=false;
    while(scopes){scopes--;const error=await guarded(device.popErrorScope());if(error)throw new Error('GPU scope: '+String(error.message).slice(0,512));}
    report={model:MODEL_CONTRACT,shaderSHA256:SHADER_SHA256,fixtureSHA256:record.sha256,passes:8,result,canariesIntact:true,chargedApplicationBytes:p.chargedApplicationBytes,gpuBytes:allocation.gpuBytes,gpuWork:p.gpuWork,integerControlUpperBound:allocation.integerControlUpperBound,capability:capability(adapter,device),timingScope:'no benchmark; dispatch completion does not prove callback deadlines'};
  }finally{disposed=true;onCancel(()=>{});if(mapped)readback.unmap();for(const b of buffers)b.destroy();device.removeEventListener('uncapturederror',errorListener);device.destroy();/* Avoid waiting on a lost device during cleanup. */}
  return {...report,cleanupComplete:true};
}

/** Source tests supply a dummy interface. No device or shader is requested. */
export async function executeMetadata(message,{gpu,secureContext,check}){
 validateMetadataMessage(message);check();if(!secureContext||!gpu||typeof gpu.requestAdapter!=='function')throw new Error('RED: WebGPU unavailable in secure Worker');
 const adapter=await gpu.requestAdapter();check();if(!adapter)throw new Error('RED: no WebGPU adapter');
 const info={};for(const key of ['vendor','architecture','device','description']){const value=adapter.info?.[key];if(typeof value!=='string'||value.length>512)throw new Error('RED: adapter identity API unavailable/oversize');info[key]=value;}
 info.isFallbackAdapter=adapter.info?.isFallbackAdapter;if(typeof info.isFallbackAdapter!=='boolean')throw new Error('RED: required fallback status unavailable');
 const features=[];if(!adapter.features||typeof adapter.features[Symbol.iterator]!=='function')throw new Error('RED: adapter features unavailable');for(const feature of adapter.features){check();if(features.length===32||typeof feature!=='string'||!/^[a-z0-9-]{1,64}$/u.test(feature))throw new Error('Metadata feature cap/type changed');features.push(feature);}features.sort();
 const limits={};for(const key of LIMITS){const value=adapter.limits?.[key];if(!Number.isSafeInteger(value)||value<0)throw new Error('RED: required adapter limit unavailable');limits[key]=value;}
 const report={version:1,secureContext:true,request:'default-no-hints',info,features,limits,device:'not-requested',attribution:['vendor','architecture','device','description'].some(k=>info[k]==='')?'LIMITED':'reported-only',scope:'private-adapter-metadata-only'};
 check();return encodeMetadata(report); // Producer temporaries expire before transfer/parse.
}
