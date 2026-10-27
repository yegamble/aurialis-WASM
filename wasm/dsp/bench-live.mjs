// Measure the compiled WASI reactor's live quantum cost in V8 (the engine
// Chromium runs AudioWorklets on), through the real restricted browser host.
// Usage: node wasm/dsp/bench-live.mjs public/wasm/aurialis-realtime.wasm [seconds]
// Load = mean (or p99/max) processing time / the quantum's real-time duration.
import { readFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";
import assert from "node:assert/strict";
import { createAurialisWasiHost } from "../../public/worklets/aurialis-wasi-host.js";
import { packLiveControls } from "../../src/lib/live-controls.ts";

const [modulePath, secondsArgument = "20"] = process.argv.slice(2);
assert.ok(modulePath, "supply aurialis-realtime.wasm");
const seconds = Number(secondsArgument);
const module = await WebAssembly.compile(await readFile(modulePath));

// Every module the UI can enable together (see heaviestLiveParams in
// live_budget_test.go). Repair is excluded: the UI cannot enable it.
function heaviest(character, algorithmVersion) {
  return {
    bypass: false, abOriginal: false, inputGainDb: 6, eqEnabled: true,
    bands: [[60, 0.707, "low_shelf"], [250, 1, "peaking"], [1000, 1, "peaking"], [4000, 1.2, "peaking"], [12000, 0.707, "high_shelf"]]
      .map(([freqHz, q, type]) => ({ freqHz, gainDb: 2, q, type, enabled: true })),
    compressor: { enabled: true, thresholdDb: -20, ratio: 3, attackMs: 18, releaseMs: 140, kneeDb: 3, makeupDb: 0, sidechainHpfHz: 90, autoRelease: true, topology: "optical" },
    saturation: { enabled: true, amount: 60, character },
    stereo: { enabled: true, widthPct: 130, monoBass: true, crossoverHz: 110, midGainDb: 1, sideGainDb: -1 },
    limiter: { enabled: true, ceilingDbtp: -1, targetLufs: -9, releaseMs: 80, truePeak: algorithmVersion === 2 },
    repair: { enabled: false, deEssDb: 0, transientDb: 0, deClip: false },
    deHarsh: { enabled: true, frequencyHz: 5000, thresholdDb: -30, rangeDb: 6 },
    multiband: { enabled: true, lowMidHz: 200, midHighHz: 3000, bands: [0, 1, 2].map(() => ({ thresholdDb: -24, ratio: 3, attackMs: 10, releaseMs: 120, makeupDb: 1 })) },
    ditherBits: 0, algorithmVersion,
  };
}

async function measure(rate, algorithm, character) {
  const host = createAurialisWasiHost({ entropy: webcrypto.getRandomValues(new Uint8Array(256)), now: () => performance.now() + 1 });
  const wasm = (await WebAssembly.instantiate(module, host.imports)).exports;
  host.attach(wasm.memory);
  wasm._initialize();
  assert.equal(wasm.aurialis_init(rate), 1);
  assert.equal(wasm.aurialis_algorithm_supported(algorithm), 1, `reactor does not support algorithm ${algorithm}`);
  const controls = new Float64Array(wasm.memory.buffer, wasm.aurialis_control_buffer_v2() >>> 0, 82);
  controls.set(packLiveControls({ ...heaviest(character, algorithm), algorithmVersion: 1 }, 2));
  controls[81] = algorithm;
  assert.equal(wasm.aurialis_set_controls_v2(82), 1);
  host.beginRender();
  const channels = () => [0, 1].map(channel => new Float32Array(wasm.memory.buffer, wasm.aurialis_live_buffer(channel) >>> 0, 128));
  // A dense, clipping-prone program: decaying kick, noise hats and bass.
  let seed = 0x9e3779b9, phase = 0;
  const noise = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 2147483648 - 1; };
  const blocks = Math.ceil(seconds * rate / 128), timings = new Float64Array(blocks);
  for (let block = -2000; block < blocks; block++) {
    const [left, right] = channels();
    for (let i = 0; i < 128; i++) {
      const frame = (block + 2000) * 128 + i, inBeat = frame % (rate / 2);
      phase += 2 * Math.PI * (48 + 110 * Math.exp(-inBeat / 480)) / rate;
      const body = 0.6 * Math.sin(phase) * Math.exp(-inBeat / 7200) + 0.3 * Math.sin(2 * Math.PI * 55 * frame / rate);
      left[i] = body + 0.2 * noise();
      right[i] = body + 0.2 * noise();
    }
    const start = performance.now();
    assert.equal(wasm.aurialis_live_process(), 128);
    if (block % Math.round(rate * 0.05 / 128) === 0) assert.equal(wasm.aurialis_meter_snapshot(), 7);
    const elapsed = performance.now() - start;
    if (block >= 0) timings[block] = elapsed;
  }
  timings.sort();
  const quantumMs = 128 / rate * 1000, mean = timings.reduce((sum, value) => sum + value, 0) / blocks;
  return { rate, algorithm, character, latency: wasm.aurialis_latency_frames(), meanUs: mean * 1000, p99Us: timings[Math.floor(blocks * 0.99)] * 1000,
    maxUs: timings[blocks - 1] * 1000, meanLoad: mean / quantumMs, p99Load: timings[Math.floor(blocks * 0.99)] / quantumMs };
}

const rows = [];
for (const rate of [44100, 48000, 96000])
  for (const algorithm of [1, 2])
    for (const character of ["Warm", "Tube", "Transformer"]) rows.push(await measure(rate, algorithm, character));
console.log(`${process.version} ${seconds}s of audio per row, 128-frame quanta, heaviest live chain`);
console.log("rate  alg saturation  latency  mean µs  p99 µs   max µs  mean load  p99 load");
for (const r of rows)
  console.log(`${String(r.rate).padEnd(5)} ${r.algorithm}   ${r.character.padEnd(11)} ${String(r.latency).padStart(7)} ${r.meanUs.toFixed(1).padStart(8)} ${r.p99Us.toFixed(1).padStart(7)} ${r.maxUs.toFixed(1).padStart(8)} ${r.meanLoad.toFixed(3).padStart(10)} ${r.p99Load.toFixed(3).padStart(9)}`);
