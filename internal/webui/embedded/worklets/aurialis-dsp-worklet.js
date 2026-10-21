// Aurialis-WASM Real-Time AudioWorkletProcessor
// Bridges WebAssembly DSP block processing and lock-free parameter updates.

class AurialisDSPProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.bypass = false;
    this.abOriginal = false;
    this.loudnessMatchAb = false;
    this.inputGainDb = 0.0;
    this.widthPct = 100.0;
    this.monoBass = false;
    this.satAmount = 0.0;
    this.ceilingDbtp = -1.0;
    this.limiterEnabled = false;
    this.lowBassLP_L = 0.0;
    this.lowBassLP_R = 0.0;
    this.frameCounter = 0;

    this.port.onmessage = (event) => {
      const msg = event.data;
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "SET_PARAMS" && msg.params) {
        const p = msg.params;
        this.bypass = Boolean(p.bypass);
        this.abOriginal = Boolean(p.abOriginal);
        this.loudnessMatchAb = Boolean(p.loudnessMatchAb);
        this.inputGainDb = Number(p.inputGainDb ?? 0);
        if (p.stereo) {
          this.widthPct = Number(p.stereo.widthPct ?? 100);
          this.monoBass = Boolean(p.stereo.monoBass);
        }
        if (p.saturation) {
          this.satAmount = p.saturation.enabled ? Number(p.saturation.amount ?? 0) : 0;
        }
        if (p.limiter) {
          this.limiterEnabled = Boolean(p.limiter.enabled);
          this.ceilingDbtp = Number(p.limiter.ceilingDbtp ?? -1.0);
        }
        if (typeof globalThis.aurialisDSPSetParams === "function") {
          globalThis.aurialisDSPSetParams(JSON.stringify(p));
        }
      }
    };
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !output || input.length === 0) {
      return true;
    }
    const inL = input[0];
    const inR = input.length > 1 ? input[1] : input[0];
    const outL = output[0];
    const outR = output.length > 1 ? output[1] : output[0];
    if (!inL || !outL) return true;

    const n = inL.length;
    if (typeof globalThis.aurialisDSPProcessBlock === "function") {
      globalThis.aurialisDSPProcessBlock(inL, inR, outL, outR);
      return true;
    }

    const gain = Math.pow(10, this.inputGainDb / 20);
    const width = Math.max(0, Math.min(2, this.widthPct / 100));
    const satAmt = Math.max(0, Math.min(1, this.satAmount / 100));
    const drive = 1 + satAmt * 2.5;
    const ceiling = this.limiterEnabled ? Math.pow(10, this.ceilingDbtp / 20) : 1.0;

    let sumSq = 0;
    let peak = 0;

    for (let i = 0; i < n; i++) {
      const rawL = inL[i] || 0;
      const rawR = inR ? inR[i] || 0 : rawL;
      if (this.bypass || this.abOriginal) {
        outL[i] = rawL;
        if (outR) outR[i] = rawR;
        continue;
      }

      let l = rawL * gain;
      let r = rawR * gain;

      if (satAmt > 0.001) {
        l = (1 - satAmt) * l + satAmt * Math.tanh(drive * l);
        r = (1 - satAmt) * r + satAmt * Math.tanh(drive * r);
      }

      const mid = 0.5 * (l + r);
      const side = 0.5 * (l - r) * width;
      l = Math.max(-ceiling, Math.min(ceiling, mid + side));
      r = Math.max(-ceiling, Math.min(ceiling, mid - side));

      outL[i] = l;
      if (outR) outR[i] = r;

      const p = Math.max(Math.abs(l), Math.abs(r));
      if (p > peak) peak = p;
      sumSq += 0.5 * (l * l + r * r);
    }

    this.frameCounter += n;
    if (this.frameCounter >= 4800) {
      this.frameCounter = 0;
      const rms = Math.sqrt(sumSq / Math.max(1, n));
      const lufs = rms > 1e-6 ? -0.691 + 20 * Math.log10(rms) : -70;
      const dbtp = peak > 1e-6 ? 20 * Math.log10(peak) : -120;
      this.port.postMessage({ type: "METERS", lufs, dbtp });
    }
    return true;
  }
}

registerProcessor("aurialis-dsp-processor", AurialisDSPProcessor);
