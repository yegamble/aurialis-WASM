/* Test-owned Playwright download paths never come from audio filenames. */
/* eslint-disable security/detect-non-literal-fs-filename */
import { readFile, writeFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import type { Track } from "../src/lib/types";
import { decode } from "./audio-fixture";
import { kWeightedLevel, meanOutputLevel, observeOutput } from "./live-output";
import { uploadProject } from "./workflow-fixture";

// V1-10: live playback renders the export algorithm, so what is heard is what is exported.
const RATE = 48000, LOOP_SECONDS = 8, CEILING_DBTP = -1;
const SOAK_SECONDS = Number(process.env.AURIALIS_LIVE_SOAK_SECONDS ?? "30");

type Timing = { clock: string; quanta: number; totalMs: number; maxMs: number; slow: number; ringUnderruns: number; wallMs: number; audioMs: number; sampleRate: number };
type TimingWindow = Window & { qaTiming?: Timing };

/** Run the AudioContext at the 48 kHz source rate so live and export process the same samples. */
async function pinDeviceRate(page: Page): Promise<void> {
  await page.addInitScript((rate) => {
    const NativeContext = AudioContext;
    window.AudioContext = class extends NativeContext { constructor(options?: AudioContextOptions) { super({ ...options, sampleRate: rate }); } };
  }, RATE);
}

// Worklet-scope timing tap. Every 375 quanta it posts the kernel time, the
// ring underrun counter and how far the audio clock trails the wall clock.
const TAP = `
const qaClock = typeof performance === "object" && typeof performance.now === "function" ? "performance" : "date";
const qaNow = qaClock === "performance" ? () => performance.now() : () => Date.now();
let qaQuanta = 0, qaTotal = 0, qaMax = 0, qaSlow = 0, qaWallStart = 0, qaAudioStart = 0;
function qaTiming(processor, elapsed) {
  if (qaQuanta === 0) { qaWallStart = Date.now(); qaAudioStart = currentTime; }
  qaQuanta++; qaTotal += elapsed; qaMax = Math.max(qaMax, elapsed);
  if (elapsed > 1000 * QUANTUM / sampleRate) qaSlow++;
  if (qaQuanta % 375 === 0) processor.port.postMessage({ type: "qa-timing", clock: qaClock, quanta: qaQuanta, totalMs: qaTotal, maxMs: qaMax, slow: qaSlow,
    ringUnderruns: Atomics.load(processor.header, UNDERRUNS), wallMs: Date.now() - qaWallStart, audioMs: (currentTime - qaAudioStart) * 1000, sampleRate });
}`;

/** Test-only: load the real worklet with its Go kernel call timed. No DSP is
 * replaced. Worklet module fetches bypass Playwright routing, so addModule
 * loads a patched copy from a blob URL; the caller must set bypassCSP. */
async function timeWorklet(page: Page): Promise<void> {
  const call = "if (this.kernel.aurialis_live_process() !== QUANTUM)\n        throw new Error(\"The live audio engine rejected an audio block.\");";
  await page.addInitScript(({ tap, render }) => {
    const nativeAddModule = AudioWorklet.prototype.addModule;
    AudioWorklet.prototype.addModule = async function (this: AudioWorklet, url: string | URL, options?: WorkletOptions) {
      const href = new URL(url, location.href);
      if (!href.pathname.endsWith("/worklets/aurialis-live-worklet.js")) return nativeAddModule.call(this, url, options);
      const source = await (await fetch(href)).text(), host = "from \"./aurialis-wasi-host.js\"";
      if (!source.includes(render) || !source.includes("const QUANTUM = 128;") || !source.includes(host)) throw new Error("The worklet changed; update the timing tap.");
      const timed = source.replace(host, `from "${new URL("./aurialis-wasi-host.js", href).href}"`)
        .replace("const QUANTUM = 128;", `const QUANTUM = 128;${tap}`)
        .replace(render, `const qaStart = qaNow();\n      ${render}\n      qaTiming(this, qaNow() - qaStart);`);
      const blob = URL.createObjectURL(new Blob([timed], { type: "text/javascript" }));
      try { await nativeAddModule.call(this, blob, options); } finally { URL.revokeObjectURL(blob); }
    };
  }, { tap: TAP, render: call });
  await page.addInitScript(() => {
    const NativeNode = AudioWorkletNode;
    window.AudioWorkletNode = class extends NativeNode {
      constructor(context: BaseAudioContext, name: string, options?: AudioWorkletNodeOptions) {
        super(context, name, options);
        this.port.addEventListener("message", (event: MessageEvent<{ type?: string }>) => {
          if (event.data.type === "qa-timing") (window as TimingWindow).qaTiming = event.data as unknown as Timing;
        });
      }
    };
  });
}

/** Every module the UI can enable together, saved before reload like a returning project. */
async function heaviestChain(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem("aurialis-state-v1") ?? "{}") as { tracks: Track[] };
    const advanced = state.tracks[0]?.advanced; if (!advanced) throw new Error("Missing uploaded track");
    advanced.input = 6;
    advanced.eqBands = advanced.eqBands.map((band) => ({ ...band, gainDb: 2 }));
    advanced.deHarsh = { ...advanced.deHarsh, enabled: true, thresholdDb: -30, rangeDb: 6 };
    advanced.multiband = { ...advanced.multiband, enabled: true, bands: advanced.multiband.bands.map((band) => ({ ...band, thresholdDb: -24, ratio: 3 })) as typeof advanced.multiband.bands };
    advanced.compressor = { ...advanced.compressor, enabled: true, threshold: -20, ratio: 3, autoRelease: true };
    advanced.saturationModule = { enabled: true, drive: 60, character: "Tube" };
    advanced.stereo = { ...advanced.stereo, enabled: true, width: 130, monoBass: true, midGainDb: 1, sideGainDb: -1 };
    advanced.limiter = { ...advanced.limiter, enabled: true, ceiling: -1 };
    localStorage.setItem("aurialis-state-v1", JSON.stringify(state));
  });
  await page.reload();
  await expect(page.getByRole("button", { name: "A Processed", exact: true })).toBeEnabled({ timeout: 30_000 });
  await expect(page.getByRole("slider", { name: "Input gain", exact: true })).toHaveValue("6");
  await expect(page.getByRole("checkbox", { name: "Enable limiter", exact: true })).toBeChecked();
}

async function exportFloat(page: Page): Promise<{ wav: Buffer; status: string }> {
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "32-bit Float", exact: true }).click();
  const pending = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Render & download WAV", exact: true }).click();
  const download = await pending;
  expect(await download.failure()).toBeNull();
  const path = await download.path();
  if (!path) throw new Error("Missing export download");
  await expect(dialog.getByRole("status")).toContainText("Exported");
  const status = await dialog.getByRole("status").innerText();
  await page.keyboard.press("Escape");
  return { wav: await readFile(path), status };
}

test("live playback at the speakers matches the exported WAV in loudness and true peak", async ({ page }, info) => {
  test.setTimeout(150_000);
  await pinDeviceRate(page); await observeOutput(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await uploadProject(page, "live-export.wav", LOOP_SECONDS, "dense");
  await heaviestChain(page);

  const exported = await exportFloat(page);
  const pcm = decode(exported.wav);
  expect(pcm.rate).toBe(RATE);
  const exportLevel = kWeightedLevel(pcm.left, pcm.right, RATE);
  const deliveredPeak = Number(/Delivered true peak (-?\d+\.\d+) dBTP/u.exec(exported.status)?.[1]);
  expect(deliveredPeak).toBeLessThanOrEqual(CEILING_DBTP);

  await page.getByRole("button", { name: "Repeat track", exact: true }).click();
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(page.locator(".transport")).toHaveAttribute("data-playing", "true");
  // One whole loop of K-weighted speaker output, after the chain has settled.
  await page.waitForTimeout(1000);
  const liveLevel = await meanOutputLevel(page, LOOP_SECONDS * RATE, "k");
  const meter = page.locator(".metric-strip > div").filter({ hasText: "True peak" }).locator("strong");
  const liveTruePeak = Number((await meter.innerText()).replace("−", "-"));
  await page.getByRole("button", { name: "Pause", exact: true }).click();

  const evidence = { rate: RATE, loopSeconds: LOOP_SECONDS, liveLevelDb: liveLevel, exportLevelDb: exportLevel, deltaLu: liveLevel - exportLevel,
    liveTruePeakMeterDbtp: liveTruePeak, exportDeliveredTruePeakDbtp: deliveredPeak, ceilingDbtp: CEILING_DBTP };
  await writeFile(info.outputPath("live-export-evidence.json"), JSON.stringify(evidence, null, 2));
  await info.attach("live-export-evidence", { body: JSON.stringify(evidence), contentType: "application/json" });
  expect(Math.abs(evidence.deltaLu), JSON.stringify(evidence)).toBeLessThanOrEqual(0.1);
  expect(liveTruePeak, JSON.stringify(evidence)).toBeLessThanOrEqual(CEILING_DBTP + 0.1);
  expect(Math.abs(liveTruePeak - deliveredPeak), JSON.stringify(evidence)).toBeLessThanOrEqual(0.15);
});

test.describe("sustained live playback", () => {
// Only so the timing tap can load from a blob URL; the app's own CSP is unchanged.
test.use({ bypassCSP: true });
test(`the export algorithm keeps up live for ${String(SOAK_SECONDS)} s with every module on`, async ({ page }, info) => {
  test.setTimeout(SOAK_SECONDS * 1000 + 120_000);
  await pinDeviceRate(page); await timeWorklet(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await uploadProject(page, "live-soak.wav", LOOP_SECONDS, "dense");
  await heaviestChain(page);
  await page.getByRole("button", { name: "Repeat track", exact: true }).click();
  await page.getByRole("button", { name: "Play", exact: true }).click();
  const transport = page.locator(".transport");
  await expect(transport).toHaveAttribute("data-playing", "true");
  await expect.poll(() => page.evaluate(() => (window as TimingWindow).qaTiming?.audioMs ?? 0), { intervals: [1000], timeout: SOAK_SECONDS * 1000 + 60_000 })
    .toBeGreaterThanOrEqual(SOAK_SECONDS * 1000);
  await expect(transport).toHaveAttribute("data-playing", "true");
  const timing = await page.evaluate(() => (window as TimingWindow).qaTiming);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  if (!timing) throw new Error("Missing worklet timing");
  const quantumMs = 1000 * 128 / timing.sampleRate;
  const evidence = { ...timing, meanKernelMs: timing.totalMs / timing.quanta, meanLoad: timing.totalMs / timing.quanta / quantumMs, quantumMs,
    clockDriftMs: timing.wallMs - timing.audioMs };
  await writeFile(info.outputPath("live-soak-evidence.json"), JSON.stringify(evidence, null, 2));
  await info.attach("live-soak-evidence", { body: JSON.stringify(evidence), contentType: "application/json" });
  expect(timing.sampleRate).toBe(RATE);
  // No underrun: every quantum's output was ready, and the audio clock kept pace
  // with the wall clock (a render thread that falls behind makes it lag).
  expect(timing.ringUnderruns, JSON.stringify(evidence)).toBe(0);
  expect(Math.abs(evidence.clockDriftMs), JSON.stringify(evidence)).toBeLessThanOrEqual(250);
  // The 3x budget is measured on a quiet machine (docs/tasks.md V1-10). Shared CI
  // and agent hosts swing 2x, so this only catches gross regressions.
  expect(evidence.meanLoad, JSON.stringify(evidence)).toBeLessThanOrEqual(0.75);
});
});
