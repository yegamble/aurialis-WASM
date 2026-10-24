/** Private fixed source plan. No I/O/browser/adapter work occurs on import. */
import{open,lstat,realpath}from'node:fs/promises';import{constants}from'node:fs';import{createHash}from'node:crypto';import path from'node:path';
import{recordFor}from'../../internal/audio/steminfer/testdata/webgpu/attention/runtime-contract.mjs';import{shapePlan}from'../../internal/audio/steminfer/testdata/webgpu/attention/contract.mjs';import{preflightBatch}from'../../internal/audio/steminfer/testdata/webgpu/attention/capture-driver.mjs';
export const FIRST_FOUR=Object.freeze(['zero-m3-n65.bin','ftz-resurrection-m1-n2.bin','last-key-dominant-m1-n1723.bin','pattern-m8-n1723.bin']);
export const hostLedger=Object.freeze({hashScratch:65536,hashCopyAllowance:131072,hashControl:16384,hashAllowance:4096,hashPhase:217088,receiptObject:32768,receiptText:24576,receiptUTF8:32768,receiptControl:16384,receiptHash:4096,receiptPhase:110592,exclusiveWithCapture:true,maximumRetainedSmallReceipts:4,networkRepresentation:1908,retainedReceiptBytes:2016,controllerDirectoryCharacters:145,controllerDirectoryBytes:290,controllerDependencyReferences:64,controllerScalarReferences:256,controllerOwnerToken:32,controllerCleanup:64,controllerEnsure:64,controllerLease:96,controllerFixedControl:256,controllerUnrounded:866,controllerControl:896,combinedAddon:4820,combinedHash:221908,combinedPageHash:303092,combinedCapture:248532,combinedReceipt:115412});
const nativeIO=Object.freeze({open,lstat,realpath}),apply=Reflect.apply,viewBuffer=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype),'buffer').get,detach=globalThis.structuredClone;
const geometry=s=>[s.dev,s.ino,s.size,s.mtimeNs,s.ctimeNs].map(String).join('|');
let active=null;
/** Construction is I/O free; the complete close handle precedes acquisition. */
export function createFixtureInspection(file,pin,io=nativeIO){
 if(!path.isAbsolute(file)||path.basename(file)!==pin.name||!Number.isInteger(constants.O_NOFOLLOW))throw new Error('Exact absolute fixture/no-follow required');
 let handle,pending=Promise.resolve(),started=false,closed=false,scratch;
 const check=signal=>signal.throwIfAborted();
 return Object.freeze({
  inspect(signal){if(started)throw new Error('One inspection only');started=true;const task=(async()=>{
   check(signal);if(await io.realpath(file)!==file)throw new Error('Fixture symlink/alias refused');check(signal);
   const before=await io.lstat(file,{bigint:true});if(!before.isFile()||before.isSymbolicLink()||before.size!==BigInt(pin.bytes))throw new Error('Pinned fixture path geometry');check(signal);
   handle=await io.open(file,constants.O_RDONLY|constants.O_NOFOLLOW);check(signal);const first=await handle.stat({bigint:true});if(!first.isFile()||geometry(first)!==geometry(before))throw new Error('Fixture changed before hash');
   const hash=createHash('sha256');scratch=Buffer.allocUnsafeSlow(hostLedger.hashScratch);let offset=0;
   while(offset<pin.bytes){check(signal);const r=await handle.read(scratch,0,Math.min(scratch.length,pin.bytes-offset),offset);check(signal);if(!Number.isInteger(r.bytesRead)||r.bytesRead<1||r.bytesRead>Math.min(scratch.length,pin.bytes-offset))throw new Error('Fixture read geometry');hash.update(scratch.subarray(0,r.bytesRead));offset+=r.bytesRead;}
   const after=await handle.stat({bigint:true}),current=await io.lstat(file,{bigint:true});check(signal);if(geometry(first)!==geometry(after)||geometry(first)!==geometry(current)||!current.isFile()||current.isSymbolicLink())throw new Error('Fixture changed during hash');
   const sha256=hash.digest('hex');if(sha256!==pin.sha256)throw new Error('Pinned fixture checksum changed');return Object.freeze({name:pin.name,bytes:offset,sha256});
  })().finally(()=>{if(scratch){const buffer=apply(viewBuffer,scratch,[]);detach(null,{transfer:[buffer]});scratch=undefined;}});pending=task;return task;},
  async close(){if(closed)return{closed:true};try{await pending;}catch{}if(handle){await handle.close();handle=undefined;}pending=undefined;closed=true;return{closed:true};}
 });
}
/** One fixed batch per owned Node command. Injected controls never use native I/O. */
export function createFirstFourController(environment){
 const {directory,reserve,beforeWork,select,clearSelection,capture,record,check=()=>{},inspectFactory=createFixtureInspection}=environment;let used=false;
 if(!path.isAbsolute(directory)||directory.length>hostLedger.controllerDirectoryCharacters||[reserve,beforeWork,select,clearSelection,capture,record,check,inspectFactory].some(fn=>typeof fn!=='function'))throw new Error('Closed first-four dependencies required');
 return Object.freeze({async run(signal=new AbortController().signal){
  signal.throwIfAborted();if(used||active)throw new Error('One first-four batch; no queue/reuse');used=true;const token={};active=token;let allClosed=true;
  const outputs=[];try{preflightBatch(FIRST_FOUR);
   for(let index=0;index<FIRST_FOUR.length;index++){
    const pin=recordFor(FIRST_FOUR[index]),{chargedApplicationBytes,stageBytes}=shapePlan(pin.m,pin.n);let lease,inspection,inspectionAttempt=false,inspectionClosed=true,selectionAttempt=false,selectionClosed=true,captureAttempt=false,captureClosed=true,recordAttempt=false,recordClosed=true,primary;const cleanup=[];
    const ensure=()=>{signal.throwIfAborted();check();};
    try{
     ensure();lease=reserve(chargedApplicationBytes);if(!lease||typeof lease.release!=='function')throw new Error('Invalid fixture application lease');const release=lease.release.bind(lease);lease={release};
     await beforeWork(pin,index);ensure();inspectionAttempt=true;inspectionClosed=false;
     // This scope and the outer handle end BEFORE File selection/capture.
     {
      const candidate=inspectFactory(path.join(directory,pin.name),pin);if(!candidate||typeof candidate.then==='function'||typeof candidate.inspect!=='function'||typeof candidate.close!=='function'){if(candidate?.then)Promise.resolve(candidate).catch(()=>{});throw new Error('Synchronous managed inspection required');}inspection=Object.freeze({inspect:candidate.inspect.bind(candidate),close:candidate.close.bind(candidate)});
      const verified=await inspection.inspect(signal);if(verified.name!==pin.name||verified.bytes!==pin.bytes||verified.sha256!==pin.sha256)throw new Error('Inspection identity changed');if((await inspection.close())?.closed!==true)throw new Error('Inspection closure unconfirmed');inspectionClosed=true;
      inspection=undefined;
     }
     ensure();
     selectionAttempt=true;selectionClosed=false;await select(path.join(directory,pin.name),pin);ensure();captureAttempt=true;captureClosed=false;
     const result=await capture(pin,signal);if(result.closed!==true||result.header.name!==pin.name||result.header.fixtureSHA256!==pin.sha256||result.file.closed!==true||result.file.bytes!==stageBytes||result.file.hash!==result.header.hash)throw new Error('Captured fixture closure/identity changed');captureClosed=true;
     if(pin.name==='ftz-resurrection-m1-n2.bin'&&result.header.summary.classification!=='underflow-limited')throw new Error('FTZ resurrection must stay LIMITED');
     await clearSelection();selectionClosed=true;ensure();recordAttempt=true;recordClosed=false;
     const saved=await record(pin,index,result);if(!saved||saved.closed!==true||saved.name!==pin.name||saved.name.length>40||typeof saved.record!=='string'||saved.record.length>64||!/^[-a-z0-9.]+$/u.test(saved.record)||typeof saved.sha256!=='string'||!/^[a-f0-9]{64}$/u.test(saved.sha256))throw new Error('Fixture receipt closure/descriptor unconfirmed');recordClosed=true;outputs.push(Object.freeze({name:saved.name,record:saved.record,sha256:saved.sha256,closed:true}));ensure();
    }catch(error){primary=error;}finally{
     if(inspection&&!inspectionClosed)try{if((await inspection.close())?.closed!==true)throw new Error('Inspection cleanup closure unconfirmed');inspectionClosed=true;}catch(error){cleanup.push(error);}
     if(selectionAttempt&&!selectionClosed)try{await clearSelection();selectionClosed=true;}catch(error){cleanup.push(error);}
     const closed=(!inspectionAttempt||inspectionClosed)&&selectionClosed&&(!captureAttempt||captureClosed)&&(!recordAttempt||recordClosed);if(!closed)allClosed=false;
     if(lease&&closed)try{lease.release();}catch(error){allClosed=false;cleanup.push(error);}
    }
    if(primary||cleanup.length)throw cleanup.length?new AggregateError([...(primary?[primary]:[]),...cleanup],String(primary?.message??'First-four cleanup failed')+'; cleanup: '+cleanup.map(x=>String(x.message??x)).join('; ')):primary;
   }
   return Object.freeze({scope:'first-four private numeric component diagnostics only',cases:Object.freeze(outputs),closed:true});
  }finally{if(allClosed&&active===token)active=null;}
 }});
}
/** Compact live counters; URL objects/JSON are reconstructed only after capture. */
export function createFirstFourNetwork(assets,origin){
 const keys=Object.keys(assets);if(keys.length!==14||keys.some(key=>!/^[-a-z0-9.]{1,31}$/u.test(key))||typeof origin!=='string'||origin.length>32)throw new Error('Closed network literals changed');
 const names=['/',...keys.map(key=>'/'+key)],counts=new Uint16Array(2*names.length);let total=0,distinct=0,bad=null,overflow=false;
 return Object.freeze({record(pathname,method){const i=names.indexOf(pathname),j=method==='GET'?0:method==='HEAD'?1:-1;if(i<0||j<0||origin.length+pathname.length>64||total===256){overflow=true;return false;}const index=2*i+j;if(!counts[index]&&distinct===28){overflow=true;return false;}if(!counts[index])distinct++;counts[index]++;total++;return true;},refuse(url,method){if(bad)overflow=true;else bad={url:String(url).slice(0,64),method:String(method).slice(0,8),truncated:String(url).length>64};},get failed(){return Boolean(bad)||overflow;},get requests(){return total;},summary(){const inventory=[];for(let i=0;i<names.length;i++)for(let j=0;j<2;j++)if(counts[2*i+j])inventory.push({url:origin+names[i],method:j?'HEAD':'GET',bodyBytes:0,count:counts[2*i+j]});return{requests:total,inventory,violations:bad?[{...bad}]:[],overflow};}});
}
/** Only literal DOM/CDP commands; no framework file read/base64/upload API. */
export function createCDPSelection(cdp){let nodeId;
 const locate=async()=>{const document=await cdp.send('DOM.getDocument',{depth:0});const found=await cdp.send('DOM.querySelector',{nodeId:document.root.nodeId,selector:'#fixture'});if(!Number.isSafeInteger(found.nodeId)||found.nodeId<=0)throw new Error('Exact fixture input missing');return found.nodeId;};
 return Object.freeze({async select(file,pin){if(!path.isAbsolute(file)||path.basename(file)!==pin.name)throw new Error('Exact fixture path required');nodeId=await locate();await cdp.send('DOM.setFileInputFiles',{nodeId,files:[file]});},async clear(){if(nodeId){await cdp.send('DOM.setFileInputFiles',{nodeId,files:[]});nodeId=undefined;}}});
}
