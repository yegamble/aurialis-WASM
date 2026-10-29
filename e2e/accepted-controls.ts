import { expect, type Page } from "@playwright/test";
type AcceptedWindow = Window & { qaAcceptedControls?: { version: number; values: number[] } };
/** Observe only after the real Go kernel accepts the worklet's stable packet. */
export async function observeAcceptedControls(page: Page): Promise<void> {
  await page.route((url) => url.pathname === "/worklets/aurialis-live-worklet.js", async (route) => {
    const response = await route.fetch();
    const source = await response.text(), anchor = "this.controlVersion = version;";
    if (source.split(anchor).length !== 2) throw new Error("Update the accepted-control observer for the changed worklet.");
    await route.fulfill({ response, body: source.replace(anchor, `${anchor}\n    this.port.postMessage({ type: "qa-accepted-controls", version, values: Array.from(this.controls) });`) });
  });
  await page.addInitScript(() => {
    const Native = AudioWorkletNode;
    window.AudioWorkletNode = class extends Native {
      constructor(context: BaseAudioContext, name: string, options?: AudioWorkletNodeOptions) {
        super(context, name, options);
        if (name === "aurialis-live") this.port.addEventListener("message", (event: MessageEvent<{ type?: string; version: number; values: number[] }>) => {
          if (event.data.type === "qa-accepted-controls") (window as AcceptedWindow).qaAcceptedControls = { version: event.data.version, values: event.data.values };
        });
      }
    };
  });
}
export async function expectHeaviestAccepted(page: Page): Promise<void> {
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
      limiter: 1, ceiling: -1, truePeak: 1, autoRelease: 1, mid: 1, side: -1, deHarsh: 1, multiband: 1, multibandRatios: [3, 3, 3], algorithm: 2 });
  await expect(page.locator(".transport")).toHaveAttribute("data-applied-version", String(accepted.version));
}
