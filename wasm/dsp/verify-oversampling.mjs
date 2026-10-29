// Real WASI algorithm-3 parity; the timing is Node evidence, not a worklet gate.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";
import { createAurialisWasiHost } from "../../public/worklets/aurialis-wasi-host.js";
import { packLiveControls } from "../../src/lib/live-controls.ts";
const [modulePath, fixturePath] = process.argv.slice(2);
const module = await WebAssembly.compile(await readFile(modulePath));
const fixtures = JSON.parse(await readFile(fixturePath, "utf8"));
const kernels = new Map();
for (const [index, fixture] of fixtures.entries()) {
  let kernel = kernels.get(fixture.rate);
  if (!kernel) {
    const host = createAurialisWasiHost({ entropy: webcrypto.getRandomValues(new Uint8Array(256)), now: () => performance.now() + 1 });
    const { exports: wasm } = await WebAssembly.instantiate(module, host.imports);
    host.attach(wasm.memory); wasm._initialize();
    assert.equal(wasm.aurialis_init(fixture.rate), 1);
    assert.equal(wasm.aurialis_algorithm_supported(3), 1);
    assert.equal(wasm.aurialis_control_count(2), 82);
    const pointers = [0, 1, 2, 3].map(i => wasm.aurialis_live_buffer(i) >>> 0);
    const controls = wasm.aurialis_control_buffer_v2() >>> 0;
    kernel = { wasm, pointers, controls, host };
    kernels.set(fixture.rate, kernel);
  }
  const { wasm, pointers, controls, host } = kernel;
  new Float64Array(wasm.memory.buffer, controls, 82).set(packLiveControls(fixture.params, 2));
  assert.equal(wasm.aurialis_set_controls_v2(82), 1);
  assert.equal(wasm.aurialis_live_reset(), 1);
  assert.equal(wasm.aurialis_latency_frames(), fixture.latency);
  host.beginRender();
  function render(left, right) {
    new Float32Array(wasm.memory.buffer, pointers[0], 128).set(left);
    new Float32Array(wasm.memory.buffer, pointers[1], 128).set(right);
    assert.equal(wasm.aurialis_live_process(), 128);
    return [2, 3].map(ch => new Float32Array(wasm.memory.buffer, pointers[ch], 128));
  }
  for (let start = 0; start < fixture.left.length; start += 128) {
    const got = render(fixture.left.slice(start, start + 128), fixture.right.slice(start, start + 128));
    for (let n = 0; n < 128; n++) {
      assert.equal(got[0][n], Math.fround(fixture.outputLeft[start + n]) || 0, `fixture ${index} left ${start+n}`);
      assert.equal(got[1][n], Math.fround(fixture.outputRight[start + n]) || 0, `fixture ${index} right ${start+n}`);
    }
  }
  assert.equal(wasm.aurialis_live_end_input(0), 1);
  render(new Float32Array(128), new Float32Array(128));
  assert.equal(wasm.aurialis_live_tail_frames(), fixture.latency);
  for (const [ch, want] of [fixture.tailLeft, fixture.tailRight].entries()) {
    const got = new Float32Array(wasm.memory.buffer, wasm.aurialis_live_tail_buffer(ch) >>> 0, fixture.latency);
    for (let n = 0; n < want.length; n++) assert.equal(got[n], Math.fround(want[n]) || 0, `fixture ${index} tail channel ${ch} frame ${n}`);
  }
  assert.equal(wasm.aurialis_live_resume_input(), 1);
  assert.equal(wasm.aurialis_live_reset(), 1);
  const reset = render(fixture.left.slice(0, 128), fixture.right.slice(0, 128));
  for (let n = 0; n < 128; n++) assert.equal(reset[0][n], Math.fround(fixture.outputLeft[n]) || 0);
  if (fixture.rate === 48000 && fixture.params.saturation.character === "Tube") {
    const input = Float32Array.from(fixture.left.slice(0, 128));
    for (let n=0;n<100;n++) render(input,input);
    const start = performance.now();
    for (let n=0;n<2000;n++) render(input,input);
    const elapsed = performance.now()-start;
    console.log(JSON.stringify({ evidence:"wasm-bridge Node timing only", algorithm:3, rate:fixture.rate, meanMs:elapsed/2000, load:elapsed/2000/(128/fixture.rate*1000) }));
  }
}
console.log(`wasm-oversampling: ${fixtures.length} native fixtures and finite tails matched exactly; ABI remains 82 values`);
