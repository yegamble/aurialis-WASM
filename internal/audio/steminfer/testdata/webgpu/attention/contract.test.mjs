import { test } from "node:test";
import assert from "node:assert/strict";
import { shapePlan, parseFixture, classifyStages, directedFloat32Interval, dotDiagnostic, expReferenceInterval, expGPUInterval, divisionGPUInterval, MIN_NORMAL } from "./contract.mjs";
test("all eight padded GPU stages and both dots fit the fixed caps at the true full key count", () => {
  const plan = shapePlan(8, 1723);
  assert.equal(plan.gpuWork, Object.values(plan.gpuStages).reduce((a, b) => a + b, 0));
  assert.deepEqual(Object.keys(plan.gpuStages), ["raw", "scaled", "maximum", "shifted", "exponential", "denominator", "probability", "output"]);
  assert.equal(plan.gpuWork, 3_621_872); assert.equal(plan.referenceWork, 1_946_144);
  assert.ok(plan.chargedApplicationBytes < 16 * 1024 * 1024);
  assert.equal(2 * Math.ceil(8 / 64) * Math.ceil(1723 / 64) * 4096 * 64, 14_155_776, "old64row shader would violate the total8M cap");
  for (const n of [1,15,16,17,63,64,65,255,256,257,1723]) for (const m of [1,3,8]) assert.ok(shapePlan(m,n).gpuWork <= 8_388_608);
  for (const m of [0,9,1.5,NaN,Infinity,2**32]) assert.throws(() => shapePlan(m,1));
  for (const n of [0,1724,1.5,NaN,Infinity,2**32]) assert.throws(() => shapePlan(1,n));
  assert.throws(() => shapePlan(1,1,63));
});
test("directed Float32 intervals admit BOTH adjacent results, including non-nearest boundaries", () => {
  assert.deepEqual(directedFloat32Interval(1+2**-24),[1,1+2**-23]);
  assert.deepEqual(directedFloat32Interval(-1-2**-24),[-1-2**-23,-1]);
  assert.deepEqual(directedFloat32Interval(2**-150),[0,2**-149]);
  assert.deepEqual(directedFloat32Interval(-(2**-150)),[-(2**-149),0]);
  assert.deepEqual(directedFloat32Interval(1),[1,1]);
  assert.throws(() => directedFloat32Interval(1e39));
});
test("compensated exact-input dot diagnostics disclose their own nonzero Float64 error", () => {
  const left = Float32Array.from([16,16,-16,-16,2**-120]), right = Float32Array.from([1,1,1,1,1]);
  const result = dotDiagnostic(left,right,5);
  assert.equal(result.value,2**-120); assert.ok(result.referenceError>0); assert.ok(result.arithmeticError>=result.referenceError);
  assert.ok(result.sumAbsolute>=64); assert.throws(() => dotDiagnostic(left,right,6));
  assert.throws(() => dotDiagnostic(Float32Array.of(NaN),Float32Array.of(1),1));
});
test("positive-series exp enclosure is independently bounded rather than trusting Math.exp as exact", () => {
  for (const x of [0,-.0001,-.125,-1,-16,-64,-87.5,-100,-744,-4096]) {
    const interval=expReferenceInterval(x), diagnostic=Math.exp(x);
    assert.ok(interval[0]>=0 && interval[0]<=diagnostic && diagnostic<=interval[1],JSON.stringify({x,interval,diagnostic}));
  }
  assert.throws(() => expReferenceInterval(.1)); assert.throws(() => expReferenceInterval(-4097));
});
test("FTZ resurrection stays LIMITED even if a legal GPU exponential/probability becomes zero", () => {
  const q=Float32Array.from([16,16,16,16]), k=Float32Array.from([-10.9375,-10.9375,-10.9375,-10.9375]);
  const raw=dotDiagnostic(q,k,4).value; assert.equal(raw,-700);
  const score=raw*.125; assert.equal(score,-87.5);
  const exponential=expGPUInterval(score), e=Math.fround(Math.exp(score)), probability=divisionGPUInterval(e,1);
  assert.ok(e>0 && e<MIN_NORMAL); assert.ok(Math.fround(e*32)>=MIN_NORMAL);
  assert.equal(exponential.underflowLimited,true); assert.equal(exponential.lower,0);
  assert.equal(probability.underflowLimited,true); assert.equal(probability.lower,0);
  assert.ok(exponential.upper>=e && probability.upper>=e);
  assert.equal(exponential.underflowLimited || probability.underflowLimited,true,"observed zeros must not create ordinary classification");
});
test("division range rejects invalid domains and retains subnormal exact-quotient applicability", () => {
  for (const d of [0,-1,NaN,Infinity,2**127,2**-127]) assert.throws(() => divisionGPUInterval(1,d));
  const result=divisionGPUInterval(MIN_NORMAL,2); assert.equal(result.underflowLimited,true);assert.equal(result.lower,0);
  const ordinary=divisionGPUInterval(.5,2);assert.equal(ordinary.underflowLimited,false);assert.ok(ordinary.lower<=.25 && ordinary.upper>=.25);
});

// Fabricated unit traces are distinct from actual Go/Attend/SDPA artifacts.
function unitTrace() {
  const plan=shapePlan(1,2), buffer=new ArrayBuffer(plan.fixtureBytes), view=new DataView(buffer);
  new Uint8Array(buffer,0,8).set(new TextEncoder().encode("AURATT01"));
  for(const [offset,value] of [[8,1],[12,2],[16,64]]) view.setUint32(offset,value,true);
  const fixture=parseFixture(buffer),a=fixture.arrays;
  for(let i=0;i<4;i++) { a.q[i]=16;a.k[64+i]=-10.9375; }
  a.v.fill(32,64);
  a.raw[1]=-700;a.goRaw.set(a.raw);a.torchRaw.set(a.raw);a.scaled[1]=-87.5;a.shifted[1]=-87.5;
  a.exponential[0]=1;a.exponential[1]=Math.fround(Math.exp(-87.5));a.denominator[0]=1;a.probability.set(a.exponential);
  a.output.fill(Math.fround(a.probability[1]*32));
  return fixture;
}
test("independent stage audit rejects forged references and every intervening stage",()=> {
  assert.equal(classifyStages(unitTrace()).classification,"underflow-limited");
  for(const name of ["raw","goRaw","torchRaw","scaled","maximum","shifted","exponential","denominator","probability","output"]) {
    const fixture=unitTrace();fixture.arrays[name][0]=99;
    assert.throws(()=>classifyStages(fixture),undefined,name);
  }
  const fixture=unitTrace();fixture.arrays.shifted[1]=0;
  assert.throws(()=>classifyStages(fixture),/shift/,"rewriting a boundary stage cannot conceal FTZ");
});
test("actual zeroed exp/probability/final traces cannot manufacture ordinary classification",()=> {
  const fixture=unitTrace(),a=fixture.arrays;
  a.exponential[1]=0;a.probability[1]=0;a.output.fill(0);
  const report=classifyStages(fixture);assert.equal(report.classification,"underflow-limited");assert.ok(report.reasons.includes("exponential-underflow"));
  a.q[8]=2**-140;assert.ok(classifyStages(fixture).reasons.includes("source-underflow"));
});
