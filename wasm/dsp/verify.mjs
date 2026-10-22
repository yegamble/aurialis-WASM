// cspell:words subviews
// Run: AURIALIS_PARITY_FIXTURE=/tmp/parity.json go test ./wasm/dsp -run TestWriteNativeParityFixture
// Then: node wasm/dsp/verify.mjs module.wasm wasm_exec.js /tmp/parity.json
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { webcrypto } from "node:crypto";
import assert from "node:assert/strict";

const [wasmPath, runtimePath, fixturePath] = process.argv.slice(2);
assert.ok(wasmPath && runtimePath && fixturePath, "supply module.wasm wasm_exec.js fixture.json");
globalThis.crypto ??= webcrypto;
await import(pathToFileURL(runtimePath).href);
const go = new globalThis.Go();
const { instance } = await WebAssembly.instantiate(await readFile(wasmPath), go.importObject);
void go.run(instance);
assert.equal(globalThis.aurialisDSPReady, true);
const fixtures = JSON.parse(await readFile(fixturePath, "utf8"));
let maximumError = 0;
for (const fixture of fixtures) {
  assert.equal(globalThis.aurialisDSPInit(fixture.rate), true);
  assert.equal(globalThis.aurialisDSPSetParams(JSON.stringify(fixture.params)), true);
  const left = Float32Array.from(fixture.left);
  const right = Float32Array.from(fixture.right);
  const outL = new Float32Array(128);
  const outR = new Float32Array(128);
  for (let start = 0; start < left.length; start += 128) {
    assert.equal(globalThis.aurialisDSPProcessBlock(left.subarray(start, start + 128), right.subarray(start, start + 128), outL, outR), 128);
    for (let offset = 0; offset < 128; offset++) {
      const errorL = Math.abs(outL[offset] - Math.fround(fixture.outputLeft[start + offset]));
      const errorR = Math.abs(outR[offset] - Math.fround(fixture.outputRight[start + offset]));
      maximumError = Math.max(maximumError, errorL, errorR);
      assert.ok(errorL <= 2e-6 && errorR <= 2e-6, `native/WASM mismatch at ${fixture.rate} Hz frame ${start + offset}`);
    }
  }
  assert.equal(globalThis.aurialisDSPReset(), true);
  assert.equal(globalThis.aurialisDSPProcessBlock(left.subarray(0, 128), right.subarray(0, 128), outL, outR), 128);
  for (let offset = 0; offset < 128; offset++) {
    assert.ok(Math.abs(outL[offset] - Math.fround(fixture.outputLeft[offset])) <= 2e-6, "left state survived reset");
    assert.ok(Math.abs(outR[offset] - Math.fround(fixture.outputRight[offset])) <= 2e-6, "right state survived reset");
  }
}
// Genuine storage metadata wins over shadow properties. Invalid brands and
// undersized backing views reject before DSP history or destinations change.
const boundaryFixture = fixtures.find(fixture => !fixture.params.bypass && fixture.params.saturation.amount >= 25);
assert.ok(boundaryFixture);
const boundaryL = Float32Array.from({ length: 128 }, (_, i) => 0.23 * Math.cos(i * 0.13));
const boundaryR = Float32Array.from({ length: 128 }, (_, i) => -0.17 * Math.sin(i * 0.23));
function initializeBoundary() {
  assert.equal(globalThis.aurialisDSPInit(boundaryFixture.rate), true);
  assert.equal(globalThis.aurialisDSPSetParams(JSON.stringify(boundaryFixture.params)), true);
}
function renderBoundary(outL = new Float32Array(128), outR = new Float32Array(128)) {
  assert.equal(globalThis.aurialisDSPProcessBlock(boundaryL, boundaryR, outL, outR), 128);
  return [outL, outR];
}
initializeBoundary();
const boundaryFirst = renderBoundary();
const boundaryNext = renderBoundary();
for (const property of ["length", "byteOffset", "buffer", Symbol.toStringTag]) {
  initializeBoundary();
  let reads = 0;
  const shadowL = boundaryL.slice(), outL = new Float32Array(128), outR = new Float32Array(128);
  for (const view of [shadowL, outR]) Object.defineProperty(view, property, {
    get() { reads++; throw new Error("shadow metadata must not be read"); },
  });
  assert.equal(globalThis.aurialisDSPProcessBlock(shadowL, boundaryR, outL, outR), 128);
  assert.deepEqual(outL, boundaryFirst[0]); assert.deepEqual(outR.slice(), boundaryFirst[1]);
  assert.equal(globalThis.aurialisDSPMeasure(shadowL, boundaryR), globalThis.aurialisDSPMeasure(boundaryL, boundaryR));
  assert.equal(reads, 0);
}
const shadowOne = Float32Array.of(0.125);
Object.defineProperty(shadowOne, "length", { value: 8 });
assert.equal(globalThis.aurialisDSPInit(48000), true);
assert.equal(globalThis.aurialisDSPProcessBlock(shadowOne, Float32Array.of(0.25)), 1);
assert.equal(shadowOne[0], 0.125);
const detachedInput = new Float32Array(128);
structuredClone(detachedInput.buffer, { transfer: [detachedInput.buffer] });
const detachedOutput = new Float32Array(128);
structuredClone(detachedOutput.buffer, { transfer: [detachedOutput.buffer] });
const forged = Object.create(Float32Array.prototype);
const wrongElement = new Float64Array(128);
Object.setPrototypeOf(wrongElement, Float32Array.prototype);
const shortInput = new Float32Array(1), shortOutput = Float32Array.of(0.5);
Object.defineProperty(shortInput, "length", { value: 128 });
Object.defineProperty(shortOutput, "length", { value: 128 });
const poisonedPrototype = new Float32Array(128);
Object.setPrototypeOf(poisonedPrototype, new Proxy(Float32Array.prototype, {
  getPrototypeOf() { throw new Error("invalid prototype chain"); },
}));
const invalidViews = [
  { name: "throwing prototype input", input: poisonedPrototype },
  { name: "forged input", input: forged },
  { name: "proxy input", input: new Proxy(new Float32Array(128), {}) },
  { name: "wrong element input", input: wrongElement },
  { name: "detached input", input: detachedInput },
  { name: "short input with shadow length", input: shortInput },
  { name: "forged output", output: forged },
  { name: "proxy output", output: new Proxy(new Float32Array(128), {}) },
  { name: "detached output", output: detachedOutput },
  { name: "short output with shadow length", output: shortOutput },
];
for (const invalid of invalidViews) {
  initializeBoundary(); renderBoundary();
  const outL = new Float32Array(128).fill(0.5), outR = new Float32Array(128).fill(-0.5);
  const input = invalid.input ?? boundaryL, output = invalid.output ?? outR;
  assert.equal(globalThis.aurialisDSPProcessBlock(input, boundaryR, outL, output), 0, invalid.name);
  assert.deepEqual(outL, new Float32Array(128).fill(0.5), `${invalid.name} changed output`);
  assert.deepEqual(outR, new Float32Array(128).fill(-0.5), `${invalid.name} changed output`);
  if (invalid.input) assert.equal(globalThis.aurialisDSPMeasure(input, boundaryR), "{}", invalid.name);
  const next = renderBoundary();
  assert.deepEqual(next[0], boundaryNext[0], `${invalid.name} advanced left history`);
  assert.deepEqual(next[1], boundaryNext[1], `${invalid.name} advanced right history`);
}
assert.equal(shortOutput[0], 0.5);
// Wrong JS types, non-finite samples, malformed JSON, and oversized blocks must
// return failure while preserving a usable bridge rather than panic the runtime.
assert.equal(globalThis.aurialisDSPInit(NaN), false);
assert.equal(globalThis.aurialisDSPInit("48000"), false);
assert.equal(globalThis.aurialisDSPSetBand("x", 1000, 1, 1), false);
for (const payload of ['null', '{"unknown":1}', '{"inputGainDb":null}', '{"bands":[]}', '{} {}']) {
  assert.equal(globalThis.aurialisDSPSetParams(payload), false);
}
assert.equal(globalThis.aurialisDSPProcessBlock(null, null), 0);
assert.equal(globalThis.aurialisDSPProcessBlock([1], [1]), 0);
assert.equal(globalThis.aurialisDSPProcessBlock(new Float32Array(65537), new Float32Array(65537)), 0);
assert.equal(globalThis.aurialisDSPProcessBlock(new Float32Array(2), new Float32Array(2), new Float32Array(1), new Float32Array(1)), 0);
assert.equal(globalThis.aurialisDSPProcessBlock(Float32Array.of(NaN), Float32Array.of(0)), 0);
assert.equal(globalThis.aurialisDSPInit(48000), true);
const one = Float32Array.of(0.125);
assert.equal(globalThis.aurialisDSPProcessBlock(one, one), 1);
assert.equal(one[0], 0.125);
// Byte transfers must honor typed-array offsets and retain the old interleaved
// write order when destination views overlap. Compare full backing buffers so
// writes outside the requested frame count cannot hide behind matching audio.
const frames = 17;
const sourceL = Float32Array.from({ length: frames }, (_, i) => i === 0 ? -0 : Math.sin(i * 0.71) * 0.21);
const sourceR = Float32Array.from({ length: frames }, (_, i) => Math.cos(i * 0.31) * -0.17);
const expectedL = new Float32Array(frames);
const expectedR = new Float32Array(frames);
assert.equal(globalThis.aurialisDSPInit(48000), true);
assert.equal(globalThis.aurialisDSPProcessBlock(sourceL, sourceR, expectedL, expectedR), frames);
assert.equal(Object.is(expectedL[0], -0), false, "preserve numeric bridge zero canonicalization");
for (const [leftOffset, rightOffset] of [[1, 2], [2, 1], [1, 1], [1, frames + 1]]) {
  const length = Math.max(leftOffset, rightOffset) + frames + 3;
  const backing = new Float32Array(length).fill(0.3125);
  const expected = backing.slice();
  const outputL = backing.subarray(leftOffset, leftOffset + frames + 2);
  const outputR = backing.subarray(rightOffset, rightOffset + frames + 2);
  for (let i = 0; i < frames; i++) {
    expected[leftOffset + i] = expectedL[i];
    expected[rightOffset + i] = expectedR[i];
  }
  const paddedL = new Float32Array(frames + 4).fill(0.75);
  const paddedR = new Float32Array(frames + 6).fill(-0.75);
  paddedL.set(sourceL, 1);
  paddedR.set(sourceR, 3);
  assert.equal(globalThis.aurialisDSPReset(), true);
  assert.equal(globalThis.aurialisDSPProcessBlock(paddedL.subarray(1, frames + 1), paddedR.subarray(3, frames + 3), outputL, outputR), frames);
  assert.deepEqual(backing, expected, `destination alias ordering ${leftOffset}/${rightOffset}`);
  assert.equal(paddedL[0], 0.75);
  assert.equal(paddedR[frames + 3], -0.75);
}
// Reading shared typed-array subviews must also preserve their byte offsets.
const sharedInput = new SharedArrayBuffer((frames * 2 + 4) * 4);
const sharedL = new Float32Array(sharedInput, 4, frames);
const sharedR = new Float32Array(sharedInput, (frames + 3) * 4, frames);
sharedL.set(sourceL); sharedR.set(sourceR);
const sharedOutL = new Float32Array(frames), sharedOutR = new Float32Array(frames);
assert.equal(globalThis.aurialisDSPReset(), true);
assert.equal(globalThis.aurialisDSPProcessBlock(sharedL, sharedR, sharedOutL, sharedOutR), frames);
assert.deepEqual(sharedOutL, expectedL);
assert.deepEqual(sharedOutR, expectedR);
// Offline callers on a non-isolated page need no shared-buffer constructor.
const sharedConstructor = globalThis.SharedArrayBuffer;
try {
  globalThis.SharedArrayBuffer = undefined;
  assert.equal(globalThis.aurialisDSPReset(), true);
  assert.equal(globalThis.aurialisDSPProcessBlock(sourceL, sourceR, sharedOutL, sharedOutR), frames);
  assert.deepEqual(sharedOutL, expectedL);
  assert.deepEqual(sharedOutR, expectedR);
} finally {
  globalThis.SharedArrayBuffer = sharedConstructor;
}
// Cloned shared-buffer wrappers have different JS identities but may address
// the same memory. They must retain the same overlapping-destination contract.
for (const [leftOffset, rightOffset] of [[1, 2], [2, 1]]) {
  const shared = new SharedArrayBuffer((frames + 4) * 4);
  const cloned = structuredClone(shared);
  assert.notEqual(shared, cloned);
  const backing = new Float32Array(shared).fill(0.3125);
  const expected = Float32Array.from(backing);
  for (let i = 0; i < frames; i++) {
    expected[leftOffset + i] = expectedL[i];
    expected[rightOffset + i] = expectedR[i];
  }
  assert.equal(globalThis.aurialisDSPReset(), true);
  assert.equal(globalThis.aurialisDSPProcessBlock(sourceL, sourceR,
    new Float32Array(shared, leftOffset * 4, frames), new Float32Array(cloned, rightOffset * 4, frames)), frames);
  assert.deepEqual(backing, expected, `cloned shared-buffer ordering ${leftOffset}/${rightOffset}`);
}
// Crossed in-place destinations still consume both entire inputs first.
const crossedL = sourceL.slice(), crossedR = sourceR.slice();
assert.equal(globalThis.aurialisDSPReset(), true);
assert.equal(globalThis.aurialisDSPProcessBlock(crossedL, crossedR, crossedR, crossedL), frames);
assert.deepEqual(crossedR, expectedL);
assert.deepEqual(crossedL, expectedR);
for (const [left, right] of [[Float32Array.of(NaN), Float32Array.of(0)],
  [Float32Array.of(0), Float32Array.of(Infinity)], [Float32Array.of(-Infinity), Float32Array.of(0)]]) {
  const untouchedL = Float32Array.of(0.25), untouchedR = Float32Array.of(-0.25);
  assert.equal(globalThis.aurialisDSPProcessBlock(left, right, untouchedL, untouchedR), 0);
  assert.equal(untouchedL[0], 0.25);
  assert.equal(untouchedR[0], -0.25);
}
const maximumInput = new Float32Array(65536).fill(0.0625);
const maximumL = new Float32Array(65537).fill(0.5);
const maximumR = new Float32Array(65537).fill(-0.5);
assert.equal(globalThis.aurialisDSPReset(), true);
assert.equal(globalThis.aurialisDSPProcessBlock(maximumInput, maximumInput, maximumL, maximumR), 65536);
assert.equal(maximumL[0], 0.0625);
assert.equal(maximumL[65535], 0.0625);
assert.equal(maximumL[65536], 0.5);
assert.equal(maximumR[65536], -0.5);
const rates = [...new Set(fixtures.map(fixture => fixture.rate))].toSorted((a, b) => a - b).map(rate => rate / 1000).join("/");
console.log(`wasm-bridge: ${fixtures.length} native/WASM fixtures passed at ${rates} kHz; max absolute error ${maximumError}; adversarial boundary checks passed`);
process.exit(0);
