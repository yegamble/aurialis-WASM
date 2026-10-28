import { expect, test, type Page } from "@playwright/test";
import { OVERLOAD_MESSAGE } from "../src/lib/live-overload";
import { uploadProject } from "./workflow-fixture";

// V1-10 Round 4 (QA Round E 3 cases): the overload message must follow real
// device underruns. A test-only patch of the real worklet (loaded from a blob
// URL, hence bypassCSP; the app's own CSP is unchanged) spins Date.now for a
// fixed time at a chosen point of every Nth quantum. Nothing else is replaced.
test.use({ bypassCSP: true });
const LOOP_SECONDS = 8;
const WRITE = "Atomics.store(this.header, WRITE, sequence);";
const KERNEL = "if (this.kernel.aurialis_live_process() !== QUANTUM)\n        throw new Error(\"The live audio engine rejected an audio block.\");";
const AFTER = "this.refreshBuffers();\n      if (this.generation !== Atomics.load(this.header, GENERATION)) {";
type Where = "before" | "inside" | "after";

/** Spin `waitMs` every `everyQuanta` quanta; with `skipEvery`, leave out every
 * skipEvery-th of those stalls (60/60/0 ms is skipEvery 3). */
async function hitch(page: Page, waitMs: number, everyQuanta: number, where: Where, skipEvery = 0, onlyOnce = false): Promise<void> {
  const burn = `let qaN = 0; function qaBurn() { if (++qaN % ${String(everyQuanta)} === 0 && (!${String(onlyOnce)} || qaN === ${String(everyQuanta)}) && (${String(skipEvery)} === 0 || (qaN / ${String(everyQuanta)}) % ${String(skipEvery)} !== 0)) { const s = Date.now(); while (Date.now() - s < ${String(waitMs)}) {} } }`;
  const replace: [string, string] = where === "before" ? [WRITE, `${WRITE} qaBurn();`]
    : where === "inside" ? [KERNEL, `${KERNEL}\n      qaBurn();`] : [AFTER, `qaBurn(); ${AFTER}`];
  await page.addInitScript(({ burn, replace }) => {
    const nativeAddModule = AudioWorklet.prototype.addModule;
    AudioWorklet.prototype.addModule = async function (this: AudioWorklet, url: string | URL, options?: WorkletOptions) {
      const href = new URL(url, location.href);
      if (!href.pathname.endsWith("/worklets/aurialis-live-worklet.js")) return nativeAddModule.call(this, url, options);
      const host = "from \"./aurialis-wasi-host.js\"";
      let source = (await (await fetch(href)).text()).replace(host, `from "${new URL("./aurialis-wasi-host.js", href).href}"`);
      if (!source.includes(replace[0]) || !source.includes("const QUANTUM = 128;")) throw new Error("The worklet changed; update the hitch patch.");
      source = source.replace(replace[0], replace[1]).replace("const QUANTUM = 128;", `const QUANTUM = 128;${burn}`);
      const blob = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
      try { await nativeAddModule.call(this, blob, options); } finally { URL.revokeObjectURL(blob); }
    };
  }, { burn, replace });
}

/** A browser without playbackStats: the worklet's fallback slack rule decides. */
async function hidePlaybackStats(page: Page): Promise<void> {
  await page.addInitScript(() => { Object.defineProperty(AudioContext.prototype, "playbackStats", { configurable: true, get: () => undefined }); });
}

async function play(page: Page, name: string): Promise<number> {
  await page.addInitScript(() => {
    const NativeContext = AudioContext;
    window.AudioContext = class extends NativeContext { constructor(options?: AudioContextOptions) { super({ ...options, sampleRate: 48000 }); } };
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await uploadProject(page, name, LOOP_SECONDS, "dense");
  await page.getByRole("button", { name: "Repeat track", exact: true }).click();
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(page.locator(".transport")).toHaveAttribute("data-playing", "true");
  return Date.now();
}

async function keepsPlaying(page: Page, seconds: number): Promise<void> {
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    await page.waitForTimeout(1000);
    await expect(page.getByText(OVERLOAD_MESSAGE, { exact: true })).toHaveCount(0);
  }
  await expect(page.locator(".transport")).toHaveAttribute("data-playing", "true");
  await page.getByRole("button", { name: "Pause", exact: true }).click();
}

// One slow call a second fits the ~10.6 ms output buffer: Chromium reports no
// underrun, so playback must go on (QA F-1, a false stop on CI before).
for (const waitMs of [5, 8]) {
  test(`a ${String(waitMs)} ms kernel call once a second keeps playing`, async ({ page }) => {
    test.setTimeout(120_000);
    await hitch(page, waitMs, 375, "inside");
    await play(page, `hitch-${String(waitMs)}.wav`);
    await keepsPlaying(page, 25);
  });
}

// One isolated stall is a glitch, not an overload (Round 7 R-1): a single 120 or
// 250 ms spin about 6 s in must leave playback running.
for (const waitMs of [120, 250]) {
  test(`one ${String(waitMs)} ms stall about 6 s in keeps playing`, async ({ page }) => {
    test.setTimeout(120_000);
    await hitch(page, waitMs, 2250, "after", 0, true);
    await play(page, `single-${String(waitMs)}.wav`);
    await keepsPlaying(page, 20);
  });
}

// Repeated but sparse glitches (Round 8): a 1 s stall every 6 s must stop
// playback. The stall is counted in quanta, so each cycle is 6 s of audio plus
// the 1 s stall: 7 s of wall clock, and the third stall falls near 21 s, hence
// the 25 s bound. Which rule fires depends on the host (Round 8b traces): on CI
// the 15-window rule fires at about 21 s; on the local macOS host each 1 s stall
// is followed by a ~200 ms recovery underrun in the next window and stretches
// its window to ~2.2 s, so the second stall already falls within five windows
// and the 5-window two-burst rule fires at about 14 s. Shorter stalls (300 or
// 500 ms) cause no device underrun at all in headless Chromium, so no e2e can
// isolate the 15-window rule; the exact unit rows prove it. The lower bound only
// rejects a stop before the second stall.
test("a 1 s stall every 6 s stops with the can't-keep-up message", async ({ page }) => {
  test.setTimeout(120_000);
  await hitch(page, 1000, 2250, "after");
  const started = await play(page, "sparse-1s-6s.wav");
  await expect(page.getByText(OVERLOAD_MESSAGE, { exact: true })).toBeVisible({ timeout: 40_000 });
  const elapsed = Date.now() - started;
  test.info().annotations.push({ type: "fired-after-ms", description: String(elapsed) });
  console.log(`sparse 1 s every 6 s fired after ${String(elapsed)} ms`);
  expect(elapsed, "fired after (ms)").toBeGreaterThanOrEqual(12_000);
  expect(elapsed, "fired after (ms)").toBeLessThanOrEqual(25_000);
  await expect(page.locator(".transport")).toHaveAttribute("data-playing", "false");
});

// Real underruns must stop playback within 8 s: every quantum 4 ms late, a
// 60 ms stall once a second on either side of the kernel (QA F-2, missed before
// because the render thread catches up on the clock), and periodic dropouts that
// skip a second (Round 6 S-2): 60/60/0 ms, and 200 ms every 2 s.
for (const [waitMs, every, where, skip] of [[4, 1, "before", 0], [60, 375, "before", 0], [60, 375, "after", 0], [60, 375, "after", 3], [200, 750, "after", 0]] as const) {
  test(`${String(waitMs)} ms ${where} the kernel every ${String(every)} quanta${skip ? `, skipping every ${String(skip)}rd,` : ""} stops with the can't-keep-up message`, async ({ page }) => {
    test.setTimeout(120_000);
    await hitch(page, waitMs, every, where, skip);
    const started = await play(page, `stall-${String(waitMs)}-${String(every)}-${where}-${String(skip)}.wav`);
    await expect(page.getByText(OVERLOAD_MESSAGE, { exact: true })).toBeVisible({ timeout: 20_000 });
    const elapsed = Date.now() - started;
    await expect(page.locator(".transport")).toHaveAttribute("data-playing", "false");
    await expect(page.getByText(/buffer fault/u)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Restore source", exact: true })).toHaveCount(0);
    test.info().annotations.push({ type: "fired-after-ms", description: String(elapsed) });
    expect(elapsed, "fired after (ms)").toBeLessThanOrEqual(8000);
  });
}

// Browsers without playbackStats rely on the worklet's slack rule.
test("without playbackStats, a 60 ms stall once a second still stops playback", async ({ page }) => {
  test.setTimeout(120_000);
  await hidePlaybackStats(page);
  await hitch(page, 60, 375, "after");
  await play(page, "fallback-stall.wav");
  await expect(page.getByText(OVERLOAD_MESSAGE, { exact: true })).toBeVisible({ timeout: 20_000 });
});
test("without playbackStats, an 8 ms call once a second keeps playing", async ({ page }) => {
  test.setTimeout(120_000);
  await hidePlaybackStats(page);
  await hitch(page, 8, 375, "inside");
  await play(page, "fallback-hitch.wav");
  await keepsPlaying(page, 25);
});

// QA F-1 on CI: Simple-style playback stopped while an export rendered.
test("an export rendered during playback does not stop it", async ({ page }) => {
  test.setTimeout(150_000);
  await play(page, "export-while-playing.wav");
  await page.getByRole("tab", { name: "simple", exact: true }).click();
  await page.getByRole("button", { name: "Warm", exact: true }).click();
  for (let round = 0; round < 2; round++) {
    await page.getByRole("button", { name: "Export", exact: true }).click();
    const dialog = page.getByRole("dialog");
    const pending = page.waitForEvent("download");
    await dialog.getByRole("button", { name: "Render & download WAV", exact: true }).click();
    await pending;
    await page.keyboard.press("Escape");
  }
  await keepsPlaying(page, 15);
});
