// Verify real wasmexport functions against the supplied native fixture files.
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { webcrypto } from "node:crypto";
import assert from "node:assert/strict";
import { packLiveControls } from "../../src/lib/live-controls.ts";

const [modulePath, runtimePath, ...fixturePaths] = process.argv.slice(2);
assert.ok(modulePath && runtimePath && fixturePaths.length, "supply module.wasm wasm_exec.js fixture files");
globalThis.crypto ??= webcrypto;
await import(pathToFileURL(runtimePath).href);
const go = new globalThis.Go();
const { instance } = await WebAssembly.instantiate(await readFile(modulePath), go.importObject);
const wasm = instance.exports;
assert.ok(wasm.mem instanceof WebAssembly.Memory);
for (const name of ["aurialis_live_buffer", "aurialis_live_process", "aurialis_live_reset"])
  assert.equal(typeof wasm[name], "function", `missing direct export ${name}`);
assert.equal(wasm.aurialis_live_buffer.length, 1);
assert.equal(wasm.aurialis_live_process.length, 0);
assert.equal(wasm.aurialis_live_reset.length, 0);
void go.run(instance);
assert.equal(globalThis.aurialisDSPReady, true);
assert.equal(wasm.aurialis_control_count(1), 81);
assert.equal(wasm.aurialis_control_count(2), 82);
assert.equal(wasm.aurialis_control_count(3), 0);
assert.equal(wasm.aurialis_algorithm_supported(1), 1);
assert.equal(wasm.aurialis_algorithm_supported(2), 1);
assert.equal(wasm.aurialis_latency_frames(), 0);
assert.equal(typeof wasm.aurialis_live_drain, "undefined", "aurialis_live_drain is retired");
assert.equal(wasm.aurialis_live_end_input(129), 0);
const pointers = [0, 1, 2, 3].map(channel => wasm.aurialis_live_buffer(channel) >>> 0);
for (let channel = 0; channel < 4; channel++) {
  const pointer = pointers[channel];
  assert.ok(pointer > 0 && pointer % 4 === 0 && pointer + 512 <= wasm.mem.buffer.byteLength);
  for (let previous = 0; previous < channel; previous++)
    assert.ok(pointer + 512 <= pointers[previous] || pointers[previous] + 512 <= pointer, "live buffers overlap");
}
for (const invalid of [4, 128, 0xffffffff, -1]) assert.equal(wasm.aurialis_live_buffer(invalid), 0);
let memory, views;
function refresh() {
  if (memory !== wasm.mem.buffer) {
    memory = wasm.mem.buffer;
    views = pointers.map(pointer => new Float32Array(memory, pointer, 128));
  }
  return views;
}
function init(rate, params) {
  assert.equal(globalThis.aurialisDSPInit(rate), true);
  assert.equal(globalThis.aurialisDSPSetParams(JSON.stringify(params)), true);
  assert.equal(wasm.aurialis_live_reset(), 1);
  refresh();
}
function renderDirect(left, right) {
  assert.equal(left.length, 128); assert.equal(right.length, 128);
  const input = refresh();
  input[0].set(left); input[1].set(right);
  assert.equal(wasm.aurialis_live_process(), 128);
  return refresh();
}
function compare(actual, expected, message) {
  assert.equal(actual, expected === 0 ? 0 : Math.fround(expected), message);
}
const fixtures = [];
for (const path of fixturePaths) fixtures.push(...JSON.parse(await readFile(path, "utf8")));
for (const [index, fixture] of fixtures.entries()) {
  init(fixture.rate, fixture.params);
  const left = Float32Array.from(fixture.left), right = Float32Array.from(fixture.right);
  for (let start = 0; start < left.length; start += 128) {
    const output = renderDirect(left.subarray(start, start + 128), right.subarray(start, start + 128));
    for (let frame = 0; frame < 128; frame++) {
      compare(output[2][frame], fixture.outputLeft[start + frame], `left fixture${index} frame${start + frame}`);
      compare(output[3][frame], fixture.outputRight[start + frame], `right fixture${index} frame${start + frame}`);
    }
  }
  assert.equal(globalThis.aurialisDSPReset(), true);
  const output = renderDirect(left.subarray(0, 128), right.subarray(0, 128));
  for (let frame = 0; frame < 128; frame++) {
    compare(output[2][frame], fixture.outputLeft[frame], "JS reset did not reset direct history");
    compare(output[3][frame], fixture.outputRight[frame], "JS reset did not reset direct history");
  }
}
const active = fixtures.find(fixture => fixture.rate === 48000 && fixture.params.saturation.character === "Crisp");
assert.ok(active);
const left = Float32Array.from(active.left), right = Float32Array.from(active.right);
const outL = new Float32Array(128), outR = new Float32Array(128);
// Alternating APIs must continue exactly the same DSP state and settings.
init(active.rate, active.params);
for (let start = 0; start < left.length; start += 128) {
  let output;
  if (start % 256 === 0) output = renderDirect(left.subarray(start, start + 128), right.subarray(start, start + 128)).slice(2);
  else {
    assert.equal(globalThis.aurialisDSPProcessBlock(left.subarray(start, start + 128), right.subarray(start, start + 128), outL, outR), 128);
    output = [outL, outR];
  }
  for (let frame = 0; frame < 128; frame++) {
    compare(output[0][frame], active.outputLeft[start + frame], "cross-API left history diverged");
    compare(output[1][frame], active.outputRight[start + frame], "cross-API right history diverged");
  }
}
init(active.rate, active.params);
renderDirect(left.subarray(0, 128), right.subarray(0, 128));
for (const invalid of [NaN, Infinity, -Infinity]) {
  for (const channel of [0, 1]) {
    const current = refresh();
    const beforeL = current[2].slice(), beforeR = current[3].slice();
    current[channel][127] = invalid;
    assert.equal(wasm.aurialis_live_process(), 0);
    const after = refresh();
    assert.deepEqual(after[2], beforeL); assert.deepEqual(after[3], beforeR);
    assert.equal(Object.is(after[channel][127], invalid), true, "rejection changed input");
    after[channel][127] = channel === 0 ? left[127] : right[127];
  }
}
const afterInvalid = renderDirect(left.subarray(128, 256), right.subarray(128, 256));
for (let frame = 0; frame < 128; frame++) {
  compare(afterInvalid[2][frame], active.outputLeft[128 + frame], "invalid block advanced left DSP history");
  compare(afterInvalid[3][frame], active.outputRight[128 + frame], "invalid block advanced right DSP history");
}
assert.equal(globalThis.aurialisDSPInit(48000), true);
assert.equal(wasm.aurialis_live_reset(), 1);
const zeroInput = new Float32Array(128).fill(-0), zeros = renderDirect(zeroInput, zeroInput);
for (const channel of [2, 3]) for (const sample of zeros[channel]) assert.equal(Object.is(sample, -0), false);
assert.equal(Object.is(zeros[0][0], -0), true, "processing mutated source zero sign");
// Deterministic, bounded host-forced growth checks the memory-view contract.
// Refresh wasm_exec's own DataView exactly as its Go growth import does; this
// is test setup, not a claim that Go GC itself grew memory during this run.
const previousView = refresh()[0];
wasm.mem.grow(1);
go.importObject.gojs["runtime.resetMemoryDataView"]();
assert.notEqual(previousView.buffer, wasm.mem.buffer);
assert.equal(previousView.byteLength, 0);
for (let channel = 0; channel < 4; channel++) assert.equal(wasm.aurialis_live_buffer(channel) >>> 0, pointers[channel]);
const afterGrowth = renderDirect(new Float32Array(128).fill(.125), new Float32Array(128).fill(-.25));
assert.equal(afterGrowth[2][127], .125); assert.equal(afterGrowth[3][127], -.25);
// Exercise the appended packet through the JS module's direct exports as well.
for (const [index, fixture] of fixtures.entries()) {
  init(fixture.rate, fixture.params);
  const versioned = new Float64Array(wasm.mem.buffer, wasm.aurialis_control_buffer_v2() >>> 0, 82);
  versioned.set(packLiveControls(fixture.params, 2));
  assert.equal(wasm.aurialis_set_controls_v2(82), 1);
  const inputLeft = Float32Array.from(fixture.left), inputRight = Float32Array.from(fixture.right);
  for (let start = 0; start < inputLeft.length; start += 128) {
    const output = renderDirect(inputLeft.subarray(start, start + 128), inputRight.subarray(start, start + 128));
    for (let frame = 0; frame < 128; frame++) {
      compare(output[2][frame], fixture.outputLeft[start + frame], `JS ABI2 left fixture${index} frame${start + frame}`);
      compare(output[3][frame], fixture.outputRight[start + frame], `JS ABI2 right fixture${index} frame${start + frame}`);
    }
  }
  // Algorithm 1 buffers nothing: after the source's end the block is silent.
  assert.equal(wasm.aurialis_live_end_input(0), 1);
  const ended = renderDirect(inputLeft.subarray(0, 128), inputRight.subarray(0, 128));
  assert.ok(ended[2].every(sample => sample === 0) && ended[3].every(sample => sample === 0), "audio after the source's end");
  assert.equal(wasm.aurialis_live_reset(), 1);
}
console.log(`wasm-live-direct: ${fixtures.length} native fixtures matched exactly; JSON and ABI2/algorithm1 paths matched; fixed pointers, validation, zero sign, source end, shared controls/state/reset and one-page memory growth passed`);
process.exit(0);
