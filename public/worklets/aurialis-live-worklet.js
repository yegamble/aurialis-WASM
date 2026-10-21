/* No Go runtime, blocking waits, network operations or growing queues here. */
"use strict";
const QUANTUM = 128;
const SLOTS = 256;
const FRAMES = QUANTUM * SLOTS;
const WRITE = 0, READ = 1, GENERATION = 2, APPLIED = 4, ERROR = 5, UNDERRUNS = 6, WAKE = 7;
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
    this.inputPort = null;
    this.failed = false;
    this.missing = 0;
    this.sum = 0;
    this.peak = 0;
    this.ll = 0;
    this.rr = 0;
    this.lr = 0;
    this.frames = 0;
    this.port.onmessage = (event) => {
      const message = event.data;
      if (message.type === "connect") {
        this.inputPort = message.port;
        this.inputPort.start();
      } else if (message.type === "reset") {
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
    };
  }
  process(inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length < 2) return true;
    const outL = output[0], outR = output[1];
    // Connecting a graph is not a playback deadline: the controller can still
    // be allocating/copying its source. Only its explicit reset starts a stream.
    if (!this.active || outL.length !== QUANTUM || this.failed || Atomics.load(this.header, ERROR)) {
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
    for (let i = 0; i < QUANTUM; i++) {
      this.samples[offset + i] = inL ? inL[i] : 0;
      this.samples[FRAMES + offset + i] = inR ? inR[i] : 0;
    }
    Atomics.store(this.tags, slot, sequence);
    Atomics.store(this.tags, SLOTS + slot, this.generation);
    Atomics.store(this.header, WRITE, sequence);
    Atomics.notify(this.header, WRITE, 1);
    if (this.inputPort && Atomics.compareExchange(this.header, WAKE, 0, 1) === 0)
      this.inputPort.postMessage(0);
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
