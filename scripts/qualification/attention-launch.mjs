/** Private normal/crash ownership controls only. Importing never launches work. */
import {createHash} from 'node:crypto';
import {readFile,lstat,writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {admittedBrowser,beforeOwnedWork,exclusiveJSON} from './owned-browser.mjs';

export function launchOptions(pins){
 if(pins.brave.path!=='/Applications/Brave Browser.app/Contents/MacOS/Brave Browser')throw new Error('Exact installed Brave required');
 return Object.freeze({headless:false,chromiumSandbox:true,executablePath:pins.brave.path});
}
const errorView=error=>error instanceof AggregateError?{message:String(error.message).slice(0,512),causes:error.errors.slice(0,4).map(cause=>String(cause?.stack??cause).slice(0,512))}:String(error?.stack??error).slice(0,2048);
export async function runOwnershipProbe(mode,deps){
 if(!['normal','crash'].includes(mode))throw new Error('Only normal/crash ownership controls released');
 let server,host,browser,context,primary=null,details=null;const cleanup=[];
 try{
  server=await deps.admit(launchOptions(deps.pins));
  if(deps.stopping())throw new Error('Stopped after browser admission');
  // The managed host exists BEFORE its spawn/acquisition task starts.
  host=deps.prepareHost();await host.acquire();const endpoint=await host.ready();
  await deps.publish('static-server',{serverPID:host.pid(),url:endpoint.url});
  await deps.beforeWork();if(deps.stopping())throw new Error('Stopped before acknowledged work');
  browser=await deps.connect(server);context=await browser.newContext();
  details=await deps.probe(context,browser,endpoint.url);
  await deps.publish('probe-ready',{status:'pass',mode,serverPID:host.pid(),ownershipAcknowledgedBeforeWorker:true,audioProcessing:false,gpuRequested:false});
  if(mode==='crash')await deps.waitForStop();
  if(deps.stopping())throw new Error('Owned no-audio root stopped');
 }catch(error){primary=errorView(error);}
 finally{
  for(const [phase,operation]of[['context',()=>context?.close()],['connection',()=>browser?.close()],['static-server',()=>host?.close()],['browser-server',()=>server?.close()]]){
   try{await operation();}catch(error){cleanup.push({phase,error:errorView(error)});}
  }
 }
 return Object.freeze({mode,status:primary===null&&!cleanup.length?'pass':'fail',primary,cleanup,details,audioProcessing:false,gpuRequested:false});
}

/** No child exists at construction; failed acquisition keeps this exact handle. */
export function prepareStaticHost(python,serveFile,environment){
 let child,readyPromise,exitPromise,closed=false,started=false;
 return Object.freeze({
  acquire(){
   if(started)throw new Error('Static host already started');started=true;
   child=spawn(python,[serveFile],{env:environment,stdio:['ignore','pipe','pipe'],detached:false});
   exitPromise=new Promise(resolve=>child.once('close',(code,signal)=>resolve({code,signal})));
   readyPromise=new Promise((resolve,reject)=>{
    let text='',done=false;const deadline=setTimeout(()=>finish(new Error('Static host startup deadline')),5000);
    const finish=(error,value)=>{if(done)return;done=true;clearTimeout(deadline);error?reject(error):resolve(value);};
    child.once('error',error=>finish(error));child.once('close',()=>finish(new Error('Static host exited before ready')));
    child.stdout.on('data',chunk=>{
     if(done)return;if(text.length+chunk.length>4096){finish(new Error('Static host metadata cap'));return;}text+=chunk.toString('utf8');
     if(!text.endsWith('\n'))return;
     try{const value=JSON.parse(text);if(Object.keys(value).sort().join('|')!=='scope|url'||value.scope!=='private static assets only'||!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/u.test(value.url)||Number(new URL(value.url).port)>65535)throw new Error('Invalid static host endpoint');finish(null,Object.freeze(value));}catch(error){finish(error);}
    });
    child.stderr.on('data',chunk=>{if(!done)finish(new Error('Static host stderr: '+chunk.toString('utf8').slice(0,1024)));});
   });
   // Own a possible early rejection even before the caller awaits ready().
   void readyPromise.catch(()=>{});
  },
  pid(){return child?.pid;},
  ready(){if(!started)throw new Error('Static host not started');return readyPromise;},
  async close(){
   if(closed)return;if(!child){closed=true;return;}
   if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');
   let timer;try{await Promise.race([exitPromise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Static host close unsettled')),3000);})]);closed=true;}finally{clearTimeout(timer);}
  }
 });
}
async function verifyFile(pin){const info=await lstat(pin.path);if(!info.isFile()||info.isSymbolicLink()||info.size!==pin.bytes)throw new Error('Pinned runtime file geometry changed');const bytes=await readFile(pin.path);if(createHash('sha256').update(bytes).digest('hex')!==pin.sha256)throw new Error('Pinned runtime digest changed');}
async function realMain(){
 const [mode,output]=process.argv.slice(2);if(!['normal','crash'].includes(mode)||!output||!path.isAbsolute(output))throw new Error('Closed normal/crash mode and absolute private output required');
 const pins=JSON.parse(await readFile(new URL('./attention-launch-pins.json',import.meta.url),'utf8'));
 if(process.version!==pins.nodeVersion||process.execPath!==pins.node.path)throw new Error('Pinned Node26 entry required');
 for(const key of ['brave','python','playwrightEntry','playwrightPackage','playwrightCore'])await verifyFile(pins[key]);
 const repository=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
 for(const helper of pins.helpers)await verifyFile({...helper,path:path.join(repository,helper.path)});
 const require=createRequire(pins.playwrightEntry.path),{chromium}=require(pins.playwrightEntry.path);
 if(require(pins.playwrightPackage.path).version!==pins.playwrightVersion)throw new Error('Pinned Playwright version changed');
 const token=process.env.AURIALIS_OWNERSHIP_TOKEN;if(!/^[a-f0-9]{64}$/u.test(token??'')||process.env.AURIALIS_OWNERSHIP_DIR!==output)throw new Error('Owned control directory/token required');
 let stopping=false;process.on('SIGTERM',()=>{stopping=true;});process.on('SIGINT',()=>{stopping=true;});
 const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..'),serve=path.join(root,'internal/audio/steminfer/testdata/webgpu/attention/serve.py');
 const assets=JSON.parse(await readFile(path.join(path.dirname(serve),'asset-manifest.json'),'utf8'));
 const result=await runOwnershipProbe(mode,{
  pins,stopping:()=>stopping,
  admit:options=>admittedBrowser(chromium,options,()=>stopping),
  prepareHost:()=>prepareStaticHost(pins.python.path,serve,{...process.env}),
  beforeWork:()=>beforeOwnedWork(()=>stopping),
  connect:server=>chromium.connect(server.wsEndpoint(),{timeout:5000}),
  async publish(kind,value){await exclusiveJSON(path.join(output,kind+'.json'),{token,nodePID:process.pid,browserPID:Number(process.env.AURIALIS_OWNED_BROWSER_PID),...value});},
  async probe(context,browser,url){
   const inventory=[],violations=[];let routeOverflow=false;
   await context.route('**/*',async route=>{const request=route.request(),target=new URL(request.url());if(target.protocol==='blob:'&&request.method()==='GET'&&!request.postDataBuffer()){await route.continue();return;}const allowed=target.origin===url&&['GET','HEAD'].includes(request.method())&&!request.postDataBuffer()&&(target.pathname==='/'||Object.hasOwn(assets,target.pathname.slice(1)))&&!target.search&&!target.hash;if(inventory.length+violations.length>=256){routeOverflow=true;await route.abort();return;}if(!allowed){violations.push({url:request.url().slice(0,2048),method:request.method()});await route.abort();return;}inventory.push({url:request.url().slice(0,2048),method:request.method(),bodyBytes:0});await route.continue();});
   const control=await context.newPage();await control.goto('about:blank');
   const workerResult=await control.evaluate(()=>new Promise((resolve,reject)=>{
    const url=URL.createObjectURL(new Blob(['postMessage(1)'],{type:'application/javascript'})),worker=new Worker(url),deadline=setTimeout(()=>{worker.terminate();URL.revokeObjectURL(url);reject(new Error('No-audio Worker deadline'));},2000);
    worker.onmessage=event=>{clearTimeout(deadline);worker.terminate();URL.revokeObjectURL(url);event.data===1?resolve(1):reject(new Error('No-audio Worker changed'));};worker.onerror=()=>{clearTimeout(deadline);worker.terminate();URL.revokeObjectURL(url);reject(new Error('No-audio Worker failed'));};
   }));
   const page=await context.newPage();await page.goto(url,{waitUntil:'load',timeout:5000});await page.waitForFunction(()=>globalThis.aurialisPrivateAttentionCapture?.status().phase==='idle',{},{timeout:5000});
   const cdp=await browser.newBrowserCDPSession();let system,version;try{version=await cdp.send('Browser.getVersion');system=await cdp.send('SystemInfo.getInfo');}finally{await cdp.detach();}
   if(!Array.isArray(system.gpu?.devices)||system.gpu.devices.length>16)throw new Error('CDP GPU identity geometry');
   const bounded=value=>String(value??'').slice(0,512);
   const gpuRenderer={devices:system.gpu.devices.map(device=>({vendorId:device.vendorId,deviceId:device.deviceId,vendorString:bounded(device.vendorString),deviceString:bounded(device.deviceString),driverVersion:bounded(device.driverVersion)})),glRenderer:bounded(system.gpu.auxAttributes?.glRenderer),glVendor:bounded(system.gpu.auxAttributes?.glVendor),adapter:'NOT REQUESTED: no navigator.gpu call',features:null,limits:null};
   if(workerResult!==1||violations.length||routeOverflow)throw new Error('No-audio control/network inventory failed');
   const evidence={scope:'actual no-audio/no-GPU-request ownership control only; not adapter or model qualification',browserVersion:browser.version(),cdpVersion:{product:bounded(version.product),revision:bounded(version.revision),jsVersion:bounded(version.jsVersion)},gpuRenderer,workerResult,inventory,violations,fixtureFilesSelected:0};
   const encoded=JSON.stringify(evidence,null,2);if(Buffer.byteLength(encoded)>131072)throw new Error('Probe details output cap');await writeFile(path.join(output,'probe-details.json'),encoded,{flag:'wx',mode:0o600});return{workerResult,requests:inventory.length,violations:violations.length};
  },
  async waitForStop(){while(!stopping)await new Promise(resolve=>setTimeout(resolve,25));}
 });
 const encoded=JSON.stringify(result,null,2);if(Buffer.byteLength(encoded)>16384)throw new Error('Launcher result cap');await writeFile(path.join(output,'launcher.json'),encoded,{flag:'wx',mode:0o600});if(result.status!=='pass')process.exitCode=1;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))void realMain().catch(error=>{process.stderr.write(JSON.stringify(errorView(error))+'\n');process.exitCode=1;});
