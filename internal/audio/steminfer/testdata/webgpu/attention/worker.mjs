/** Private one-shot bridge. No GPU operation until a validated message executes. */
import { RUNTIME_ABI } from './runtime-contract.mjs';
import { execute } from './gpu-runner.mjs';
const digest=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');
let accepted=false,canceled=false,id='',stop=()=>{};
const check=()=>{if(canceled)throw new DOMException('Attention canceled','AbortError');};
self.onmessage=event=>{
  const message=event.data;
  if(accepted){if(message?.abi===RUNTIME_ABI&&message.id===id&&message.kind==='cancel'&&Object.keys(message).sort().join('|')==='abi|id|kind'){canceled=true;stop();}return;}
  accepted=true;id=typeof message?.id==='string'?message.id:'';
  void execute(message,{gpu:navigator.gpu,secureContext:self.isSecureContext,BufferUsage:GPUBufferUsage,ShaderStage:GPUShaderStage,MapMode:GPUMapMode,digest,check,onCancel:callback=>{stop=callback;}}).then(report=>{check();self.postMessage({abi:RUNTIME_ABI,id,kind:'result',report},[report.result]);}).catch(error=>{self.postMessage({abi:RUNTIME_ABI,id,kind:'error',error:String(error.message??error).slice(0,1024)});}).finally(()=>self.close());
};
