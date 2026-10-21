/* Shared Go DSP runs here, away from the audio render thread. */
"use strict";
const QUANTUM = 128;
const SLOTS = 256;
const FRAMES = QUANTUM * SLOTS;
const WRITE = 0, READ = 1, GENERATION = 2, ERROR = 5, WAKE = 7;
let header, tags, samples, inputPort, activeGeneration = 0, version = 0, pumping = false, stopped = false;
const left = new Float32Array(QUANTUM), right = new Float32Array(QUANTUM);
const outLeft = new Float32Array(QUANTUM), outRight = new Float32Array(QUANTUM);
function fail(message) {
  stopped = true;
  if (header) Atomics.store(header, ERROR, 1);
  self.postMessage({ type: "error", message });
}
// Exercise the actual configured Go chain before the audio graph can consume
// its first block. This bounded worker-only warmup absorbs cold WASM/JIT work;
// reset() below removes its filter/envelope history before any source plays.
function warmUp(sampleRate) {
  for (let i = 0; i < QUANTUM; i++) {
    left[i] = 0.05 * Math.sin(2 * Math.PI * 1000 * i / sampleRate);
    right[i] = 0.04 * Math.sin(2 * Math.PI * 1000 * i / sampleRate + 0.3);
  }
  for (let block = 0; block < 256; block++) {
    if (self.aurialisDSPProcessBlock(left, right, outLeft, outRight) !== QUANTUM)
      throw new Error("The live audio engine could not warm up.");
  }
  left.fill(0); right.fill(0); outLeft.fill(0); outRight.fill(0);
}
function reset(requestedGeneration = Atomics.load(header, GENERATION)) {
  const generation = Atomics.load(header, GENERATION);
  if (requestedGeneration !== generation || activeGeneration === generation) return;
  activeGeneration = generation;
  if (!self.aurialisDSPReset()) throw new Error("The live audio engine could not reset.");
  Atomics.store(header, READ, 0);
}
function pump() {
  if (stopped || pumping || !header) return;
  pumping = true;
  try {
    if (activeGeneration !== Atomics.load(header, GENERATION)) reset();
    let read = Atomics.load(header, READ);
    for (let count = 0; count < 64; count++) {
      const written = Atomics.load(header, WRITE);
      if (written <= read) break;
      if (written - read > SLOTS) throw new Error("The live audio worker fell behind its bounded buffer.");
      const sequence = read + 1, slot = (sequence - 1) % SLOTS, offset = slot * QUANTUM;
      if (Atomics.load(tags, slot) !== sequence || Atomics.load(tags, SLOTS + slot) !== activeGeneration) break;
      for (let i = 0; i < QUANTUM; i++) {
        left[i] = samples[offset + i];
        right[i] = samples[FRAMES + offset + i];
      }
      if (self.aurialisDSPProcessBlock(left, right, outLeft, outRight) !== QUANTUM)
        throw new Error("The live audio engine rejected an audio block.");
      if (activeGeneration !== Atomics.load(header, GENERATION)) break;
      for (let i = 0; i < QUANTUM; i++) {
        samples[2 * FRAMES + offset + i] = outLeft[i];
        samples[3 * FRAMES + offset + i] = outRight[i];
      }
      Atomics.store(tags, 4 * SLOTS + slot, version);
      Atomics.store(tags, 3 * SLOTS + slot, activeGeneration);
      Atomics.store(tags, 2 * SLOTS + slot, sequence);
      read = sequence;
      Atomics.store(header, READ, read);
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : "Live audio processing failed.");
  } finally {
    pumping = false;
    if (header) Atomics.store(header, WAKE, 0);
  }
  // Input normally wakes us over a direct worklet/worker MessagePort. A bounded
  // backlog yields to parameter/reset messages before continuing.
  if (!stopped && Atomics.load(header, WRITE) > Atomics.load(header, READ))
    setTimeout(pump, 0);
}
self.onmessage = async (event) => {
  const message = event.data;
  try {
    if (message.type === "init") {
      header = new Int32Array(message.header);
      tags = new Int32Array(message.tags);
      samples = new Float32Array(message.samples);
      inputPort = message.port;
      importScripts("/wasm/wasm_exec.js");
      const runtime = new self.Go();
      const response = await fetch("/wasm/aurialis-dsp.wasm");
      if (!response.ok) throw new Error("The shared audio engine could not be loaded.");
      const result = await WebAssembly.instantiate(await response.arrayBuffer(), runtime.importObject);
      void runtime.run(result.instance).catch((error) => fail(String(error)));
      if (!self.aurialisDSPReady || !self.aurialisDSPInit(message.sampleRate)
        || !self.aurialisDSPSetParams(message.params))
        throw new Error("The live audio engine could not initialize these settings.");
      version = message.version;
      warmUp(message.sampleRate);
      reset();
      inputPort.onmessage = pump;
      inputPort.start();
      self.postMessage({ type: "ready" });
    } else if (message.type === "params") {
      if (!self.aurialisDSPSetParams(message.params))
        throw new Error("The live audio engine rejected these settings.");
      version = message.version;
    } else if (message.type === "reset" && header) {
      reset(message.generation);
    } else if (message.type === "dispose") {
      stopped = true;
      inputPort?.close();
      self.close();
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : "Live audio initialization failed.");
  }
};
