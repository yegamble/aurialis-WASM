/* Test-owned Playwright download paths never come from audio filenames. */
/* eslint-disable security/detect-non-literal-fs-filename */
// cspell:words requestfailed
import { readFile } from "node:fs/promises";
import { expect, test, type Request } from "@playwright/test";
import { decode, fixture } from "./audio-fixture";
import { uploadProject } from "./workflow-fixture";
import { kWeightedLevel, meanOutputLevel, observeOutput, outputLevel } from "./live-output";
type EngineWindow = Window & { qaEngineContext?: AudioContext };
for (const sourceRate of [44100, 48000, 96000]) {
  test(`engine qualification: ${String(sourceRate)} Hz source plays the export chain at its declared live rate`, async ({ page, browserName }, info) => {
    await observeOutput(page);
    await page.addInitScript(() => {
      const Native = AudioContext;
      window.AudioContext = class extends Native {
        constructor(options?: AudioContextOptions) { super(options); (window as EngineWindow).qaEngineContext = this; }
      };
    });
    await uploadProject(page, `engine-${String(sourceRate)}.wav`, 4, fixture(997, 4, sourceRate));
    await page.getByRole("slider", { name: "Input gain", exact: true }).fill("3");
    await page.getByRole("button", { name: "Export", exact: true }).click();
    const dialog = page.getByRole("dialog"); await dialog.getByRole("button", { name: "32-bit Float", exact: true }).click();
    const waiting = page.waitForEvent("download"); await dialog.getByRole("button", { name: "Render & download WAV", exact: true }).click();
    const path = await (await waiting).path(); if (!path) throw new Error("Missing real engine export");
    const pcm = decode(await readFile(path)); expect(pcm.rate).toBe(sourceRate); expect(pcm.left).toHaveLength(4 * sourceRate);
    const exportDb = kWeightedLevel(pcm.left, pcm.right, sourceRate, sourceRate);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Repeat track", exact: true }).click();
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await expect(page.locator(".transport")).toHaveAttribute("data-playing", "true", { timeout: 20_000 });
    const capabilities = await page.evaluate(() => {
      const context = (window as EngineWindow).qaEngineContext;
      if (!context) throw new Error("No real live AudioContext");
      return { userAgent: navigator.userAgent, isolated: crossOriginIsolated, shared: typeof SharedArrayBuffer === "function", worklet: typeof AudioWorkletNode === "function",
        mediaSession: "mediaSession" in navigator, sampleRate: context.sampleRate, state: context.state, outputLatency: context.outputLatency,
        playbackStats: "playbackStats" in context };
    });
    expect(capabilities.isolated && capabilities.shared && capabilities.worklet).toBe(true);
    expect(capabilities.state).toBe("running"); expect(capabilities.sampleRate).toBe(sourceRate === 96000 ? 48000 : sourceRate);
    await expect.poll(async () => (await outputLevel(page))?.frames ?? 0).toBeGreaterThan(capabilities.sampleRate);
    const liveDb = await meanOutputLevel(page, capabilities.sampleRate, "k");
    expect(Math.abs(liveDb - exportDb), `${browserName} actual speaker/export difference`).toBeLessThanOrEqual(sourceRate > 48000 ? 0.25 : 0.1);
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    await expect(page.locator(".transport")).toHaveAttribute("data-playing", "false");
    await info.attach("engine-capability-and-speaker-evidence", { body: JSON.stringify({ browserName, sourceRate, capabilities, exportDb, liveDb, deltaDb: liveDb - exportDb }), contentType: "application/json" });
  });
}


test("engine qualification: closing Export cancels the active native request or browser worker", async ({ page, context }, info) => {
  const browserBuild = info.project.metadata.executionTarget === "browser";
  await page.addInitScript(() => {
    const scope = window as Window & { qaCancelWorkers?: number }; scope.qaCancelWorkers = 0;
    const Native = Worker;
    window.Worker = class extends Native {
      private live = true;
      constructor(url: string | URL, options?: WorkerOptions) { super(url, options); scope.qaCancelWorkers = (scope.qaCancelWorkers ?? 0) + 1; }
      override terminate() { if (this.live) { this.live = false; scope.qaCancelWorkers = (scope.qaCancelWorkers ?? 1) - 1; } super.terminate(); }
    };
  });
  const id = await uploadProject(page, "engine-cancel.wav", 1);
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let capture: (request: Request) => void = () => undefined;
  const seen = new Promise<Request>((resolve) => { capture = resolve; });
  const pattern = browserBuild ? "**/wasm/aurialis-dsp.wasm" : "**/api/master/render";
  await context.route(pattern, async (route) => { capture(route.request()); await held; await route.abort("failed").catch(() => undefined); });
  try {
    await page.getByRole("button", { name: "Export", exact: true }).click();
    const dialog = page.getByRole("dialog"); await dialog.getByRole("button", { name: "Render & download WAV", exact: true }).click();
    const request = await seen;
    const stopped = browserBuild ? null : context.waitForEvent("requestfailed", (candidate) => candidate === request);
    await dialog.getByRole("button", { name: /^Close(?: dialog)?$/ }).click();
    if (stopped) await stopped;
    if (browserBuild) await expect.poll(() => page.evaluate(() => (window as Window & { qaCancelWorkers?: number }).qaCancelWorkers)).toBe(0);
    await expect(dialog).toBeHidden(); await expect(page).toHaveURL(new RegExp(`/master/${id}$`));
    await expect(page.getByRole("button", { name: "Export", exact: true })).toBeEnabled();
  } finally { release(); await context.unroute(pattern); }
});
