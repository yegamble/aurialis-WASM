// Actual compiled-WASI source-time schedule parity and bounded publication probes.
import { readFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";
import assert from "node:assert/strict";
import { createAurialisWasiHost } from "../../public/worklets/aurialis-wasi-host.js";
import { engineParams } from "../../src/lib/browser-engine.ts";
import { packLiveControls } from "../../src/lib/live-controls.ts";

const [modulePath,...fixturePaths]=process.argv.slice(2);
assert.ok(modulePath&&fixturePaths.length,"supply reactor and native automation fixtures");
const module=await WebAssembly.compile(await readFile(modulePath));
const fixtures=[];
for(const path of fixturePaths)fixtures.push(...JSON.parse(await readFile(path,"utf8")));
async function kernel(fixture){
 const host=createAurialisWasiHost({entropy:webcrypto.getRandomValues(new Uint8Array(256)),now:()=>performance.now()+1});
 const instance=await WebAssembly.instantiate(module,host.imports);const wasm=instance.exports;host.attach(wasm.memory);wasm._initialize();assert.equal(wasm.aurialis_init(fixture.rate),1);assert.equal(wasm.aurialis_schedule_abi(),1);
 const sourcePointer=wasm.aurialis_schedule_source_buffer()>>>0,controlPointer=wasm.aurialis_control_buffer_v2()>>>0,movePointer=wasm.aurialis_schedule_move_buffer()>>>0;
 const channels=[0,1,2,3].map(index=>wasm.aurialis_live_buffer(index)>>>0);
 function source(frames=fixture.frames){new Float64Array(wasm.memory.buffer,sourcePointer,11).set([1,fixture.sourceRate,frames,1,2,3,4,5,6,7,8]);}
 function controls(){new Float64Array(wasm.memory.buffer,controlPointer,82).set(packLiveControls(fixture.params,2));}
 function stage(index,move){const values=new Float64Array(wasm.memory.buffer,movePointer,516);values.set([move.target,move.points.length,move.fadeFrames,move.muted?1:0]);for(const [pointIndex,point]of move.points.entries()){values[4+2*pointIndex]=point.frame;values[5+2*pointIndex]=point.value;}return wasm.aurialis_schedule_stage_move(index);}
 let renderBuffer,renderViews,renderOutputs;
 function refresh(){if(renderBuffer!==wasm.memory.buffer){renderBuffer=wasm.memory.buffer;renderViews=channels.map(pointer=>new Float32Array(renderBuffer,pointer,128));renderOutputs=renderViews.slice(2);}}
 function render(left,right){refresh();renderViews[0].set(left);renderViews[1].set(right);assert.equal(wasm.aurialis_live_process(),128);refresh();return renderOutputs;}
 source();assert.equal(wasm.aurialis_schedule_bind_source(),1);controls();host.beginRender();
 return{wasm,source,controls,stage,render};
}
function assertPublicBaselineRoundTrip(params){
 const filters={low_shelf:"lowshelf",high_shelf:"highshelf",high_pass:"highpass",peaking:"peaking"};
 const advanced={input:params.inputGainDb,eqEnabled:params.eqEnabled,eqBands:params.bands.map((band,index)=>({...band,id:String(index),label:String(index),type:filters[band.type]})),
 compressor:{enabled:params.compressor.enabled,threshold:params.compressor.thresholdDb,ratio:params.compressor.ratio,attack:params.compressor.attackMs,release:params.compressor.releaseMs,knee:params.compressor.kneeDb,makeup:params.compressor.makeupDb,sidechainHpfHz:params.compressor.sidechainHpfHz,autoRelease:params.compressor.autoRelease},
 saturationModule:{enabled:params.saturation.enabled,drive:params.saturation.amount,character:params.saturation.character},stereo:{...params.stereo,width:params.stereo.widthPct},
 limiter:{enabled:params.limiter.enabled,ceiling:params.limiter.ceilingDbtp,targetLufs:params.limiter.targetLufs,release:params.limiter.releaseMs,truePeak:params.limiter.truePeak},repair:{enabled:params.repair.enabled,declick:false,declip:false,phaseAlign:false},deHarsh:params.deHarsh,multiband:params.multiband};
 assert.deepEqual(packLiveControls(engineParams(advanced),2),packLiveControls(params,2),"generated public v2 baseline cannot round-trip real Advanced/static controls");
}
for(const [index,fixture]of fixtures.entries()){
 if(fixture.publicProfile)assertPublicBaselineRoundTrip(fixture.params);
 const current=await kernel(fixture),{wasm}=current;let revision=1;
 function compareRange(first,last){for(let start=first;start<last;start+=128){const output=current.render(fixture.Left.slice(start,start+128),fixture.Right.slice(start,start+128));for(let frame=0;frame<128;frame++){assert.equal(output[0][frame],Math.fround(fixture.OutputLeft[start+frame])||0,`left fixture ${index} frame ${start+frame}`);assert.equal(output[1][frame],Math.fround(fixture.OutputRight[start+frame])||0,`right fixture ${index} frame ${start+frame}`);}}}
 function stage(next){assert.equal(wasm.aurialis_schedule_begin(next,fixture.moves.length,fixture.rate),1);for(const [moveIndex,move]of fixture.moves.entries())assert.equal(current.stage(moveIndex,move),1);}
 if(fixture.staticFrames){
  assert.equal(wasm.aurialis_set_controls_v2(82),1);assert.equal(wasm.aurialis_schedule_set_looping(1),1);assert.equal(wasm.aurialis_schedule_seek(fixture.seek),1);
  compareRange(0,fixture.stageAt);current.source();assert.equal(wasm.aurialis_schedule_bind_source(),1,"same source bind must preserve static phase/history");
  assert.equal(wasm.aurialis_schedule_begin(0,1,fixture.rate),0);assert.equal(wasm.aurialis_schedule_commit(),0);
 }
 stage(1);if(fixture.staticFrames)compareRange(fixture.stageAt,fixture.staticFrames);
 assert.equal(wasm.aurialis_schedule_commit(),1);assert.equal(wasm.aurialis_schedule_revision(),1);assert.equal(wasm.aurialis_set_controls_v2(82),0,"static packet silently replaced attached baseline");
 assert.equal(wasm.aurialis_schedule_set_looping(2),0);
 if(fixture.staticFrames){assert.equal(wasm.aurialis_schedule_bind_source(),1,"same active source bind must be idempotent");}else{assert.equal(wasm.aurialis_schedule_set_looping(fixture.looping?1:0),1);assert.equal(wasm.aurialis_schedule_seek(fixture.seek),1);}
 for(let start=fixture.staticFrames||0;start<fixture.Left.length;start+=128){
  if(start===fixture.detachAt){assert.equal(wasm.aurialis_schedule_detach(),1);assert.equal(wasm.aurialis_set_controls_v2(82),1);}
  if(start===fixture.reapplyAt){stage(2);assert.equal(wasm.aurialis_schedule_commit(),1);revision=2;}
  compareRange(start,start+128);
 }
 assert.equal(wasm.aurialis_schedule_begin(revision,0,fixture.rate),0,"stale revision accepted");assert.equal(wasm.aurialis_schedule_seek(-1),0);assert.equal(wasm.aurialis_schedule_revision(),revision);assert.equal(wasm.aurialis_schedule_detach(),1);assert.equal(wasm.aurialis_set_controls_v2(82),1);
}

const capacity=await kernel(fixtures.find(fixture=>fixture.rate===48000));const{wasm}=capacity;
capacity.source(128*4096);assert.equal(wasm.aurialis_schedule_bind_source(),1);capacity.controls();
assert.equal(wasm.aurialis_schedule_begin(1,128,48000),1);const stageTimes=[];
for(let moveIndex=0;moveIndex<128;moveIndex++){
 const points=Array.from({length:256},(_,index)=>({frame:(127-moveIndex)*4096+index*16,value:index===0||index===255?0:.0001*Math.sin(index)}));
 const move={target:3,points,fadeFrames:0,muted:false};const start=performance.now();assert.equal(capacity.stage(moveIndex,move),1);stageTimes.push(performance.now()-start);
}
const commitStart=performance.now();assert.equal(wasm.aurialis_schedule_commit(),1);const commitMs=performance.now()-commitStart;
const left=new Float32Array(128).fill(.2),right=new Float32Array(128).fill(-.1),processTimes=[];
for(let block=0;block<1024;block++){const start=performance.now();capacity.render(left,right);processTimes.push(performance.now()-start);}
function summary(values){const sorted=values.toSorted((a,b)=>a-b);return{medianMs:sorted[Math.floor(sorted.length/2)],p99Ms:sorted[Math.floor(sorted.length*.99)],maxMs:sorted.at(-1)};}
console.log(JSON.stringify({nativeWasiFixtures:fixtures.length,maxMoves:128,maxPointsPerMove:256,stage:summary(stageTimes),commitMs,processing128Frames:summary(processTimes),timingScope:"Node M2 representative host; no universal audio deadline guarantee"}));
const sustained=[];
for(const rate of [8000,44100,48000,192000]){
 const fixture=fixtures.find(value=>value.rate===rate),current=await kernel(fixture),engine=current.wasm;
 current.source(128*4096);assert.equal(engine.aurialis_schedule_bind_source(),1);current.controls();assert.equal(engine.aurialis_schedule_begin(1,128,rate),1);
 const params=fixture.params,baseline=[params.inputGainDb,...params.bands.map(band=>band.gainDb),params.compressor.thresholdDb,params.compressor.ratio,params.saturation.amount,params.stereo.widthPct],staging=[];
 for(let moveIndex=0;moveIndex<128;moveIndex++){
  const target=moveIndex%10,section=12-Math.floor(moveIndex/10),epsilon=target===7?.00001:.0001;
  const points=Array.from({length:256},(_,index)=>({frame:section*4096+index*16,value:baseline[target]+(index===0||index===255?0:epsilon*((target===7||target===8?1:0)+Math.sin(index)))}));
  const start=performance.now();assert.equal(current.stage(moveIndex,{target,points,fadeFrames:0,muted:false}),1);staging.push(performance.now()-start);
 }
 const publication=performance.now();assert.equal(engine.aurialis_schedule_commit(),1);const publicationMs=performance.now()-publication,processing=[];
 for(let block=0;block<1024;block++){if(block%32===0)assert.equal(engine.aurialis_schedule_seek(16000),1);const start=performance.now();current.render(left,right);processing.push(performance.now()-start);}
 sustained.push({rate,stage:summary(staging),commitMs:publicationMs,processing128Frames:summary(processing)});
}
console.log(JSON.stringify({maxCapacityAllTenTargets:sustained,processingScope:"128 moves x256 points, reverse source order, repeated active source intervals; uses cached JS channel views; includes input copies; host scheduling outliers retained"}));
