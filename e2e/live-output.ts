import { expect, type Page } from "@playwright/test";

type OutputProbe = {
  generation: number;
  instanceId: string;
  frames: number;
  time: number;
  sampleRate: number;
  left: number[];
  right: number[];
  energy?: { remaining: number; frames: number; squares: number; k?: KWeighting };
};
/** BS.1770 K-weighting (pre-filter shelf then RLB high-pass) with per-channel state. */
type KWeighting = { coefficients: number[][]; state: number[][] };
type ProbeWindow = Window & { qaOutput?: OutputProbe };

/** Test-only tap of the actual node feeding the speakers; no application DSP mocks. */
export async function observeOutput(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const nativeConnect = AudioNode.prototype.connect;
    let generation = 0;
    const connected = new WeakSet<AudioNode>();
    function connect(this: AudioNode, destination: AudioNode, output?: number, input?: number): AudioNode;
    function connect(this: AudioNode, destination: AudioParam, output?: number): void;
    function connect(this: AudioNode, destination: AudioNode | AudioParam, ...ports: (number | undefined)[]): AudioNode | void {
      const result: unknown = Reflect.apply(nativeConnect, this, [destination, ...ports]);
      if (destination instanceof AudioDestinationNode && !connected.has(this)) {
        connected.add(this);
        const context = this.context as AudioContext;
        const capture = context.createScriptProcessor(1024, 2, 2);
        const silent = context.createGain();
        silent.gain.value = 0;
        const probe: OutputProbe = {
          generation: ++generation, instanceId: `${performance.timeOrigin}:${generation}`,
          frames: 0, time: 0, sampleRate: context.sampleRate, left: [], right: [],
        };
        (window as ProbeWindow).qaOutput = probe;
        capture.onaudioprocess = (event) => {
          probe.frames += event.inputBuffer.length;
          probe.time = event.playbackTime;
          probe.left = Array.from(event.inputBuffer.getChannelData(0));
          probe.right = Array.from(event.inputBuffer.getChannelData(1));
          const energy = probe.energy;
          if (energy && energy.remaining > 0) {
            const count = Math.min(energy.remaining, probe.left.length);
            const k = energy.k;
            // Two cascaded biquads per channel; state holds x1, x2, y1, y2 per stage.
            const weigh = (sample: number, channel: number) => {
              if (!k) return sample;
              let value = sample;
              for (let stage = 0; stage < 2; stage++) {
                const [b0 = 0, b1 = 0, b2 = 0, a1 = 0, a2 = 0] = k.coefficients[stage] ?? [];
                const s = k.state[channel * 2 + stage] ?? [0, 0, 0, 0];
                const [x1 = 0, x2 = 0, y1 = 0, y2 = 0] = s;
                const y = b0 * value + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
                k.state[channel * 2 + stage] = [value, x1, y, y1];
                value = y;
              }
              return value;
            };
            for (let index = 0; index < count; index++)
              energy.squares += weigh(probe.left[index] ?? 0, 0) ** 2 + weigh(probe.right[index] ?? 0, 1) ** 2;
            energy.remaining -= count;
            energy.frames += count;
          }
        };
        Reflect.apply(nativeConnect, this, [capture]);
        Reflect.apply(nativeConnect, capture, [silent]);
        Reflect.apply(nativeConnect, silent, [destination]);
      }
      return result instanceof AudioNode ? result : undefined;
    }
    AudioNode.prototype.connect = connect;
  });
}

export async function outputLevel(page: Page) {
  return page.evaluate(() => {
    const probe = (window as ProbeWindow).qaOutput;
    if (!probe || !probe.left.length) return null;
    const square = probe.left.reduce((sum, sample) => sum + sample * sample, 0)
      + probe.right.reduce((sum, sample) => sum + sample * sample, 0);
    const rms = Math.sqrt(square / (probe.left.length + probe.right.length));
    const peak = Math.max(...probe.left.map(Math.abs), ...probe.right.map(Math.abs));
    return {
      generation: probe.generation, instanceId: probe.instanceId,
      frames: probe.frames, time: probe.time, sampleRate: probe.sampleRate,
      rmsDbfs: rms > 0 ? 20 * Math.log10(rms) : -Infinity,
      peakDbfs: peak > 0 ? 20 * Math.log10(peak) : -Infinity,
    };
  });
}

/** BS.1770 K-weighting biquads at a sample rate: pre-filter shelf, then RLB high-pass. */
function kWeighting(fs: number): number[][] {
  const shelfK = Math.tan(Math.PI * 1681.974450955533 / fs), shelfQ = 0.7071752369554196;
  const vh = 10 ** (3.999843853973347 / 20), vb = vh ** 0.4996667741545416, s0 = 1 + shelfK / shelfQ + shelfK * shelfK;
  const passK = Math.tan(Math.PI * 38.13547087602444 / fs), passQ = 0.5003270373238773, p0 = 1 + passK / passQ + passK * passK;
  return [
    [(vh + vb * shelfK / shelfQ + shelfK * shelfK) / s0, 2 * (shelfK * shelfK - vh) / s0, (vh - vb * shelfK / shelfQ + shelfK * shelfK) / s0, 2 * (shelfK * shelfK - 1) / s0, (1 - shelfK / shelfQ + shelfK * shelfK) / s0],
    [1, -2, 1, 2 * (passK * passK - 1) / p0, (1 - passK / passQ + passK * passK) / p0],
  ];
}

/** Mean K-weighted power per channel (dB) of stereo PCM, as meanOutputLevel measures the speakers. */
export function kWeightedLevel(left: ArrayLike<number>, right: ArrayLike<number>, fs: number): number {
  const coefficients = kWeighting(fs);
  let squares = 0;
  for (const channel of [left, right]) {
    const state = [[0, 0, 0, 0], [0, 0, 0, 0]];
    for (let index = 0; index < channel.length; index++) {
      let value = channel[index] ?? 0;
      for (let stage = 0; stage < 2; stage++) {
        const [b0 = 0, b1 = 0, b2 = 0, a1 = 0, a2 = 0] = coefficients[stage] ?? [];
        const [x1 = 0, x2 = 0, y1 = 0, y2 = 0] = state[stage] ?? [];
        const y = b0 * value + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        state[stage] = [value, x1, y, y1];
        value = y;
      }
      squares += value * value;
    }
  }
  return 10 * Math.log10(squares / (left.length + right.length));
}

/**
 * Average a whole source-period window, retaining no extra PCM buffers. With
 * `weighting: "k"` the speaker output is K-weighted (ungated BS.1770), so A
 * and B with different spectra compare in loudness rather than raw power.
 */
export async function meanOutputLevel(page: Page, frames?: number, weighting: "flat" | "k" = "flat"): Promise<number> {
  const rate = await page.evaluate(() => (window as ProbeWindow).qaOutput?.sampleRate ?? 0);
  if (!rate) throw new Error("Missing live output probe");
  await page.evaluate(([count, coefficients]) => {
    const probe = (window as ProbeWindow).qaOutput;
    if (!probe) throw new Error("Missing live output probe");
    probe.energy = { remaining: count ?? probe.sampleRate, frames: 0, squares: 0,
      ...(coefficients ? { k: { coefficients, state: [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]] } } : {}) };
  }, [frames, weighting === "k" ? kWeighting(rate) : null] as const);
  await expect.poll(() => page.evaluate(() => (window as ProbeWindow).qaOutput?.energy?.remaining), { intervals: [50], timeout: 30_000 }).toBe(0);
  return page.evaluate(() => {
    const energy = (window as ProbeWindow).qaOutput?.energy;
    if (!energy || !energy.frames) throw new Error("Missing live output energy");
    return 10 * Math.log10(energy.squares / (2 * energy.frames));
  });
}
