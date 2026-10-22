/* Fixed Go WASI kernel: no host capabilities or blocking waits while rendering. */
import { createAurialisWasiHost } from "./aurialis-wasi-host.js";
"use strict";
const QUANTUM = 128;
const SLOTS = 256;
const FRAMES = QUANTUM * SLOTS;
const WRITE = 0, READ = 1, GENERATION = 2, APPLIED = 4, ERROR = 5, UNDERRUNS = 6;
const LEGACY_CONTROL_COUNT = 81;
class AurialisLiveProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const config = options.processorOptions;
    this.header = new Int32Array(config.header);
    this.tags = new Int32Array(config.tags);
    this.samples = new Float32Array(config.samples);
    this.delay = config.delayBlocks;
    this.generation = Atomics.load(this.header, GENERATION);
    this.sequence = 0;
    this.active = false;
    this.original = false;
    this.mix = 0;
    this.volume = 1;
    this.targetVolume = 1;
    this.endTime = Infinity;
    this.ready = false;
    this.controlVersion = 0;
    this.failed = false;
    this.missing = 0;
    this.sum = 0;
    this.peak = 0;
    this.ll = 0;
    this.rr = 0;
    this.lr = 0;
    this.frames = 0;
    this.port.onmessage = (event) => {
      try {
      const message = event.data;
      if (message.type === "reset") {
        if (message.generation !== Atomics.load(this.header, GENERATION)) return;
        if (this.active && this.generation === message.generation) return;
        if (this.generation !== message.generation || !this.active) this.resetKernel();
        this.generation = message.generation;
        this.active = true;
        this.sequence = 0;
        this.endTime = Infinity;
        this.missing = 0;
        this.sum = this.peak = this.ll = this.rr = this.lr = this.frames = 0;
      } else if (message.type === "end" && message.generation === this.generation) {
        if (typeof message.time === "number" && message.time >= 0) this.endTime = message.time;
      } else if (message.type === "original") {
        this.original = message.value;
      } else if (message.type === "volume") {
        this.targetVolume = message.value;
      }
      } catch (error) { this.fail(error); }
    };
    try {
      this.controlAbiVersion = config.controlAbiVersion === undefined ? 1 : config.controlAbiVersion;
      if (this.controlAbiVersion !== 1 && this.controlAbiVersion !== 2)
        throw new Error("The live audio control ABI is unsupported.");
      this.controlCount = LEGACY_CONTROL_COUNT + (this.controlAbiVersion === 2 ? 1 : 0);
      if (!(config.controls instanceof SharedArrayBuffer) || config.controls.byteLength !== 16 + this.controlCount * 8)
        throw new Error("The live audio settings buffer is invalid.");
      this.controlHeader = new Int32Array(config.controls, 0, 4);
      this.controlValues = new Float64Array(config.controls, 16, this.controlCount);
      const origin = config.clockOriginMs;
      if (!Number.isFinite(origin) || origin <= 0)
        throw new Error("The audio initialization clock is invalid.");
      const host = createAurialisWasiHost({ entropy: config.entropy, now: () => origin + currentTime * 1000 });
      const instance = new WebAssembly.Instance(config.module, host.imports);
      const exports = instance.exports;
      if (!(exports.memory instanceof WebAssembly.Memory)
        || typeof exports._initialize !== "function" || typeof exports.aurialis_init !== "function"
        || typeof exports.aurialis_live_buffer !== "function" || typeof exports.aurialis_control_buffer !== "function"
        || typeof exports.aurialis_live_process !== "function" || typeof exports.aurialis_live_reset !== "function"
        || typeof exports.aurialis_set_controls !== "function"
        || typeof exports.aurialis_control_count !== "function" || typeof exports.aurialis_algorithm_supported !== "function"
        || typeof exports.aurialis_latency_frames !== "function" || typeof exports.aurialis_live_drain !== "function")
        throw new Error("The live audio engine is missing its fixed-buffer interface.");
      host.attach(exports.memory);
      exports._initialize();
      if (exports.aurialis_init(sampleRate) !== 1) throw new Error("The live audio engine rejected the output rate.");
      if (exports.aurialis_control_count(this.controlAbiVersion) !== this.controlCount
        || exports.aurialis_algorithm_supported(1) !== 1)
        throw new Error("The live audio engine and settings capabilities do not match.");
      if (exports.aurialis_latency_frames() !== 0)
        throw new Error("The live audio engine requires unsupported latency compensation.");
      if (this.controlAbiVersion === 2 && (typeof exports.aurialis_control_buffer_v2 !== "function"
        || typeof exports.aurialis_set_controls_v2 !== "function"))
        throw new Error("The live audio engine is missing its versioned settings interface.");
      this.kernel = exports;
      this.refreshBuffers();
      host.beginRender();
      this.tryReady();
    } catch (error) {
      this.fail(error);
    }
  }
  fail(error) {
    if (this.failed) return;
    this.failed = true;
    Atomics.store(this.header, ERROR, 1);
    this.port.postMessage({ type: "error", message: error instanceof Error ? error.message : "Live audio processing failed." });
  }
  refreshBuffers() {
    if (this.kernel.memory.buffer === this.memoryBuffer) return;
    const pointers = [];
    for (let channel = 0; channel < 4; channel++) pointers.push(this.kernel.aurialis_live_buffer(channel));
    pointers.push(this.controlAbiVersion === 2 ? this.kernel.aurialis_control_buffer_v2() : this.kernel.aurialis_control_buffer());
    const buffer = this.kernel.memory.buffer;
    for (let index = 0; index < pointers.length; index++) {
      const raw = pointers[index];
      if (!Number.isInteger(raw) || raw < -2147483648 || raw > 2147483647)
        throw new Error("The live audio engine returned an invalid buffer address.");
      pointers[index] = raw >>> 0;
      const bytes = index === 4 ? this.controlCount * 8 : QUANTUM * 4;
      const alignment = index === 4 ? 8 : 4;
      if (pointers[index] === 0 || pointers[index] % alignment !== 0 || pointers[index] + bytes > buffer.byteLength)
        throw new Error("The live audio engine returned an invalid buffer address.");
      for (let previous = 0; previous < index; previous++) {
        const previousBytes = previous === 4 ? this.controlCount * 8 : QUANTUM * 4;
        if (pointers[index] < pointers[previous] + previousBytes && pointers[previous] < pointers[index] + bytes)
          throw new Error("The live audio engine returned overlapping buffers.");
      }
    }
    this.left = new Float32Array(buffer, pointers[0], QUANTUM);
    this.right = new Float32Array(buffer, pointers[1], QUANTUM);
    this.outLeft = new Float32Array(buffer, pointers[2], QUANTUM);
    this.outRight = new Float32Array(buffer, pointers[3], QUANTUM);
    this.controls = new Float64Array(buffer, pointers[4], this.controlCount);
    this.memoryBuffer = buffer;
  }
  applyControls() {
    const sequence = Atomics.load(this.controlHeader, 0);
    if (sequence % 2 !== 0) return false;
    const version = Atomics.load(this.controlHeader, 1);
    if (!Number.isInteger(version) || version <= 0) throw new Error("The live audio settings version is invalid.");
    if (version === this.controlVersion) return true;
    this.refreshBuffers();
    for (let index = 0; index < this.controlCount; index++) this.controls[index] = this.controlValues[index];
    // Values AND their applied version belong to this one stable transaction.
    // Never retry/spin on the render thread: retain the prior chain this block.
    if (sequence !== Atomics.load(this.controlHeader, 0)) return false;
    const accepted = this.controlAbiVersion === 2
      ? this.kernel.aurialis_set_controls_v2(this.controlCount) : this.kernel.aurialis_set_controls();
    if (accepted !== 1) throw new Error("The live audio engine rejected these settings.");
    this.refreshBuffers();
    this.controlVersion = version;
    return true;
  }
  resetKernel() {
    if (this.kernel.aurialis_live_reset() !== 1) throw new Error("The live audio engine could not reset.");
    this.refreshBuffers();
  }
  tryReady() {
    if (this.ready || !this.applyControls()) return;
    for (let index = 0; index < QUANTUM; index++) {
      this.left[index] = 0.05 * Math.sin(2 * Math.PI * 1000 * index / sampleRate);
      this.right[index] = 0.04 * Math.sin(2 * Math.PI * 1000 * index / sampleRate + 0.3);
    }
    for (let block = 0; block < 256; block++) {
      if (this.kernel.aurialis_live_process() !== QUANTUM) throw new Error("The live audio engine could not warm up.");
      this.refreshBuffers();
    }
    this.resetKernel();
    this.ready = true;
    this.port.postMessage({ type: "ready" });
  }
  process(inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length < 2) return true;
    const outL = output[0], outR = output[1];
    if (!this.ready && !this.failed) {
      try { this.tryReady(); } catch (error) { this.fail(error); }
    }
    // Connecting a graph is not a playback deadline: the controller can still
    // be allocating/copying its source. Only its explicit reset starts a stream.
    if (!this.ready || !this.active || outL.length !== QUANTUM || this.failed || Atomics.load(this.header, ERROR)) {
      outL.fill(0); outR.fill(0); return true;
    }
    const input = inputs[0], inL = input?.[0], inR = input?.[1] || inL;
    const sequence = ++this.sequence, slot = (sequence - 1) % SLOTS, offset = slot * QUANTUM;
    if (this.generation !== Atomics.load(this.header, GENERATION)) {
      outL.fill(0); outR.fill(0); return true;
    }
    if (sequence - Atomics.load(this.header, READ) >= SLOTS) {
      this.failed = true;
      this.port.postMessage({ type: "error", message: "The live audio buffer could not keep up." });
      outL.fill(0); outR.fill(0); return true;
    }
    try {
      this.applyControls();
      this.refreshBuffers();
      for (let i = 0; i < QUANTUM; i++) {
        const l = inL ? inL[i] : 0, r = inR ? inR[i] : 0;
        this.samples[offset + i] = this.left[i] = l;
        this.samples[FRAMES + offset + i] = this.right[i] = r;
      }
      Atomics.store(this.tags, slot, sequence);
      Atomics.store(this.tags, SLOTS + slot, this.generation);
      Atomics.store(this.header, WRITE, sequence);
      if (this.kernel.aurialis_live_process() !== QUANTUM)
        throw new Error("The live audio engine rejected an audio block.");
      this.refreshBuffers();
      if (this.generation !== Atomics.load(this.header, GENERATION)) {
        outL.fill(0); outR.fill(0); return true;
      }
      for (let i = 0; i < QUANTUM; i++) {
        this.samples[2 * FRAMES + offset + i] = this.outLeft[i];
        this.samples[3 * FRAMES + offset + i] = this.outRight[i];
      }
      Atomics.store(this.tags, 4 * SLOTS + slot, this.controlVersion);
      Atomics.store(this.tags, 3 * SLOTS + slot, this.generation);
      Atomics.store(this.tags, 2 * SLOTS + slot, sequence);
      Atomics.store(this.header, READ, sequence);
    } catch (error) {
      this.fail(error);
      outL.fill(0); outR.fill(0); return true;
    }
    const expected = sequence - this.delay;
    const outputSlot = (expected - 1 + SLOTS) % SLOTS, outputOffset = outputSlot * QUANTUM;
    const available = expected > 0 && Atomics.load(this.tags, 2 * SLOTS + outputSlot) === expected
      && Atomics.load(this.tags, 3 * SLOTS + outputSlot) === this.generation;
    if (expected > 0 && !available) {
      Atomics.add(this.header, UNDERRUNS, 1);
      if (++this.missing > Math.ceil(sampleRate * 0.2 / QUANTUM)) {
        this.failed = true;
        this.port.postMessage({ type: "error", message: "Live processing stalled. Pause and restart playback." });
      }
    } else this.missing = 0;
    if (available) Atomics.store(this.header, APPLIED, Atomics.load(this.tags, 4 * SLOTS + outputSlot));
    const targetMix = this.original ? 1 : 0;
    const step = 1 / (sampleRate * 0.008);
    const volumeStep = 1 / (sampleRate * 0.01);
    for (let i = 0; i < QUANTUM; i++) {
      this.mix += Math.max(-step, Math.min(step, targetMix - this.mix));
      this.volume += Math.max(-volumeStep, Math.min(volumeStep, this.targetVolume - this.volume));
      const dryL = expected > 0 ? this.samples[outputOffset + i] : 0;
      const dryR = expected > 0 ? this.samples[FRAMES + outputOffset + i] : 0;
      const wetL = available ? this.samples[2 * FRAMES + outputOffset + i] : 0;
      const wetR = available ? this.samples[3 * FRAMES + outputOffset + i] : 0;
      const audible = currentTime + i / sampleRate < this.endTime;
      const l = audible ? (wetL * (1 - this.mix) + dryL * this.mix) * this.volume : 0;
      const r = audible ? (wetR * (1 - this.mix) + dryR * this.mix) * this.volume : 0;
      outL[i] = l; outR[i] = r;
      this.peak = Math.max(this.peak, Math.abs(l), Math.abs(r));
      this.sum += l * l + r * r;
      this.ll += l * l; this.rr += r * r; this.lr += l * r;
    }
    this.frames += QUANTUM;
    if (this.frames >= sampleRate * 0.05) {
      const rms = Math.sqrt(this.sum / (this.frames * 2));
      const db = value => value > 1e-12 ? 20 * Math.log10(value) : -120;
      const denominator = Math.sqrt(this.ll * this.rr);
      this.port.postMessage({ type: "meter", generation: this.generation, time: currentTime + QUANTUM / sampleRate,
        peakDbfs: db(this.peak), rmsDbfs: db(rms), crestDb: rms > 1e-12 ? db(this.peak / rms) : 0,
        correlation: denominator > 1e-12 ? Math.max(-1, Math.min(1, this.lr / denominator)) : 1 });
      this.sum = this.peak = this.ll = this.rr = this.lr = this.frames = 0;
    }
    return true;
  }
}
registerProcessor("aurialis-live", AurialisLiveProcessor);
