/** Private one-shot bridge. No GPU operation until a validated message executes. */
import { RUNTIME_ABI,METADATA_ABI } from './runtime-contract.mjs';
import { execute,executeMetadata } from './gpu-runner.mjs';
const digest=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');
let accepted=false,canceled=false,id='',abi='',stop=()=>{};
const check=()=>{if(canceled)throw new DOMException('Attention canceled','AbortError');};
self.onmessage=event=>{
  const message=event.data;
  if(accepted){if(message?.abi===abi&&message.id===id&&message.kind==='cancel'&&Object.keys(message).sort().join('|')==='abi|id|kind'){canceled=true;stop();}return;}
  accepted=true;id=typeof message?.id==='string'?message.id:'';const metadata=message?.abi===METADATA_ABI;abi=metadata?METADATA_ABI:RUNTIME_ABI;
  const environment={gpu:navigator.gpu,secureContext:self.isSecureContext,digest,check,onCancel:callback=>{stop=callback;}};
  const running=metadata?executeMetadata(message,environment):execute(message,{...environment,BufferUsage:GPUBufferUsage,ShaderStage:GPUShaderStage,MapMode:GPUMapMode});
  void running.then(report=>{check();if(metadata)self.postMessage({abi,id,kind:'metadata-result',json:report},[report]);else self.postMessage({abi,id,kind:'result',report},[report.result]);}).catch(error=>{self.postMessage({abi,id,kind:'error',error:String(error.message??error).slice(0,1024)});}).finally(()=>self.close());
};
