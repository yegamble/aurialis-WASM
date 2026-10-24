/** Private saved CPU reference audit; no Worker, GPU, model or audio. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, lstat } from "node:fs/promises";
import path from "node:path";
import { parseFixture, classifyStages } from "./contract.mjs";
const directory = process.argv[2];
if (!directory) throw new Error("Provide the new original attention fixture directory");
const manifestPath = path.join(directory,"manifest.json"), manifestStat = await lstat(manifestPath);
assert.ok(manifestStat.isFile() && !manifestStat.isSymbolicLink() && manifestStat.size<=65536);
const manifestBytes = await readFile(manifestPath), manifest=JSON.parse(manifestBytes);
assert.equal(manifest.format,"aurialis-private-attention-traces-1");assert.equal(manifest.publicActivation,false);
assert.equal(manifest.modelForwards,0);assert.equal(manifest.gpuOperations,0);assert.equal(manifest.torchThreads,1);assert.equal(manifest.torchInteropThreads,1);
assert.ok(manifest.cases.length>=1 && manifest.cases.length<=32);
const seen=new Set(), cases=[];
let total=manifestBytes.length, maximumApplicationBytes=0, maximumReferenceWork=0, maximumGPUWork=0;
for(const record of manifest.cases) {
  assert.match(record.name,/^[a-z0-9-]+-m[0-9]+-n[0-9]+\.bin$/u);assert.ok(!seen.has(record.name));seen.add(record.name);
  const file=path.join(directory,record.name), stat=await lstat(file);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size<=2*1024*1024);assert.equal(stat.size,record.bytes);
  const bytes=await readFile(file);total+=bytes.length;assert.ok(total<=64*1024*1024);
  assert.equal(createHash("sha256").update(bytes).digest("hex"),record.sha256);
  // Own this snapshot before any future asynchronous comparison. Parsing alone
  // creates mutable views; it is not an immutable or caller-safe runtime API.
  const snapshot=bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength), fixture=parseFixture(snapshot);
  assert.deepEqual([fixture.plan.m,fixture.plan.n],[record.m,record.n]);
  const report=classifyStages(fixture);
  const maxDifference=(left,right)=>left.reduce((maximum,value,index)=>Math.max(maximum,Math.abs(value-right[index])),0);
  cases.push({name:record.name,kind:record.kind,m:record.m,n:record.n,...report,
    actualGoVsActualMathMaximumDifference:maxDifference(fixture.arrays.goOutput,fixture.arrays.torchOutput),
    actualSDPAVsActualMathMaximumDifference:maxDifference(fixture.arrays.sdpaOutput,fixture.arrays.torchOutput),
    unfusedProbeVsActualMathMaximumDifference:maxDifference(fixture.arrays.output,fixture.arrays.torchOutput)});
  maximumApplicationBytes=Math.max(maximumApplicationBytes,fixture.plan.chargedApplicationBytes);maximumReferenceWork=Math.max(maximumReferenceWork,fixture.plan.referenceWork);maximumGPUWork=Math.max(maximumGPUWork,fixture.plan.gpuWork);
}
const resurrection=cases.find(item=>item.kind==="ftz-resurrection");assert.equal(resurrection?.classification,"underflow-limited");
console.log(JSON.stringify({scope:"CPU input/reference audit only; worker ownership and full propagated-stage/hardware gates pending",manifestSHA256:createHash("sha256").update(manifestBytes).digest("hex"),cases,fixtureBytes:total,maximumDeclaredApplicationBufferBytes:maximumApplicationBytes,maximumDeclaredReferenceWork:maximumReferenceWork,maximumPlannedGPUWork:maximumGPUWork,modelForwards:0,gpuOperations:0},null,2));
