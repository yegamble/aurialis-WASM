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
 * the overload stop (playbackStats, else the worklet's watch) follows within
 * about 5–6 s (measured 4.9–5.5 s in e2e/live-overload.spec.ts).
 * Host stalls on an overloaded machine (915 ms in 30 s at load average 65, with
 * 0 slow kernel calls) also fail it: rerun those. */
const DRIFT_MS_PER_AUDIO_SECOND = 5, DRIFT_MS_MAX = 250;

type Timing = { clock: string; resolutionMs: number; quanta: number; totalMs: number; maxMs: number; slow: number; maybeSlow: number; ringUnderruns: number; wallMs: number; audioMs: number; sampleRate: number;
  /** Largest and smallest audio-clock lag over a 2 s window: callback jitter, the deadline watch's noise floor. */
  windowLagMaxMs: number; windowLagMinMs: number };
type TimingWindow = Window & { qaTiming?: Timing };

/** Run the AudioContext at the 48 kHz source rate so live and export process the same samples. */
async function pinDeviceRate(page: Page): Promise<void> {
  await page.addInitScript((rate) => {
    const NativeContext = AudioContext;
    window.AudioContext = class extends NativeContext { constructor(options?: AudioContextOptions) { super({ ...options, sampleRate: rate }); (window as StatsWindow).qaContext = this; } };
  }, RATE);
}
type StatsWindow = Window & { qaContext?: AudioContext };
/** Chromium's device underrun counter for the live context, or null elsewhere. */
function underrunEvents(page: Page): Promise<number | null> {
  return page.evaluate(() => {
    const stats: unknown = (window as StatsWindow).qaContext ? Reflect.get((window as StatsWindow).qaContext as object, "playbackStats") : undefined;
    const events: unknown = typeof stats === "object" && stats !== null ? Reflect.get(stats, "underrunEvents") : undefined;
    return typeof events === "number" ? events : null;
  });
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
let qaWindowWall = 0, qaWindowFrame = 0, qaWindows = 0, qaWindowLagMax = -Infinity, qaWindowLagMin = Infinity;
function qaTiming(processor, elapsed) {
  if (qaQuanta === 0) { qaWallStart = qaWindowWall = Date.now(); qaFrameStart = qaWindowFrame = currentFrame; }
  // Audio-clock lag over each 2 s window, the deadline watch's measure (first window skipped as warm-up).
  if (currentFrame - qaWindowFrame >= 2 * sampleRate) {
    const lag = Date.now() - qaWindowWall - (currentFrame - qaWindowFrame) * 1000 / sampleRate;
    if (++qaWindows > 1) { qaWindowLagMax = Math.max(qaWindowLagMax, lag); qaWindowLagMin = Math.min(qaWindowLagMin, lag); }
    qaWindowWall = Date.now(); qaWindowFrame = currentFrame;
  }
  const deadline = 1000 * QUANTUM / sampleRate;
  qaQuanta++; qaTotal += elapsed; qaMax = Math.max(qaMax, elapsed);
  if (elapsed - qaResolution > deadline) qaSlow++;
  if (elapsed + qaResolution > deadline) qaMaybeSlow++;
  if (qaQuanta % 375 === 0) processor.port.postMessage({ type: "qa-timing", clock: qaClock, resolutionMs: qaResolution, quanta: qaQuanta, totalMs: qaTotal, maxMs: qaMax,
    slow: qaSlow, maybeSlow: qaMaybeSlow, ringUnderruns: Atomics.load(processor.header, UNDERRUNS), wallMs: Date.now() - qaWallStart,
    audioMs: (currentFrame + QUANTUM - qaFrameStart) * 1000 / sampleRate, sampleRate, windowLagMaxMs: qaWindowLagMax, windowLagMinMs: qaWindowLagMin });
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
  // Every stage it enables must still be on after reload (Round 7 P2-4), as the
  // project the live chain was built from saved it.
  const loaded = await page.evaluate(() => (JSON.parse(localStorage.getItem("aurialis-state-v1") ?? "{}") as { tracks: Track[] }).tracks[0]?.advanced);
  expect(loaded, "the reloaded project").toBeDefined();
  expect({
    eq: loaded?.eqEnabled !== false && loaded?.eqBands.every((band) => band.enabled !== false && band.gainDb === 2),
    deHarsh: loaded?.deHarsh.enabled, multiband: loaded?.multiband.enabled, compressor: loaded?.compressor.enabled,
    autoRelease: loaded?.compressor.autoRelease, saturation: loaded?.saturationModule.enabled && loaded.saturationModule.drive === 60,
    stereo: loaded?.stereo.enabled && loaded.stereo.width === 130, monoBass: loaded?.stereo.monoBass, limiter: loaded?.limiter.enabled,
  }).toEqual({ eq: true, deHarsh: true, multiband: true, compressor: true, autoRelease: true, saturation: true, stereo: true, monoBass: true, limiter: true });
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
// real-worklet CPU budget (mean load ≤ 0.5; V1-10 Round E 2), even on an
// interface at the source's rate; the export keeps the source rate. Measured
// (heaviest chain): 96→48 kHz ΔLU +0.17, live TP −1.2 against the export's
// −1.08 dBTP; 88.2→44.1 kHz ΔLU +0.14, −1.0 against −1.24. Owner ruling
// (2026-10-27): capped live is disclosed (ΔLU ≤ 0.25, TP ≤ ceiling + 0.1), and
// Audition export plays the exact export (e2e/audition-export.spec.ts).
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
    expect(evidence.liveTruePeakMeterDbtp, JSON.stringify(evidence)).toBeLessThanOrEqual(CEILING_DBTP + 0.1);
    await expect(page.getByText(`Aurialis plays this ${String(sourceRate / 1000)} kHz source live at ${String(liveRate / 1000)} kHz to stay within its live CPU budget, so live A may differ slightly from the export (about 0.2 LU). Use Audition export for an exact listen; the export keeps the source's ${String(sourceRate / 1000)} kHz.`, { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Audition export", exact: true })).toBeVisible();
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
  // The 1 s source would end before a loaded host reaches Pause; loop it.
  await page.getByRole("button", { name: "Repeat track", exact: true }).click();
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(page.locator(".transport")).toHaveAttribute("data-playing", "true");
  expect(await outputEnergyRate(page)).toBe(44100);
  await expect(page.getByText("This device plays A at 44.1 kHz, not the source's 48 kHz, so live A is resampled before processing and may differ slightly from the export (about 0.2 LU). Use Audition export for an exact listen.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Audition export", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Pause", exact: true }).click();
});

const OVERLOAD = "Playback can't keep up on this device with the current processing. Turn off some processing modules, or close other busy apps or tabs, then press Play.";

// Load outside the kernel (V1-10 Round 4): a test-only "burner" AudioWorkletNode
// in the same context busy-waits on the same render thread, while the app's
// worklet and kernel are untouched. A share spins a fraction of every 128-frame
// quantum. A first estimate comes from the main thread (calibrating in the
// constructor stalled the render thread at start, Round 8), started low at 0.6
// of it; then the processor itself times its spin on the render thread every
// 375 quanta (1 s) and corrects toward the target share, since the main-thread
// estimate read 0.45–0.62 for a 0.3 target there (QA E8). A negative share
// instead spins until Date.now has moved that many milliseconds, which
// overloads any CPU. (A forced 192 kHz context was dropped:
// whether it overloads depends on the runner, and CI's did not.)
const BURNER = `class QaBurner extends AudioWorkletProcessor {
  constructor(options) {
    super(); this.share = options.processorOptions.share; this.perMs = options.processorOptions.perMs * 0.6;
    this.sink = 0; this.spent = 0; this.quanta = 0;
  }
  process() {
    if (this.share < 0) { const start = Date.now(); while (Date.now() - start < -this.share) {} return true; }
    const quantumMs = 1000 * 128 / sampleRate;
    const count = this.share * quantumMs * this.perMs, start = Date.now();
    let sink = this.sink; for (let i = 0; i < count; i++) sink += Math.sqrt(i + sink % 7);
    this.sink = sink;
    // Achieved spin per 1 s window, summed in Date.now ticks (unbiased over many
    // quanta), and the correction toward the target share.
    this.spent += Date.now() - start;
    if (++this.quanta === 375) {
      const achieved = this.spent / (this.quanta * quantumMs);
      // Damped (square root) so one noisy window cannot swing the next.
      if (achieved > 0) this.perMs *= Math.sqrt(Math.max(0.25, Math.min(4, this.share / achieved)));
      this.port.postMessage({ share: achieved, perMs: this.perMs });
      this.spent = 0; this.quanta = 0;
    }
    return true;
  }
}
registerProcessor("qa-burner", QaBurner);`;
async function burn(page: Page, share: number): Promise<void> {
  await page.addInitScript(({ source, extra }) => {
    const nativeConnect = AudioNode.prototype.connect;
    const burning = new WeakSet<BaseAudioContext>();
    function connect(this: AudioNode, destination: AudioNode, output?: number, input?: number): AudioNode;
    function connect(this: AudioNode, destination: AudioParam, output?: number): void;
    function connect(this: AudioNode, destination: AudioNode | AudioParam, ...ports: (number | undefined)[]): AudioNode | void {
      const result: unknown = Reflect.apply(nativeConnect, this, [destination, ...ports]);
      const context = this.context;
      if (destination instanceof AudioDestinationNode && !burning.has(context)) {
        burning.add(context);
        const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
        void context.audioWorklet.addModule(url).finally(() => { URL.revokeObjectURL(url); }).then(() => {
          let perMs = 0, sink = 0;
          for (let pass = 0; pass < 2; pass++) {
            let iterations = 0; const start = Date.now();
            while (Date.now() - start < 100) { for (let i = 0; i < 1000; i++) sink += Math.sqrt(i + sink % 7); iterations += 1000; }
            perMs = iterations / (Date.now() - start);
          }
          const burner = new AudioWorkletNode(context, "qa-burner", { numberOfInputs: 0, numberOfOutputs: 1, processorOptions: { share: extra, perMs: perMs + sink * 0 } });
          burner.port.onmessage = (event: MessageEvent<{ share: number; perMs: number }>) => { const scope = window as Window & { qaBurner?: { share: number; perMs: number }[] }; (scope.qaBurner ??= []).push(event.data); };
          const silent = context.createGain(); silent.gain.value = 0;
          Reflect.apply(nativeConnect, burner, [silent]); Reflect.apply(nativeConnect, silent, [context.destination]);
        });
      }
      return result instanceof AudioNode ? result : undefined;
    }
    AudioNode.prototype.connect = connect;
  }, { source: BURNER, extra: share });
}
async function playHeaviest(page: Page, name: string): Promise<void> {
  await pinDeviceRate(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await uploadProject(page, name, LOOP_SECONDS, "dense");
  await heaviestChain(page);
  await page.getByRole("button", { name: "Repeat track", exact: true }).click();
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(page.locator(".transport")).toHaveAttribute("data-playing", "true");
}

test("load outside the kernel past real time (a burner spinning 2–3 ms of each 2.67 ms quantum) fires the can't-keep-up message at 48 kHz", async ({ page }) => {
  test.setTimeout(150_000);
  await burn(page, -3);
  await playHeaviest(page, "live-burner-hot.wav");
  await expect(page.getByText(OVERLOAD, { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(page.locator(".transport")).toHaveAttribute("data-playing", "false");
});

// S-6 (Round 5): the same marginal overload where playbackStats is missing
// (Firefox, Safari) must be caught by the worklet's own lag and slack rules.
test("without playbackStats, the same burner still fires the can't-keep-up message", async ({ page }) => {
  test.setTimeout(150_000);
  await page.addInitScript(() => { Object.defineProperty(AudioContext.prototype, "playbackStats", { configurable: true, get: () => undefined }); });
  await burn(page, -3);
  await playHeaviest(page, "live-burner-fallback.wav");
  await expect(page.getByText(OVERLOAD, { exact: true })).toBeVisible({ timeout: 60_000 });
  await expect(page.locator(".transport")).toHaveAttribute("data-playing", "false");
});

test("a burner at +0.3 of each quantum stays under real time and plays 30 s with no message", async ({ page }) => {
  test.setTimeout(150_000);
  await burn(page, 0.3);
  await playHeaviest(page, "live-burner-warm.wav");
  await page.waitForTimeout(30_000);
  // The burner really spun about 0.3 of each quantum on the render thread (QA E8).
  // Mean over the last 10 one-second windows, once the correction has settled.
  const windows = await page.evaluate(() => (window as Window & { qaBurner?: { share: number; perMs: number }[] }).qaBurner ?? []);
  const last = windows.slice(-10), achieved = last.reduce((sum, window) => sum + window.share, 0) / Math.max(1, last.length);
  test.info().annotations.push({ type: "burner-share", description: achieved.toFixed(3) });
  console.log(`burner achieved share ${achieved.toFixed(3)} over ${String(windows.length)} windows (first ${windows[0]?.share.toFixed(3) ?? "none"})`);
  // The correction loop ran (Round 8c): many windows reported, the share moved
  // from its first reading, and the spin rate was adjusted.
  expect(windows.length, "burner windows reported").toBeGreaterThan(10);
  expect(windows.at(-1)?.share, "last share differs from the first").not.toBe(windows[0]?.share);
  expect(new Set(windows.map((window) => window.perMs)).size, "distinct spin rates").toBeGreaterThan(1);
  expect(achieved, "achieved burner share of a quantum").toBeGreaterThanOrEqual(0.25);
  expect(achieved, "achieved burner share of a quantum").toBeLessThanOrEqual(0.35);
  await expect(page.locator(".transport")).toHaveAttribute("data-playing", "true");
  await expect(page.getByText(OVERLOAD, { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
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
  // Warm-up: Chromium records 12–19 underrun events while the stream starts.
  await expect.poll(() => page.evaluate(() => (window as TimingWindow).qaTiming?.audioMs ?? 0), { intervals: [500], timeout: 60_000 }).toBeGreaterThanOrEqual(2000);
  const warmUnderruns = await underrunEvents(page);
  await expect.poll(() => page.evaluate(() => (window as TimingWindow).qaTiming?.audioMs ?? 0), { intervals: [1000], timeout: SOAK_SECONDS * 1000 + 60_000 })
    .toBeGreaterThanOrEqual(SOAK_SECONDS * 1000);
  await expect(transport).toHaveAttribute("data-playing", "true");
  const timing = await page.evaluate(() => (window as TimingWindow).qaTiming);
  const endUnderruns = await underrunEvents(page);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  if (!timing) throw new Error("Missing worklet timing");
  const quantumMs = 1000 * 128 / timing.sampleRate;
  const evidence = { ...timing, meanKernelMs: timing.totalMs / timing.quanta, meanLoad: timing.totalMs / timing.quanta / quantumMs, quantumMs,
    clockDriftMs: timing.wallMs - timing.audioMs, driftLimitMs: Math.min(DRIFT_MS_MAX, DRIFT_MS_PER_AUDIO_SECOND * timing.audioMs / 1000),
    deviceUnderrunsAfterWarmUp: warmUnderruns === null || endUnderruns === null ? null : endUnderruns - warmUnderruns };
  await writeFile(info.outputPath("live-soak-evidence.json"), JSON.stringify(evidence, null, 2));
  await info.attach("live-soak-evidence", { body: JSON.stringify(evidence), contentType: "application/json" });
  expect(timing.sampleRate).toBe(RATE);
  // No device underrun after warm-up (Chromium's playbackStats), and the audio
  // clock kept pace with the wall clock (a render thread that falls behind makes
  // it lag). `slow` (kernel calls over 2.67 ms by Date.now) is informational: the
  // ~10.6 ms output buffer absorbs a 4–8 ms call. ringUnderruns is not a CPU
  // gauge: the kernel runs inside process(), so the ring cannot run dry from load.
  expect(evidence.deviceUnderrunsAfterWarmUp, JSON.stringify(evidence)).toBe(0);
  expect(Math.abs(evidence.clockDriftMs), JSON.stringify(evidence)).toBeLessThanOrEqual(evidence.driftLimitMs);
  // The budget gate is a real-worklet mean load ≤ 0.5 (docs/tasks.md V1-10). The
  // 600 s run is the budget evidence and holds that gate; the short CI run only
  // catches gross regressions, since shared CI and agent hosts swing about 2x.
  expect(evidence.meanLoad, JSON.stringify(evidence)).toBeLessThanOrEqual(SOAK_SECONDS >= 600 ? 0.5 : 0.75);
});
});
