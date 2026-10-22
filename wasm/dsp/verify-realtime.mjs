// Verify the compiled WASI reactor through its real restricted browser host.
// cspell:words sched oneoff fdstat prestat
import { readFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";
import assert from "node:assert/strict";
import { createAurialisWasiHost } from "../../public/worklets/aurialis-wasi-host.js";
import { packLiveControls } from "../../src/lib/live-controls.ts";

const [modulePath, ...fixturePaths] = process.argv.slice(2);
assert.ok(modulePath && fixturePaths.length, "supply reactor.wasm and native fixture files");
const module = await WebAssembly.compile(await readFile(modulePath));
const allowedImports = new Set([
  "sched_yield", "proc_exit", "args_get", "args_sizes_get", "clock_time_get",
  "environ_get", "environ_sizes_get", "fd_write", "random_get", "poll_oneoff",
  "fd_close", "fd_read", "fd_fdstat_get", "fd_fdstat_set_flags", "fd_prestat_get", "fd_prestat_dir_name",
]);
for (const entry of WebAssembly.Module.imports(module)) {
  assert.equal(entry.module, "wasi_snapshot_preview1", "reactor unexpectedly requires a JS Go runtime");
  assert.equal(entry.kind, "function");
  assert.ok(allowedImports.has(entry.name), `unexpected WASI capability ${entry.name}`);
}
const requiredExports = new Set([
  "_initialize", "memory", "aurialis_init", "aurialis_live_buffer", "aurialis_live_process",
  "aurialis_live_reset", "aurialis_control_buffer", "aurialis_set_controls",
]);
for (const entry of WebAssembly.Module.exports(module)) {
  assert.ok(requiredExports.delete(entry.name), `unexpected or repeated reactor export ${entry.name}`);
}
assert.equal(requiredExports.size, 0, "reactor is missing required exports");
function compare(actual, expected, message) {
  assert.equal(actual, expected === 0 ? 0 : Math.fround(expected), message);
}
async function createKernel(fixture) {
  const host = createAurialisWasiHost({ entropy: webcrypto.getRandomValues(new Uint8Array(256)),
    now: () => performance.now() + 1 });
  const instance = await WebAssembly.instantiate(module, host.imports);
  const wasm = instance.exports;
  assert.ok(wasm.memory instanceof WebAssembly.Memory);
  host.attach(wasm.memory);
  wasm._initialize();
  assert.equal(wasm.aurialis_init(fixture.rate), 1);
  const pointers = [0, 1, 2, 3].map(channel => wasm.aurialis_live_buffer(channel) >>> 0);
  const controlPointer = wasm.aurialis_control_buffer() >>> 0;
  for (const [index, pointer] of [...pointers, controlPointer].entries()) {
    const length = index === 4 ? 81 * 8 : 128 * 4;
    assert.ok(pointer > 0 && pointer % (index === 4 ? 8 : 4) === 0);
    assert.ok(pointer + length <= wasm.memory.buffer.byteLength);
    for (let previous = 0; previous < index; previous++) {
      const previousPointer = pointers[previous];
      assert.ok(pointer + length <= previousPointer || previousPointer + 128 * 4 <= pointer, "reactor buffers overlap");
    }
  }
  for (const invalid of [4, 128, 0xffffffff, -1]) assert.equal(wasm.aurialis_live_buffer(invalid), 0);
  let buffer, channels, controls;
  function refresh() {
    if (buffer !== wasm.memory.buffer) {
      buffer = wasm.memory.buffer;
      channels = pointers.map(pointer => new Float32Array(buffer, pointer, 128));
      controls = new Float64Array(buffer, controlPointer, 81);
    }
  }
  refresh();
  controls.set(packLiveControls(fixture.params));
  assert.equal(wasm.aurialis_set_controls(), 1);
  assert.equal(wasm.aurialis_live_reset(), 1);
  refresh();
  host.beginRender();
  return {
    wasm, host,
    render(left, right) {
      assert.equal(left.length, 128); assert.equal(right.length, 128);
      refresh(); channels[0].set(left); channels[1].set(right);
      assert.equal(wasm.aurialis_live_process(), 128);
      refresh(); return channels;
    },
    channels() { refresh(); return channels; },
    controls() { refresh(); return controls; },
  };
}
const kernels = new Map();
async function configuredKernel(fixture) {
  let kernel = kernels.get(fixture.rate);
  if (!kernel) {
    kernel = await createKernel(fixture);
    kernels.set(fixture.rate, kernel);
  }
  // A cached sample-rate instance never reinitializes the Go runtime/engine.
  // Valid fixed controls and reset must make no host call after beginRender.
  kernel.controls().set(packLiveControls(fixture.params));
  assert.equal(kernel.wasm.aurialis_set_controls(), 1);
  assert.equal(kernel.wasm.aurialis_live_reset(), 1);
  return kernel;
}
const fixtures = [];
for (const path of fixturePaths) fixtures.push(...JSON.parse(await readFile(path, "utf8")));
for (const [index, fixture] of fixtures.entries()) {
  const kernel = await configuredKernel(fixture);
  const left = Float32Array.from(fixture.left), right = Float32Array.from(fixture.right);
  for (let start = 0; start < left.length; start += 128) {
    const output = kernel.render(left.subarray(start, start + 128), right.subarray(start, start + 128));
    for (let frame = 0; frame < 128; frame++) {
      compare(output[2][frame], fixture.outputLeft[start + frame], `left fixture${index} frame${start + frame}`);
      compare(output[3][frame], fixture.outputRight[start + frame], `right fixture${index} frame${start + frame}`);
    }
  }
  assert.equal(kernel.wasm.aurialis_live_reset(), 1);
  const output = kernel.render(left.subarray(0, 128), right.subarray(0, 128));
  for (let frame = 0; frame < 128; frame++) {
    compare(output[2][frame], fixture.outputLeft[frame], "reset changed left settings or history");
    compare(output[3][frame], fixture.outputRight[frame], "reset changed right settings or history");
  }
}
// Exercise control transitions on the real reactor without resetting between
// edits. Constant-setting parity alone cannot expose frozen model-local audio.
const neutral = fixtures.find(f => f.rate === 48000 && !f.params.bypass
  && f.params.inputGainDb === 0 && f.params.saturation.amount === 0
  && f.params.compressor.ratio === 1 && !f.params.limiter.enabled
  && f.params.bands.every(band => band.gainDb === 0));
assert.ok(neutral);
for (const rate of [8000, 48000, 192000]) {
  for (const character of ["Crisp", "Tape", "Transformer"]) {
    const params = { ...structuredClone(neutral.params), inputGainDb: 0.0001,
      saturation: { enabled: true, amount: 100, character } };
    const modelKernel = await configuredKernel({ rate, params });
    const inputL = new Float32Array(128), inputR = new Float32Array(128);
    for (let block = 0; block < 200; block++) {
      for (let frame = 0; frame < 128; frame++) {
        inputL[frame] = 0.4 * Math.cos(2 * Math.PI * 100 * (block * 128 + frame) / rate);
        inputR[frame] = -inputL[frame];
      }
      modelKernel.render(inputL, inputR);
    }
    modelKernel.controls().set(packLiveControls({ ...params,
      saturation: { ...params.saturation, character: "Thick" } }));
    assert.equal(modelKernel.wasm.aurialis_set_controls(), 1);
    inputL.fill(0); inputR.fill(0);
    for (let block = 0; block < 400; block++) modelKernel.render(inputL, inputR);
    modelKernel.controls().set(packLiveControls(params));
    assert.equal(modelKernel.wasm.aurialis_set_controls(), 1);
    for (let block = 0; block < 10; block++) {
      const output = modelKernel.render(inputL, inputR);
      for (const channel of [2, 3]) for (const sample of output[channel])
        assert.ok(Number.isFinite(sample) && Math.abs(sample) < 1e-8,
          `${character} replayed old model audio at ${rate} Hz: ${sample}`);
    }
  }
}
console.log("wasm-realtime: 9 model-history transitions passed through numeric controls without reset");
const active = fixtures.find(f => f.rate === 48000 && f.params.saturation.character === "Crisp");
assert.ok(active);
const kernel = await configuredKernel(active);
const left = Float32Array.from(active.left), right = Float32Array.from(active.right);
kernel.render(left.subarray(0, 128), right.subarray(0, 128));
for (const invalid of [0, 7999, 192001, NaN, Infinity, -Infinity])
  assert.equal(kernel.wasm.aurialis_init(invalid), 0, "invalid initialization was accepted");
const current = kernel.controls().slice();
for (let index = 0; index < current.length; index++) {
  for (const invalid of [NaN, Infinity, -Infinity]) {
    kernel.controls().set(current); kernel.controls()[index] = invalid;
    assert.equal(kernel.wasm.aurialis_set_controls(), 0, "nonfinite controls were accepted");
  }
}
kernel.controls().set(current);
for (const invalid of [NaN, Infinity, -Infinity]) {
  for (const channel of [0, 1]) {
    const before = kernel.channels().map(c => c.slice());
    kernel.channels()[channel][127] = invalid;
    assert.equal(kernel.wasm.aurialis_live_process(), 0);
    assert.deepEqual(kernel.channels()[2], before[2]); assert.deepEqual(kernel.channels()[3], before[3]);
    assert.equal(Object.is(kernel.channels()[channel][127], invalid), true);
    kernel.channels()[channel][127] = channel === 0 ? left[127] : right[127];
  }
}
const afterRejection = kernel.render(left.subarray(128, 256), right.subarray(128, 256));
for (let frame = 0; frame < 128; frame++) {
  compare(afterRejection[2][frame], active.outputLeft[128 + frame], "invalid controls/input advanced left history");
  compare(afterRejection[3][frame], active.outputRight[128 + frame], "invalid controls/input advanced right history");
}
assert.equal(kernel.wasm.aurialis_live_reset(), 1);
const detached = kernel.channels()[0];
kernel.wasm.memory.grow(1);
assert.equal(detached.byteLength, 0);
const afterGrowth = kernel.render(left.subarray(0, 128), right.subarray(0, 128));
for (let frame = 0; frame < 128; frame++) {
  compare(afterGrowth[2][frame], active.outputLeft[frame], "memory-view refresh changed left output");
  compare(afterGrowth[3][frame], active.outputRight[frame], "memory-view refresh changed right output");
}
kernel.controls().set(packLiveControls({ ...active.params, bypass: true, ditherBits: 0 }));
assert.equal(kernel.wasm.aurialis_set_controls(), 1);
assert.equal(kernel.wasm.aurialis_live_reset(), 1);
const zero = new Float32Array(128).fill(-0);
const zeroOutput = kernel.render(zero, zero);
for (const channel of [2, 3]) for (const sample of zeroOutput[channel]) assert.equal(Object.is(sample, -0), false);
assert.equal(Object.is(kernel.channels()[0][0], -0), true, "processing changed input zero sign");
console.log(`wasm-realtime: ${fixtures.length} native fixtures matched exactly through restricted host; fixed numeric controls, invalid input atomicity, reset and memory growth passed`);
