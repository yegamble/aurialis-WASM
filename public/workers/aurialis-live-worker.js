/* Shared Go DSP runs here, away from the audio render thread. */
"use strict";
const QUANTUM = 128;
const SLOTS = 256;
const FRAMES = QUANTUM * SLOTS;
const BURST_MS = 20;
const BURST_BLOCKS = 64;
const WRITE = 0, READ = 1, GENERATION = 2, ERROR = 5, WAKE = 7;
let header, tags, samples, inputPort, activeGeneration = 0, version = 0, pumping = false, stopped = false;
let continuation;
let direct, memoryBuffer, left, right, outLeft, outRight;
function refreshLiveBuffers() {
  if (direct.memory.buffer === memoryBuffer) return;
  const pointers = [];
  for (let channel = 0; channel < 4; channel++) {
    const raw = direct.buffer(channel);
    if (!Number.isInteger(raw) || raw < -2147483648 || raw > 2147483647)
      throw new Error("The live audio engine returned an invalid buffer address.");
    pointers.push(raw >>> 0);
  }
  // A first call can grow Go's stack/memory too; read the buffer after getters.
  const buffer = direct.memory.buffer;
  const bytes = QUANTUM * Float32Array.BYTES_PER_ELEMENT;
  for (let channel = 0; channel < pointers.length; channel++) {
    const pointer = pointers[channel];
    if (pointer === 0 || pointer % 4 !== 0 || pointer + bytes > buffer.byteLength)
      throw new Error("The live audio engine returned an invalid buffer address.");
    for (let previous = 0; previous < channel; previous++) {
      if (pointer < pointers[previous] + bytes && pointers[previous] < pointer + bytes)
        throw new Error("The live audio engine returned overlapping buffers.");
    }
  }
  left = new Float32Array(buffer, pointers[0], QUANTUM);
  right = new Float32Array(buffer, pointers[1], QUANTUM);
  outLeft = new Float32Array(buffer, pointers[2], QUANTUM);
  outRight = new Float32Array(buffer, pointers[3], QUANTUM);
  memoryBuffer = buffer;
}
function bindDirectExports(exports) {
  if (!(exports.mem instanceof WebAssembly.Memory)
    || typeof exports.aurialis_live_buffer !== "function"
    || typeof exports.aurialis_live_process !== "function"
    || typeof exports.aurialis_live_reset !== "function")
    throw new Error("The shared audio engine is missing its fixed-buffer interface.");
  direct = { memory: exports.mem, buffer: exports.aurialis_live_buffer,
    process: exports.aurialis_live_process, reset: exports.aurialis_live_reset };
  memoryBuffer = undefined;
  refreshLiveBuffers();
}
function processLiveBlock() {
  refreshLiveBuffers();
  const frames = direct.process();
  refreshLiveBuffers();
  return frames;
}
function fail(message) {
  stopped = true;
  cancelContinuation();
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
    if (processLiveBlock() !== QUANTUM)
      throw new Error("The live audio engine could not warm up.");
  }
  left.fill(0); right.fill(0); outLeft.fill(0); outRight.fill(0);
}
function reset(requestedGeneration = Atomics.load(header, GENERATION)) {
  const generation = Atomics.load(header, GENERATION);
  if (requestedGeneration !== generation || activeGeneration === generation) return;
  const result = direct.reset();
  refreshLiveBuffers();
  if (result !== 1) throw new Error("The live audio engine could not reset.");
  activeGeneration = generation;
  Atomics.store(header, READ, 0);
}
function cancelContinuation() {
  if (continuation === undefined) return;
  clearTimeout(continuation);
  continuation = undefined;
}
function continueAfterYield() {
  if (continuation !== undefined) return;
  continuation = setTimeout(() => {
    continuation = undefined;
    pump();
  }, 0);
}
function pump() {
  if (stopped || pumping || !header) return;
  cancelContinuation();
  pumping = true;
  let processed = false;
  try {
    // Keep one active wake lease across bounded bursts. The render thread only
    // needs a MessagePort task when starting an idle worker; subsequent input
    // wakes the worker's predicate wait without allocating one task per block.
    Atomics.store(header, WAKE, 1);
    const deadline = performance.now() + BURST_MS;
    for (let count = 0; count < BURST_BLOCKS;) {
      if (activeGeneration !== Atomics.load(header, GENERATION)) reset();
      const read = Atomics.load(header, READ);
      const written = Atomics.load(header, WRITE);
      if (written <= read) {
        const remaining = deadline - performance.now();
        if (remaining <= 0) break;
        // Publication before this atomic check returns "not-equal"; input
        // published while waiting notifies WRITE. Only this worker can wait.
        Atomics.wait(header, WRITE, written, remaining);
        continue;
      }
      if (written - read > SLOTS) throw new Error("The live audio worker fell behind its bounded buffer.");
      const sequence = read + 1, slot = (sequence - 1) % SLOTS, offset = slot * QUANTUM;
      if (Atomics.load(tags, slot) !== sequence || Atomics.load(tags, SLOTS + slot) !== activeGeneration) break;
      refreshLiveBuffers();
      for (let i = 0; i < QUANTUM; i++) {
        left[i] = samples[offset + i];
        right[i] = samples[FRAMES + offset + i];
      }
      if (processLiveBlock() !== QUANTUM)
        throw new Error("The live audio engine rejected an audio block.");
      if (activeGeneration !== Atomics.load(header, GENERATION)) break;
      for (let i = 0; i < QUANTUM; i++) {
        samples[2 * FRAMES + offset + i] = outLeft[i];
        samples[3 * FRAMES + offset + i] = outRight[i];
      }
      Atomics.store(tags, 4 * SLOTS + slot, version);
      Atomics.store(tags, 3 * SLOTS + slot, activeGeneration);
      Atomics.store(tags, 2 * SLOTS + slot, sequence);
      Atomics.store(header, READ, sequence);
      processed = true;
      count++;
      if (performance.now() >= deadline) break;
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : "Live audio processing failed.");
  } finally {
    pumping = false;
  }
  if (stopped) {
    Atomics.store(header, WAKE, 0);
    return;
  }
  // Yield to JSON controls after at most one burst. An empty burst retires the
  // lease, so a paused graph does not leave a perpetual polling timer behind.
  if (processed || Atomics.load(header, WRITE) > Atomics.load(header, READ)
    || activeGeneration !== Atomics.load(header, GENERATION)) {
    continueAfterYield();
    return;
  }
  Atomics.store(header, WAKE, 0);
  // A publication before releasing the lease needs our continuation; one after
  // releasing it posts a bootstrap task. That task cancels a stale continuation.
  if (Atomics.load(header, WRITE) > Atomics.load(header, READ)
    || activeGeneration !== Atomics.load(header, GENERATION)) {
    Atomics.store(header, WAKE, 1);
    continueAfterYield();
  }
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
      bindDirectExports(result.instance.exports);
      version = message.version;
      warmUp(message.sampleRate);
      reset();
      inputPort.onmessage = pump;
      inputPort.start();
      self.postMessage({ type: "ready" });
    } else if (message.type === "params") {
      const accepted = self.aurialisDSPSetParams(message.params);
      refreshLiveBuffers();
      if (!accepted)
        throw new Error("The live audio engine rejected these settings.");
      version = message.version;
    } else if (message.type === "reset" && header) {
      reset(message.generation);
    } else if (message.type === "dispose") {
      stopped = true;
      cancelContinuation();
      if (header) Atomics.store(header, WAKE, 0);
      inputPort?.close();
      self.close();
    }
  } catch (error) {
    fail(error instanceof Error ? error.message : "Live audio initialization failed.");
  }
};
