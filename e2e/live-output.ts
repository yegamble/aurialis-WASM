import type { Page } from "@playwright/test";

type OutputProbe = {
  generation: number;
  instanceId: string;
  frames: number;
  time: number;
  sampleRate: number;
  left: number[];
  right: number[];
};
type ProbeWindow = Window & { qaOutput?: OutputProbe };

/** Test-only tap of the actual node feeding the speakers; no application DSP mocks. */
export async function observeOutput(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const nativeConnect = AudioNode.prototype.connect;
    let generation = 0;
    const connected = new WeakSet<AudioNode>();
    AudioNode.prototype.connect = function (...args: Parameters<typeof nativeConnect>) {
      const result = Reflect.apply(nativeConnect, this, args) as AudioNode;
      const destination = args[0];
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
        };
        Reflect.apply(nativeConnect, this, [capture]);
        Reflect.apply(nativeConnect, capture, [silent]);
        Reflect.apply(nativeConnect, silent, [destination]);
      }
      return result;
    } as typeof nativeConnect;
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
