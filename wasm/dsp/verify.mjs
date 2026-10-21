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
      const errorL = Math.abs(outL[offset] - fixture.outputLeft[start + offset]);
      const errorR = Math.abs(outR[offset] - fixture.outputRight[start + offset]);
      maximumError = Math.max(maximumError, errorL, errorR);
      assert.ok(errorL <= 2e-6 && errorR <= 2e-6, `native/WASM mismatch at ${fixture.rate} Hz frame ${start + offset}`);
    }
  }
}
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
console.log(`wasm-bridge: ${fixtures.length} native/WASM fixtures passed at 44.1/48/96 kHz; max absolute error ${maximumError}; adversarial boundary checks passed`);
process.exit(0);
