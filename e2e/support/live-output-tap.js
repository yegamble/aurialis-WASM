/* Test-only audio-thread observer of the actual node feeding the speakers. */
class LiveOutputTap extends AudioWorkletProcessor {
  constructor() {
    super(); this.frames = 0; this.blocks = 0; this.measurement = null; this.left = new Float32Array(1024); this.right = new Float32Array(1024);
    this.port.onmessage = (event) => {
      const { frames, coefficients } = event.data;
      this.measurement = { remaining: frames, frames: 0, squares: 0, coefficients, state: [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]] };
    };
  }
  process(inputs, outputs) {
    for (const channel of outputs[0] || []) channel.fill(0);
    const input = inputs[0]; if (!input || !input[0]) return true;
    const left = input[0], right = input[1] || left;
    this.left.set(left, this.blocks % 8 * 128); this.right.set(right, this.blocks % 8 * 128);
    this.frames += left.length;
    const measure = this.measurement;
    if (measure && measure.remaining > 0) {
      const count = Math.min(measure.remaining, left.length);
      for (let channel = 0; channel < 2; channel++) {
        const samples = channel ? right : left;
        for (let index = 0; index < count; index++) {
          let value = samples[index];
          if (measure.coefficients) for (let stage = 0; stage < 2; stage++) {
            const c = measure.coefficients[stage], s = measure.state[channel * 2 + stage];
            const y = c[0] * value + c[1] * s[0] + c[2] * s[1] - c[3] * s[2] - c[4] * s[3];
            s[1] = s[0]; s[0] = value; s[3] = s[2]; s[2] = y; value = y;
          }
          measure.squares += value * value;
        }
      }
      measure.frames += count; measure.remaining -= count;
      if (!measure.remaining) this.port.postMessage({ type: "energy", frames: measure.frames, squares: measure.squares });
    }
    if (++this.blocks % 8 === 0) this.port.postMessage({ type: "level", frames: this.frames, time: currentTime, left: Array.from(this.left), right: Array.from(this.right) });
    return true;
  }
}
registerProcessor("qa-live-output", LiveOutputTap);
