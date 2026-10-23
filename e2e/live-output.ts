import { expect, type Page } from "@playwright/test";

type OutputProbe = {
  generation: number;
  instanceId: string;
  frames: number;
  time: number;
  sampleRate: number;
  left: number[];
  right: number[];
  energy?: { remaining: number; frames: number; squares: number };
};
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
            for (let index = 0; index < count; index++)
              energy.squares += (probe.left[index] ?? 0) ** 2 + (probe.right[index] ?? 0) ** 2;
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

/** Average a whole source-period window, retaining no extra PCM buffers. */
export async function meanOutputLevel(page: Page, frames?: number): Promise<number> {
  await page.evaluate((count) => {
    const probe = (window as ProbeWindow).qaOutput;
    if (!probe) throw new Error("Missing live output probe");
    probe.energy = { remaining: count ?? probe.sampleRate, frames: 0, squares: 0 };
  }, frames);
  await expect.poll(() => page.evaluate(() => (window as ProbeWindow).qaOutput?.energy?.remaining), { intervals: [50] }).toBe(0);
  return page.evaluate(() => {
    const energy = (window as ProbeWindow).qaOutput?.energy;
    if (!energy || !energy.frames) throw new Error("Missing live output energy");
    return 10 * Math.log10(energy.squares / (2 * energy.frames));
  });
}
