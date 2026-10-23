import { expect, type Page } from "@playwright/test";

type Packet = { generation: number; time: number; rmsDbfs: number; peakDbfs: number };
type RenderProbe = { sampleRate: number; packets: Packet[] };
type ProbeWindow = Window & { qaRenderOutput?: RenderProbe };

/** Observe the real worklet's energy of the samples assigned to its output.
 * Timestamped windows survive delayed main-thread delivery; no audio is mocked.
 */
export async function observeRenderOutput(page: Page) {
  await page.addInitScript(() => {
    const NativeNode = AudioWorkletNode;
    window.AudioWorkletNode = class extends NativeNode {
      constructor(context: BaseAudioContext, name: string, options?: AudioWorkletNodeOptions) {
        super(context, name, options); if (name !== "aurialis-live") return;
        const probe: RenderProbe = { sampleRate: context.sampleRate, packets: [] };
        (window as ProbeWindow).qaRenderOutput = probe;
        this.port.addEventListener("message", (event: MessageEvent<unknown>) => {
          const value = event.data as Partial<Packet> & { type?: string };
          if (value.type !== "meter" || typeof value.generation !== "number" || typeof value.time !== "number"
            || typeof value.rmsDbfs !== "number" || typeof value.peakDbfs !== "number"
            || ![value.generation, value.time, value.rmsDbfs, value.peakDbfs].every(Number.isFinite)) return;
          probe.packets.push({ generation: value.generation, time: value.time, rmsDbfs: value.rmsDbfs, peakDbfs: value.peakDbfs });
          if (probe.packets.length > 256) probe.packets.shift();
        });
        this.port.start();
      }
    };
  });
}

export async function renderOutputLevel(page: Page) {
  return page.evaluate(() => {
    const probe = (window as ProbeWindow).qaRenderOutput, last = probe?.packets.at(-1);
    return probe && last ? { ...last, sampleRate: probe.sampleRate } : null;
  });
}

export async function meanRenderOutput(page: Page) {
  // Qualify this known non-silent fixture without matching an expected level.
  await expect.poll(async () => (await renderOutputLevel(page))?.rmsDbfs ?? -Infinity).toBeGreaterThan(-70);
  const initial = await renderOutputLevel(page); if (!initial) throw new Error("Missing actual render output");
  await expect.poll(async () => (await renderOutputLevel(page))?.time ?? 0).toBeGreaterThan(initial.time + 1);
  const start = await renderOutputLevel(page); if (!start) throw new Error("Missing settled render output");
  await expect.poll(async () => (await renderOutputLevel(page))?.time ?? 0).toBeGreaterThan(start.time + 2);
  return page.evaluate(({ time, generation }) => {
    const probe = (window as ProbeWindow).qaRenderOutput; if (!probe) throw new Error("Missing render windows");
    const frames = Math.ceil(probe.sampleRate * .05 / 128) * 128;
    const needed = Math.ceil(2 * probe.sampleRate / frames);
    const packets = probe.packets.filter((packet) => packet.generation === generation && packet.time > time).slice(0, needed);
    if (packets.length !== needed) throw new Error("Missing captured render windows");
    for (let i = 1; i < packets.length; i++) {
      const difference = (packets.at(i)?.time ?? 0) - (packets.at(i - 1)?.time ?? 0);
      if (Math.abs(difference * probe.sampleRate - frames) > 1) throw new Error("Discontinuous render window timestamps");
    }
    return 10 * Math.log10(packets.reduce((sum, packet) => sum + Math.pow(10, packet.rmsDbfs / 10), 0) / packets.length);
  }, start);
}
