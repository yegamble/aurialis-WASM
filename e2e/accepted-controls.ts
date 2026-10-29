import { expect, type Page } from "@playwright/test";
import { acceptedControlPacket } from "../src/lib/playback-diagnostics";
type AcceptedWindow = Window & { qaAcceptedControls?: { version: number; values: number[] } };
/** Observe the real rendered APPLIED acknowledgement using the production stable-packet reader. */
export async function observeAcceptedControls(page: Page): Promise<void> {
  // The helper is pure and depends only on built-in typed arrays/Atomics. Install
  // that exact production function as a declaration, without eval or source patching.
  await page.addInitScript({ content: `window.qaReadAcceptedControls = ${acceptedControlPacket.toString()};` });
  await page.addInitScript(() => {
    type DiagnosticWindow = AcceptedWindow & { qaReadAcceptedControls: typeof acceptedControlPacket };
    const Native = AudioWorkletNode;
    window.AudioWorkletNode = class extends Native {
      constructor(context: BaseAudioContext, name: string, options?: AudioWorkletNodeOptions) {
        const config = options?.processorOptions as { header?: SharedArrayBuffer; controls?: SharedArrayBuffer } | undefined;
        super(context, name, name === "aurialis-live" ? { ...options, processorOptions: { ...config, diagnostics: true } } : options);
        if (name !== "aurialis-live" || !config?.header || !config.controls) return;
        const header = new Int32Array(config.header), controls = config.controls;
        this.port.addEventListener("message", (event: MessageEvent<{ type?: string }>) => {
          if (event.data.type !== "diagnostics") return;
          const scope = window as DiagnosticWindow;
          const accepted = scope.qaReadAcceptedControls(header, controls);
          // Clear a superseded packet while a newer version is still pending.
          if (accepted) scope.qaAcceptedControls = accepted;
          else delete scope.qaAcceptedControls;
        });
      }
    };
  });
}
export async function expectHeaviestAccepted(page: Page, algorithm: 2 | 3 = 2): Promise<{ version: number; values: number[] }> {
  await expect.poll(() => page.evaluate(() => (window as AcceptedWindow).qaAcceptedControls?.version ?? 0)).toBeGreaterThan(0);
  const accepted = await page.evaluate(() => (window as AcceptedWindow).qaAcceptedControls);
  if (!accepted) throw new Error("No Go-accepted controls");
  const values = accepted.values;
  expect(values).toHaveLength(82);
  // Independent ABI slots for every stage enabled by heaviestChain.
  expect({ input: values[3], eq: values[4], gains: [6, 11, 16, 21, 26].map((index) => values[index]), bands: [9, 14, 19, 24, 29].map((index) => values[index]),
    compressor: values[30], ratio: values[32], saturation: values[39], drive: values[40], width: values[43], stereo: values[42], monoBass: values[44],
    limiter: values[46], ceiling: values[47], truePeak: values[50], autoRelease: values[56], mid: values[57], side: values[58],
    deHarsh: values[59], multiband: values[63], multibandRatios: [67, 72, 77].map((index) => values[index]), algorithm: values[81] })
    .toEqual({ input: 6, eq: 1, gains: [2, 2, 2, 2, 2], bands: [1, 1, 1, 1, 1], compressor: 1, ratio: 3, saturation: 1, drive: 60, width: 130, stereo: 1, monoBass: 1,
      limiter: 1, ceiling: -1, truePeak: 1, autoRelease: 1, mid: 1, side: -1, deHarsh: 1, multiband: 1, multibandRatios: [3, 3, 3], algorithm });
  await expect(page.locator(".transport")).toHaveAttribute("data-applied-version", String(accepted.version));
  return accepted;
}
