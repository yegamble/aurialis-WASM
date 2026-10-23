/* Test-only bounded PCM observer of the actual speaker feed. */
class FiniteSpeakerCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) { super(); const c = options.processorOptions; this.header = new Int32Array(c.header); this.samples = new Float32Array(c.samples); this.times = new Float64Array(c.times); this.generation = 0; this.count = 0; }
  process(inputs, outputs) {
    for (const channel of outputs[0] || []) channel.fill(0);
    const generation = Atomics.load(this.header, 0);
    if (!generation) return true;
    if (generation !== this.generation) { this.generation = generation; this.count = 0; }
    const input = inputs[0]; if (!input || !input[0] || this.count + 128 > 262144) return true;
    this.samples.set(input[0], this.count); this.samples.set(input[1] || input[0], 262144 + this.count);
    this.times[this.count / 128] = currentTime; this.count += 128;
    Atomics.store(this.header, 1, this.count); return true;
  }
}
registerProcessor("finite-speaker-capture", FiniteSpeakerCaptureProcessor);
