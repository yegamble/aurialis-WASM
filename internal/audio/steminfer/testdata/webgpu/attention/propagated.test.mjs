import {test}from'node:test';import assert from'node:assert/strict';
import {analyzeStages,resultLayout}from'./propagated.mjs';import {synthetic,packed}from'./test-helpers.mjs';
test('all-zero, exact tie and normal dyadic inputs retain non-vacuous ordinary applicability',()=>{
 for(const kind of ['zero','tie','normal']){const f=synthetic(1,65,kind),r=analyzeStages(f,packed(f));assert.equal(r.classification,'ordinary-input-diagnostic',JSON.stringify({kind,reasons:r.reasons}));assert.equal(r.termVisits,2*65*64);assert.ok(r.maximumOutputIntervalWidth<.1);}
});
test('complete raw-to-PV propagation encloses every stage and visits each dot term once',()=>{
 const f=synthetic(3,17,'normal'),r=analyzeStages(f,packed(f));assert.equal(r.termVisits,2*3*17*64);for(const [name,b]of Object.entries(r.bounds))for(let i=0;i<f.arrays[name].length;i++)assert.ok(b[2*i]<=f.arrays[name][i]&&f.arrays[name][i]<=b[2*i+1]);
});
test('FTZ resurrection and source-underflow remain limited after zeroing observed intermediates',()=>{
 const f=synthetic(1,2,'resurrection');for(const zeroed of [false,true]){const result=packed(f),a=resultLayout(f.plan,result);if(zeroed){a.exponential[1]=0;a.probability[1]=0;a.output.fill(0);}const r=analyzeStages(f,result);assert.equal(r.classification,'underflow-limited');assert.ok(r.reasons.includes('propagated-exponential-underflow'));}
 const f2=synthetic();f2.arrays.q[0]=2**-140;assert.equal(analyzeStages(f2,packed(f2)).classification,'underflow-limited');
});
test('no file-provided bound or saved endpoint can authorize corrupted eight-stage output',()=>{
 for(const name of ['raw','scaled','maximum','shifted','exponential','denominator','probability','output']){const f=synthetic(1,2,'normal'),result=packed(f);resultLayout(f.plan,result)[name][0]=99;assert.throws(()=>analyzeStages(f,result),undefined,name);}
 const f=synthetic(1,2,'normal');f.arrays.goRaw[0]=99;assert.throws(()=>analyzeStages(f,packed(f)),/goRaw/);
});
test('ragged full-N tail participates in both dot traversals; no prefix-only result can pass',()=>{
 const f=synthetic(1,1723,'resurrection'),result=packed(f),r=analyzeStages(f,result);assert.equal(r.termVisits,2*1723*64);resultLayout(f.plan,result).raw[1722]=0;assert.throws(()=>analyzeStages(f,result),/raw/);
});
test('interval ULP transitions use whole-domain budgets and explicit outside-exp underflow',async()=>{
 const{expSpan,probabilitySpan}=await import('./propagated.mjs');
 const p=probabilitySpan(.5-2**-25,.5+2**-25,1,1);assert.ok(p.lower<.5-2.5*2**-24);assert.ok(p.upper>.5+2.5*2**-24);
 const e=expSpan(-.125,0);for(const x of[-.125,-.0625,0]){const exact=Math.exp(x);assert.ok(e.lower<=exact&&exact<=e.upper);}
 const tiny=expSpan(-4097,-4096.5);assert.equal(tiny.lower,0);assert.ok(tiny.upper>0);assert.equal(tiny.underflowLimited,true);assert.throws(()=>expSpan(-8193,-8192));assert.throws(()=>expSpan(0,1));
});
