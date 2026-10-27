/* Test-owned Playwright download paths never come from audio filenames. */
/* eslint-disable security/detect-non-literal-fs-filename */
import { Buffer } from "node:buffer";
import { readFile, writeFile } from "node:fs/promises";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import type { Track } from "../src/lib/types";
import { decode } from "./audio-fixture";
import { kWeightedLevel, meanOutputEnergy, observeOutputEnergy, outputEnergyRate } from "./live-output";
import { denseFixture, uploadProject } from "./workflow-fixture";

// V1-10: live playback renders the export algorithm, so what is heard is what is exported.
const RATE = 48000, LOOP_SECONDS = 8, CEILING_DBTP = -1;
const SOAK_SECONDS = Number(process.env.AURIALIS_LIVE_SOAK_SECONDS ?? "30");
/** Audio-clock lag allowed: min(250 ms, 5 ms per audio second), 150 ms at
 * 30 s. Quiet-host runs lagged −4 to +2 ms in 30 s and under 40 ms in 600 s;
 * the worst run QA called clean lagged 234 ms in 150 s (1.6 ms/s). A kernel too
 * slow to keep up lags at (load − 1) s per second, 50 ms/s at a 1.05 load, and
 * the worklet's own deadline watch stops playback within about 3 s of that.
 * Host stalls on an overloaded machine (915 ms in 30 s at load average 65, with
 * 0 slow kernel calls) also fail it: rerun those. */
const DRIFT_MS_PER_AUDIO_SECOND = 5, DRIFT_MS_MAX = 250;

type Timing = { clock: string; resolutionMs: number; quanta: number; totalMs: number; maxMs: number; slow: number; maybeSlow: number; ringUnderruns: number; wallMs: number; audioMs: number; sampleRate: number };
type TimingWindow = Window & { qaTiming?: Timing };

/** Run the AudioContext at the 48 kHz source rate so live and export process the same samples. */
async function pinDeviceRate(page: Page): Promise<void> {
  await page.addInitScript((rate) => {
    const NativeContext = AudioContext;
    window.AudioContext = class extends NativeContext { constructor(options?: AudioContextOptions) { super({ ...options, sampleRate: rate }); } };
  }, RATE);
}

// Worklet-scope timing tap. Every 375 quanta it posts the kernel time, the
// ring underrun counter and how far the audio clock (currentFrame) trails the
// wall clock. Chromium exposes no performance.now in AudioWorkletGlobalScope,
// so the kernel is timed with Date.now's whole milliseconds unless a finer clock
// exists. A reading r then means a true time in (r - resolution, r + resolution):
// summed readings stay unbiased for the mean load, `maybeSlow` cannot miss a
// call over the 2.67 ms deadline (any reading of 2 ms or more at 48 kHz) and
// `slow` counts only calls certainly over it.
const TAP = `
const qaClock = typeof performance === "object" && typeof performance.now === "function" ? "performance" : "date";
const qaNow = qaClock === "performance" ? () => performance.now() : () => Date.now();
const qaResolution = qaClock === "performance" ? 0.1 : 1;
let qaQuanta = 0, qaTotal = 0, qaMax = 0, qaSlow = 0, qaMaybeSlow = 0, qaWallStart = 0, qaFrameStart = 0;
function qaTiming(processor, elapsed) {
  if (qaQuanta === 0) { qaWallStart = Date.now(); qaFrameStart = currentFrame; }
  const deadline = 1000 * QUANTUM / sampleRate;
  qaQuanta++; qaTotal += elapsed; qaMax = Math.max(qaMax, elapsed);
  if (elapsed - qaResolution > deadline) qaSlow++;
  if (elapsed + qaResolution > deadline) qaMaybeSlow++;
  if (qaQuanta % 375 === 0) processor.port.postMessage({ type: "qa-timing", clock: qaClock, resolutionMs: qaResolution, quanta: qaQuanta, totalMs: qaTotal, maxMs: qaMax,
    slow: qaSlow, maybeSlow: qaMaybeSlow, ringUnderruns: Atomics.load(processor.header, UNDERRUNS), wallMs: Date.now() - qaWallStart,
    audioMs: (currentFrame + QUANTUM - qaFrameStart) * 1000 / sampleRate, sampleRate });
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

/** The dense loop twice in one 16-bit WAV. Its second copy follows the loop's
 * own end, as every pass of a repeating live loop does, so the export's second
 * half and a whole live loop share the compressor and limiter state; one cold
 * pass against a warm loop differed by up to 0.13 LU. */
function twoLoops(sourceRate: number): Buffer {
  const once = denseFixture(LOOP_SECONDS, -1.3, sourceRate), data = once.subarray(44);
  const wav = Buffer.concat([once.subarray(0, 44), data, data]);
  wav.writeUInt32LE(wav.length - 8, 4); wav.writeUInt32LE(2 * data.length, 40);
  return wav;
}

// Only so the test-only audio-thread taps (output energy, kernel timing) can load
// from blob URLs; the app's own CSP is unchanged.
test.use({ bypassCSP: true });

/** One whole loop of K-weighted speaker output and the live TP meter against
 * the exported 32-bit float WAV of the heaviest chain, both past a full loop of warm-up. */
async function liveAgainstExport(page: Page, info: TestInfo, sourceRate: number, limits = { lu: 0.1, tp: 0.1 }) {
  await observeOutputEnergy(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await uploadProject(page, `live-export-${String(sourceRate)}.wav`, 2 * LOOP_SECONDS, twoLoops(sourceRate));
  await heaviestChain(page);

  const exported = await exportFloat(page);
  const pcm = decode(exported.wav);
  expect(pcm.rate).toBe(sourceRate);
  expect(pcm.left.length).toBe(2 * LOOP_SECONDS * sourceRate);
  const exportLevel = kWeightedLevel(pcm.left, pcm.right, sourceRate, LOOP_SECONDS * sourceRate);
  const deliveredPeak = Number(/Delivered true peak (-?\d+\.\d+) dBTP/u.exec(exported.status)?.[1]);
  expect(Number.isFinite(deliveredPeak), exported.status).toBe(true);

  await page.getByRole("button", { name: "Repeat track", exact: true }).click();
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(page.locator(".transport")).toHaveAttribute("data-playing", "true");
  // One whole loop of K-weighted speaker output, once the first copy has warmed the chain.
  await page.waitForTimeout(LOOP_SECONDS * 1000);
  const contextRate = await outputEnergyRate(page);
  const liveLevel = await meanOutputEnergy(page, LOOP_SECONDS * contextRate);
  const meter = page.locator(".metric-strip > div").filter({ hasText: "True peak" }).locator("strong");
  const liveTruePeak = Number((await meter.innerText()).replace("−", "-"));
  const resampledNote = await page.getByText(/so live A is resampled before processing/u).count();
  await page.getByRole("button", { name: "Pause", exact: true }).click();

  const evidence = { sourceRate, contextRate, loopSeconds: LOOP_SECONDS, liveLevelDb: liveLevel, exportLevelDb: exportLevel, deltaLu: liveLevel - exportLevel,
    liveTruePeakMeterDbtp: liveTruePeak, exportDeliveredTruePeakDbtp: deliveredPeak, ceilingDbtp: CEILING_DBTP, resampledNote };
  await writeFile(info.outputPath("live-export-evidence.json"), JSON.stringify(evidence, null, 2));
  await info.attach("live-export-evidence", { body: JSON.stringify(evidence), contentType: "application/json" });
  // What you hear as A is what you export: same loudness, and the live meter
  // reads no hotter than the delivered file.
  expect(Math.abs(evidence.deltaLu), JSON.stringify(evidence)).toBeLessThanOrEqual(limits.lu);
  expect(liveTruePeak, JSON.stringify(evidence)).toBeLessThanOrEqual(deliveredPeak + limits.tp);
  return evidence;
}

test("live playback at the speakers matches the exported WAV in loudness and true peak", async ({ page }, info) => {
  test.setTimeout(150_000);
  await pinDeviceRate(page);
  const evidence = await liveAgainstExport(page, info, RATE);
  // Ceiling compliance of the export itself is V1-13's gate; at 48 kHz this
  // dense loop meets it, so the live meter must too.
  expect(evidence.exportDeliveredTruePeakDbtp, JSON.stringify(evidence)).toBeLessThanOrEqual(CEILING_DBTP);
  expect(evidence.liveTruePeakMeterDbtp, JSON.stringify(evidence)).toBeLessThanOrEqual(CEILING_DBTP + 0.1);
  expect(Math.abs(evidence.liveTruePeakMeterDbtp - evidence.exportDeliveredTruePeakDbtp), JSON.stringify(evidence)).toBeLessThanOrEqual(0.15);
});

// Round E: nothing pins the context. The stub stands in for a device at another
// rate by changing only the browser's default; the app must ask for the source
// rate so the engine processes the samples the export processes.
for (const [sourceRate, deviceRate] of [[48000, 44100], [44100, 48000]] as const) {
  test(`a ${String(sourceRate / 1000)} kHz source on a ${String(deviceRate / 1000)} kHz device plays A at the source rate and matches the export`, async ({ page }, info) => {
    test.setTimeout(150_000);
    await page.addInitScript((rate) => {
      const NativeContext = AudioContext;
      window.AudioContext = class extends NativeContext { constructor(options?: AudioContextOptions) { super({ sampleRate: rate, ...options }); } };
    }, deviceRate);
    const evidence = await liveAgainstExport(page, info, sourceRate);
    expect(evidence.contextRate, JSON.stringify(evidence)).toBe(sourceRate);
    expect(evidence.resampledNote, JSON.stringify(evidence)).toBe(0);
  });
}

// Above 48 kHz live playback is capped at an integer ratio to stay inside the
// 3x CPU budget (V1-10 Round E 2), even on an interface at the source's rate;
// the export keeps the source rate. Measured (two runs each, heaviest chain):
// 96→48 kHz ΔLU +0.174, live TP −1.2 against the export's −1.08 dBTP; 88.2→44.1
// kHz ΔLU +0.139, −1.0 against −1.24. The note says live may differ; these
// bounds only catch a regression beyond that.
for (const [sourceRate, liveRate] of [[96000, 48000], [88200, 44100]] as const) {
  test(`a ${String(sourceRate / 1000)} kHz source plays live at ${String(liveRate / 1000)} kHz and says why`, async ({ page }, info) => {
    test.setTimeout(180_000);
    await page.addInitScript((rate) => {
      const NativeContext = AudioContext;
      window.AudioContext = class extends NativeContext { constructor(options?: AudioContextOptions) { super({ sampleRate: rate, ...options }); } };
    }, sourceRate);
    const evidence = await liveAgainstExport(page, info, sourceRate, { lu: 0.25, tp: 0.35 });
    expect(evidence.contextRate, JSON.stringify(evidence)).toBe(liveRate);
    expect(evidence.resampledNote, JSON.stringify(evidence)).toBe(0);
    await expect(page.getByText(`Aurialis plays this ${String(sourceRate / 1000)} kHz source at ${String(liveRate / 1000)} kHz to stay within its live CPU budget; the export keeps the source's ${String(sourceRate / 1000)} kHz.`, { exact: true })).toBeVisible();
  });
}

// A browser that cannot open the source rate: playback still works at the
// device rate, and the page says plainly that live A is resampled. Measured on
// this fallback, 48 kHz on 44.1 kHz drifts −0.13 LU and its live meter reads
// −0.8 against the export's −1.24 dBTP, which is why the claim is conditioned.
test("a rejected source rate falls back to the device rate with a visible resampling note", async ({ page }) => {
  await page.addInitScript(() => {
    const NativeContext = AudioContext;
    window.AudioContext = class extends NativeContext {
      constructor(options?: AudioContextOptions) {
        if (options?.sampleRate !== undefined) throw new DOMException("The sample rate is not supported.", "NotSupportedError");
        super({ ...options, sampleRate: 44100 });
      }
    };
  });
  await observeOutputEnergy(page);
  await uploadProject(page, "live-fallback.wav");
  await expect(page.getByText(/so live A is resampled/u)).toHaveCount(0);
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(page.locator(".transport")).toHaveAttribute("data-playing", "true");
  expect(await outputEnergyRate(page)).toBe(44100);
  await expect(page.getByText("This device plays A at 44.1 kHz, not the source's 48 kHz, so live A is resampled before processing and may differ slightly from the export.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Pause", exact: true }).click();
});

// Real overload (V1-10 Round E 2), with no test hook in the worklet: forcing the
// context to 192 kHz makes the unmodified heaviest chain cost about four times
// its 48 kHz load (0.4–0.5 here), so the render thread cannot keep up and the
// deadline watch must stop playback with a message naming the cause, not a
// buffer fault. DevTools Emulation.setCPUThrottlingRate cannot do this: at 20x
// the worklet's kernel load stayed 0.47 with no clock lag, because it throttles
// the renderer's main thread, not the AudioWorklet thread.
const OVERLOAD = "Playback can't keep up on this device with the current processing. Turn off some processing modules, or close other busy apps or tabs, then press Play.";
test("an overloaded render thread stops playback with the can't-keep-up message", async ({ page }) => {
  test.setTimeout(180_000);
  await page.addInitScript(() => {
    const NativeContext = AudioContext;
    window.AudioContext = class extends NativeContext { constructor(options?: AudioContextOptions) { super({ ...options, sampleRate: 192000 }); } };
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await uploadProject(page, "live-overload.wav", LOOP_SECONDS, "dense");
  await heaviestChain(page);
  await page.getByRole("button", { name: "Repeat track", exact: true }).click();
  await page.getByRole("button", { name: "Play", exact: true }).click();
  const transport = page.locator(".transport");
  await expect(page.getByText(OVERLOAD, { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(transport).toHaveAttribute("data-playing", "false");
  await expect(page.getByText(/buffer fault/u)).toHaveCount(0);
});

test.describe("sustained live playback", () => {
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
    clockDriftMs: timing.wallMs - timing.audioMs, driftLimitMs: Math.min(DRIFT_MS_MAX, DRIFT_MS_PER_AUDIO_SECOND * timing.audioMs / 1000) };
  await writeFile(info.outputPath("live-soak-evidence.json"), JSON.stringify(evidence, null, 2));
  await info.attach("live-soak-evidence", { body: JSON.stringify(evidence), contentType: "application/json" });
  expect(timing.sampleRate).toBe(RATE);
  // No kernel call certainly over its 2.67 ms deadline, and the audio clock kept
  // pace with the wall clock (a render thread that falls behind makes it lag).
  // ringUnderruns stays in the evidence but is not a CPU gauge: the kernel runs
  // inside process(), so the ring cannot run dry from load (it is always 0 here).
  expect(timing.slow, JSON.stringify(evidence)).toBe(0);
  expect(Math.abs(evidence.clockDriftMs), JSON.stringify(evidence)).toBeLessThanOrEqual(evidence.driftLimitMs);
  // The 3x budget is measured on a quiet machine (docs/tasks.md V1-10). Shared CI
  // and agent hosts swing 2x, so this only catches gross regressions.
  expect(evidence.meanLoad, JSON.stringify(evidence)).toBeLessThanOrEqual(0.75);
});
});
