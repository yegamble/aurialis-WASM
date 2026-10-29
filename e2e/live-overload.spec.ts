import { expect, test, type Page } from "@playwright/test";
import { OVERLOAD_MESSAGE } from "../src/lib/live-overload";
import { uploadProject } from "./workflow-fixture";

// V1-10 Round 4 (QA Round E 3 cases): the overload message must follow real
// device underruns. A test-only same-origin response patch of the real worklet
// spins Date.now for a
// fixed time at a chosen point of every Nth quantum. Nothing else is replaced.
const LOOP_SECONDS = 8;
const WRITE = "Atomics.store(this.header, WRITE, sequence);";
const KERNEL = "if (this.kernel.aurialis_live_process() !== QUANTUM)\n        throw new Error(\"The live audio engine rejected an audio block.\");";
const AFTER = "this.refreshBuffers();\n      if (this.generation !== Atomics.load(this.header, GENERATION)) {";
const instrumentedPages = new WeakSet<Page>();
type HitchWindow = Window & { qaHitch?: { armed: boolean; count: number; quantum: number; waitMs: number; everyQuanta: number } };
type Where = "before" | "inside" | "after";

/** Spin `waitMs` every `everyQuanta` quanta; with `skipEvery`, leave out every
 * skipEvery-th of those stalls (60/60/0 ms is skipEvery 3). */
async function hitch(page: Page, waitMs: number, everyQuanta: number, where: Where, skipEvery = 0, onlyOnce = false): Promise<void> {
  instrumentedPages.add(page);
  await page.addInitScript(() => {
    const Native = AudioWorkletNode;
    window.AudioWorkletNode = class extends Native {
      constructor(context: BaseAudioContext, name: string, options?: AudioWorkletNodeOptions) {
        super(context, name, options);
        if (name === "aurialis-live") this.port.addEventListener("message", (event: MessageEvent<{ type: string; count: number; quantum: number; waitMs: number; everyQuanta: number }>) => {
          const data = event.data, scope = window as HitchWindow;
          if (data.type === "qa-hitch-armed") scope.qaHitch = { armed: true, count: 0, quantum: 0, waitMs: data.waitMs, everyQuanta: data.everyQuanta };
          else if (data.type === "qa-hitch" && scope.qaHitch) scope.qaHitch = { ...scope.qaHitch, count: data.count, quantum: data.quantum };
        });
      }
    };
  });
  const burn = `let qaN = 0, qaHitches = 0; function qaBurn(processor) { if (++qaN % ${String(everyQuanta)} === 0 && (!${String(onlyOnce)} || qaN === ${String(everyQuanta)}) && (${String(skipEvery)} === 0 || (qaN / ${String(everyQuanta)}) % ${String(skipEvery)} !== 0)) { const s = Date.now(); while (Date.now() - s < ${String(waitMs)}) {} processor.port.postMessage({type:"qa-hitch",count:++qaHitches,quantum:qaN}); } }`;
  const replace: [string, string] = where === "before" ? [WRITE, `${WRITE} qaBurn(this);`]
    : where === "inside" ? [KERNEL, `${KERNEL}\n      qaBurn(this);`] : [AFTER, `qaBurn(this); ${AFTER}`];
  await page.route((url) => url.pathname === "/worklets/aurialis-live-worklet.js", async (route) => {
    const response = await route.fetch();
    let source = await response.text();
    if (!source.includes(replace[0]) || !source.includes("const QUANTUM = 128;")) throw new Error("The worklet changed; update the hitch patch.");
    const ready = 'this.port.postMessage({ type: "ready" });';
    if (!source.includes(ready)) throw new Error("The worklet changed; update the hitch arm observer.");
    source = source.replace(replace[0], replace[1]).replace("const QUANTUM = 128;", `const QUANTUM = 128;${burn}`)
      .replace(ready, `${ready} this.port.postMessage({type:"qa-hitch-armed",waitMs:${String(waitMs)},everyQuanta:${String(everyQuanta)}});`);
    await route.fulfill({ response, body: source });
  });
}

/** A browser without playbackStats: the worklet's fallback slack rule decides. */
async function hidePlaybackStats(page: Page): Promise<void> {
  await page.addInitScript(() => { Object.defineProperty(AudioContext.prototype, "playbackStats", { configurable: true, get: () => undefined }); });
}

async function play(page: Page, name: string, quality?: "Oversampled"): Promise<number> {
  await page.addInitScript(() => {
    const NativeContext = AudioContext;
    window.AudioContext = class extends NativeContext { constructor(options?: AudioContextOptions) { super({ ...options, sampleRate: 48000 }); } };
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await uploadProject(page, name, LOOP_SECONDS, "dense");
  if (quality) await page.getByRole("button", { name: quality, exact: true }).click();
  await page.getByRole("button", { name: "Repeat track", exact: true }).click();
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(page.locator(".transport")).toHaveAttribute("data-playing", "true");
  if (instrumentedPages.has(page)) await expect.poll(() => page.evaluate(() => (window as HitchWindow).qaHitch?.armed)).toBe(true);
  return Date.now();
}

async function assertHitches(page: Page) {
  await expect.poll(() => page.evaluate(() => (window as HitchWindow).qaHitch?.count ?? 0)).toBeGreaterThan(0);
  await test.info().attach("actual-worklet-hitches", { body: JSON.stringify(await page.evaluate(() => (window as HitchWindow).qaHitch)), contentType: "application/json" });
}

async function keepsPlaying(page: Page, seconds: number): Promise<void> {
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    await page.waitForTimeout(1000);
    await expect(page.getByText(OVERLOAD_MESSAGE, { exact: true })).toHaveCount(0);
  }
  await expect(page.locator(".transport")).toHaveAttribute("data-playing", "true");
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  if (instrumentedPages.has(page)) await assertHitches(page);
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
// isolate the 15-window rule; the exact unit rows prove it. Any rule may fire,
// and each is correct: if the first stall's recovery reaches a third window,
// three strikes fire at about 8–9 s. On QA E9's host 3 of 86 recorded stalls
// (3 of 53 in the 1 s every 10 s runs) left three bad windows, and no first
// stall did. The first stall begins about 6 s after Play, so the 7 s floor only
// proves the stop came after a stall began (Round 8e).
test("a 1 s stall every 6 s stops with the can't-keep-up message", async ({ page }) => {
  test.setTimeout(120_000);
  await hitch(page, 1000, 2250, "after");
  const started = await play(page, "sparse-1s-6s.wav");
  await expect(page.getByText(OVERLOAD_MESSAGE, { exact: true })).toBeVisible({ timeout: 40_000 });
  await assertHitches(page);
  const elapsed = Date.now() - started;
  test.info().annotations.push({ type: "fired-after-ms", description: String(elapsed) });
  console.log(`sparse 1 s every 6 s fired after ${String(elapsed)} ms`);
  expect(elapsed, "fired after (ms)").toBeGreaterThanOrEqual(7_000);
  expect(elapsed, "fired after (ms)").toBeLessThanOrEqual(25_000);
  await expect(page.locator(".transport")).toHaveAttribute("data-playing", "false");
});

// Real underruns must stop playback within 10 s: every quantum 4 ms late, a
// 60 ms stall once a second on either side of the kernel (QA F-2, missed before
// because the render thread catches up on the clock), and periodic dropouts that
// skip a second (Round 6 S-2): 60/60/0 ms, and 200 ms every 2 s.
for (const [waitMs, every, where, skip] of [[4, 1, "before", 0], [60, 375, "before", 0], [60, 375, "after", 0], [60, 375, "after", 3], [200, 750, "after", 0]] as const) {
  test(`${String(waitMs)} ms ${where} the kernel every ${String(every)} quanta${skip ? `, skipping every ${String(skip)}rd,` : ""} stops with the can't-keep-up message`, async ({ page }) => {
    test.setTimeout(120_000);
    await hitch(page, waitMs, every, where, skip);
    const started = await play(page, `stall-${String(waitMs)}-${String(every)}-${where}-${String(skip)}.wav`);
    await expect(page.getByText(OVERLOAD_MESSAGE, { exact: true })).toBeVisible({ timeout: 20_000 });
  await assertHitches(page);
    const elapsed = Date.now() - started;
    await expect(page.locator(".transport")).toHaveAttribute("data-playing", "false");
    await expect(page.getByText(/buffer fault/u)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Restore source", exact: true })).toHaveCount(0);
    test.info().annotations.push({ type: "fired-after-ms", description: String(elapsed) });
    // Five 1 s playbackStats ticks (warm-up plus up to four judged windows) plus
    // main-thread timer delay, which grows under host load (DA E10 jitter
    // simulation: p99 8.3–9.4 s at load average 12–17; measured 6.5–7.3 s).
    expect(elapsed, "fired after (ms)").toBeLessThanOrEqual(10_000);
  });
}

// Browsers without playbackStats rely on the worklet's slack rule.
for (const quality of [undefined, "Oversampled"] as const) {
test(`without playbackStats, a 60 ms stall once a second still stops playback (${quality ?? "Classic"})`, async ({ page }) => {
  test.setTimeout(120_000);
  await hidePlaybackStats(page);
  await hitch(page, 60, 375, "after");
  await play(page, "fallback-stall.wav", quality);
  await expect(page.getByText(OVERLOAD_MESSAGE, { exact: true })).toBeVisible({ timeout: 20_000 });
  await assertHitches(page);
});
test(`without playbackStats, an 8 ms call once a second keeps playing (${quality ?? "Classic"})`, async ({ page }) => {
  test.setTimeout(120_000);
  await hidePlaybackStats(page);
  await hitch(page, 8, 375, "inside");
  await play(page, "fallback-hitch.wav", quality);
  await keepsPlaying(page, 25);
});

}

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
