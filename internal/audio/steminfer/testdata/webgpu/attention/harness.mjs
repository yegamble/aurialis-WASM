/** Private fixture page only. Module loading never asks for an adapter. */
import{createAttentionClient}from'./client.mjs';import{createCaptureOwner}from'./capture.mjs';import{recordFor}from'./runtime-contract.mjs';
const owner=createCaptureOwner(createAttentionClient()),picker=document.querySelector('#fixture'),status=document.querySelector('#status'),cancel=document.querySelector('#cancel');
let selected=null;
const draw=()=>{const state=owner.status();status.textContent=JSON.stringify(state);picker.disabled=state.phase!=='idle';cancel.disabled=state.phase==='idle';};
picker.addEventListener('change',()=>{
 if(owner.status().phase!=='idle'){picker.value='';return;}
 selected=null;
 if(picker.files.length!==1){status.textContent='Select exactly one registered numerical fixture.';return;}
 const file=picker.files[0];try{const pin=recordFor(file.name);if(file.size!==pin.bytes)throw new Error('Fixture size changed');selected=file;status.textContent='One fixture selected. Capture starts only through the private driver.';}catch(error){picker.value='';status.textContent=error.message;}
});
const bridge=Object.freeze({
 status:()=>owner.status(),
 async startSelected(){if(!selected)throw new Error('Select one registered fixture');const file=selected;selected=null;picker.value='';const pending=owner.start(file);draw();try{return await pending;}finally{draw();}},
 open:message=>owner.open(message),chunk:message=>owner.chunk(message),ack:message=>owner.ack(message),
 async close(message){try{return await owner.close(message);}finally{draw();}},
 async abortClosed(message){try{return await owner.abortClosed(message);}finally{draw();}},
 async cancelActive(){const state=owner.status();if(state.phase==='idle')return state;try{return await owner.cancel(state.id);}finally{draw();}}
});
Object.defineProperty(globalThis,'aurialisPrivateAttentionCapture',{value:bridge});cancel.addEventListener('click',()=>{void bridge.cancelActive().catch(error=>{status.textContent=error.message;});});draw();
