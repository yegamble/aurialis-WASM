import { readFile } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { decode, fixture } from "./audio-fixture";
import { meanOutputLevel, observeOutput, outputLevel } from "./live-output";
import { uploadProject } from "./workflow-fixture";

// Independent tones test spectral behavior rather than reusing application DSP.
function multitone(seconds = 1) {
  const wav = fixture(1000, seconds);
  for (let index = 0; index < seconds * 48000; index++) {
    const sample = 0.12 * [125, 1000, 8000].reduce((sum, frequency) => sum + Math.sin(2 * Math.PI * frequency * index / 48000), 0);
    wav.writeInt16LE(Math.round(sample * 32767), 44 + index * 4);
    wav.writeInt16LE(Math.round(sample * 16383), 46 + index * 4);
  }
  return wav;
}
function burstSource(seconds = 4) {
  const wav = fixture(1000, seconds);
  for (let index = 0; index < seconds * 48000; index++) {
    const amplitude = index % 48000 < 4800 ? 0.8 : 0.1;
    const sample = amplitude * Math.sin(2 * Math.PI * 1000 * index / 48000);
    wav.writeInt16LE(Math.round(sample * 32767), 44 + index * 4);
    wav.writeInt16LE(Math.round(sample * 32767), 46 + index * 4);
  }
  return wav;
}
async function importFixture(page: Page, wav: Buffer, name: string) {
  await page.goto("/");
  await page.getByLabel("Import audio file").setInputFiles({ name, mimeType: "audio/wav", buffer: wav });
  await expect(page).toHaveURL(/\/master\/track-/, { timeout: 30_000 });
  await expect(page.getByRole("button", { name: "A Processed", exact: true })).toBeEnabled();
}
async function exportPCM(page: Page) {
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "32-bit Float", exact: true }).click();
  const pending = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Render & download WAV", exact: true }).click();
  const download = await pending;
  expect(await download.failure()).toBeNull();
  const path = await download.path();
  if (!path) throw new Error("Missing actual WAV download");
  const pcm = decode(await readFile(path));
  expect(pcm.bits).toBe(32);
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  return pcm;
}
function toneAmplitude(samples: number[], frequency: number, rate: number) {
  // Ignore startup; the remaining half-second has exact integer cycles.
  let cosine = 0, sine = 0;
  for (let index = rate / 2; index < rate; index++) {
    const sample = samples[index] ?? 0;
    cosine += sample * Math.cos(2 * Math.PI * frequency * index / rate);
    sine += sample * Math.sin(2 * Math.PI * frequency * index / rate);
  }
  return Math.hypot(cosine, sine) * 4 / rate;
}
function energyDb(samples: number[]) {
  return 10 * Math.log10(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);
}
async function setSlider(page: Page, name: string, value: number) {
  await page.getByRole("slider", { name, exact: true }).fill(String(value));
}
async function readSettings(page: Page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem("aurialis-state-v1") ?? "{}") as { tracks: { advanced: Record<string, unknown> }[] });
}

test("each supported EQ type shapes downloaded audio and individual band bypass restores its source", async ({ page }, info) => {
  test.setTimeout(120_000);
  await importFixture(page, multitone(), "qa-supported-filters.wav");
  await page.getByRole("tab", { name: "Mid", exact: true }).click();
  await setSlider(page, "Mid frequency", 1000);
  await setSlider(page, "Mid Q", 0.707);
  await setSlider(page, "Mid gain", 6);
  const enabled = page.getByRole("checkbox", { name: "Enable Mid band", exact: true });
  await enabled.uncheck();
  const baseline = await exportPCM(page);
  const results: { type: string; gains: number[] }[] = [];
  for (const type of ["highpass", "lowshelf", "peaking", "highshelf"]) {
    const before = await readSettings(page);
    await page.getByRole("combobox", { name: "Mid filter type", exact: true }).selectOption(type);
    const after = await readSettings(page);
    const previous = before.tracks[0]?.advanced;
    const current = after.tracks[0]?.advanced;
    if (!previous || !current) throw new Error("Missing saved settings");
    const previousBands = previous.eqBands as { id: string; type: string }[];
    expect(current).toEqual({ ...previous, eqBands: previousBands.map((band) => band.id === "mid" ? { ...band, type } : band) });
    await enabled.check();
    const processed = await exportPCM(page);
    const gains = [125, 1000, 8000].map((frequency) => 20 * Math.log10(toneAmplitude(processed.left, frequency, processed.rate) / toneAmplitude(baseline.left, frequency, baseline.rate)));
    if (type === "highpass") {
      expect(gains[0]).toBeLessThan(-30);
      expect(gains[1]).toBeCloseTo(-3.01, 1);
      expect(Math.abs(gains[2] ?? Infinity)).toBeLessThan(0.1);
      await expect(page.getByRole("slider", { name: "Mid gain", exact: true })).toBeDisabled();
    } else if (type === "lowshelf") {
      expect(gains[0]).toBeGreaterThan(5.5);
      expect(Math.abs(gains[2] ?? Infinity)).toBeLessThan(0.5);
    } else if (type === "peaking") {
      expect(gains[1]).toBeCloseTo(6, 1);
      expect(Math.abs(gains[0] ?? Infinity)).toBeLessThan(0.5);
      expect(Math.abs(gains[2] ?? Infinity)).toBeLessThan(0.5);
    } else {
      expect(gains[2]).toBeGreaterThan(5.5);
      // Independently measured 48 kHz native tone at the indicated 1 kHz corner.
      expect(gains[1]).toBeCloseTo(5.466, 1);
      expect(Math.abs(gains[0] ?? Infinity)).toBeLessThan(0.5);
    }
    results.push({ type, gains });
    await enabled.uncheck();
    const bypassed = await exportPCM(page);
    expect(bypassed.left).toEqual(baseline.left);
    expect(bypassed.right).toEqual(baseline.right);
  }
  await expect(page.getByRole("slider", { name: "Mid gain", exact: true })).toHaveValue("6");
  await page.reload();
  await page.getByRole("tab", { name: "Mid", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Mid filter type", exact: true })).toHaveValue("highshelf");
  await expect(enabled).not.toBeChecked();
  await info.attach("downloaded-filter-responses", { body: JSON.stringify(results, null, 2), contentType: "application/json" });
});

test("every EQ type and band enable changes the real live speaker feed without restarting", async ({ page }, info) => {
  test.setTimeout(120_000);
  await observeOutput(page);
  await importFixture(page, fixture(1000, 60), "qa-live-filters.wav");
  await setSlider(page, "Playback volume", 1);
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect.poll(async () => (await outputLevel(page))?.rmsDbfs ?? -Infinity).toBeCloseTo(-19.03, 0);
  const initial = await outputLevel(page);
  if (!initial) throw new Error("Missing speaker-feed probe");
  await page.getByRole("tab", { name: "Mid", exact: true }).click();
  await setSlider(page, "Mid frequency", 1000);
  await setSlider(page, "Mid Q", 0.707);
  await setSlider(page, "Mid gain", 6);
  const enabled = page.getByRole("checkbox", { name: "Enable Mid band", exact: true });
  const results: { type: string; measuredGainDb: number }[] = [];
  for (const [type, gain] of [["highpass", -3.01], ["lowshelf", 5.898], ["peaking", 6], ["highshelf", 5.466]] as const) {
    await page.getByRole("combobox", { name: "Mid filter type", exact: true }).selectOption(type);
    await expect.poll(async () => (await outputLevel(page))?.rmsDbfs ?? -Infinity).toBeCloseTo(-19.03 + gain, 0);
    const measured = await meanOutputLevel(page);
    expect(measured + 19.03).toBeCloseTo(gain, 1);
    results.push({ type, measuredGainDb: measured + 19.03 });
    await enabled.uncheck();
    await expect.poll(async () => (await outputLevel(page))?.rmsDbfs ?? -Infinity).toBeCloseTo(-19.03, 0);
    await enabled.check();
  }
  await page.getByRole("combobox", { name: "Mid filter type", exact: true }).selectOption("highpass");
  const handle = page.getByRole("button", { name: /^Mid EQ:/ });
  await handle.focus();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("slider", { name: "Mid gain", exact: true })).toHaveValue("6");
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("slider", { name: "Mid frequency", exact: true })).toHaveValue("1059");
  const final = await outputLevel(page);
  expect(final?.instanceId).toBe(initial.instanceId);
  expect(final?.frames).toBeGreaterThan(initial.frames);
  await expect(page.locator(".transport")).toHaveAttribute("data-playing", "true");
  await info.attach("live-filter-responses", { body: JSON.stringify(results, null, 2), contentType: "application/json" });
});

test("limiter release changes burst recovery in downloaded and actual live audio", async ({ page }, info) => {
  test.setTimeout(120_000);
  await observeOutput(page);
  await importFixture(page, burstSource(), "qa-limiter-recovery.wav");
  await setSlider(page, "Input gain", 12);
  await setSlider(page, "Limiter ceiling", -3);
  await page.getByRole("checkbox", { name: "Enable limiter", exact: true }).check();
  await setSlider(page, "Limiter release", 10);
  const fast = await exportPCM(page);
  await setSlider(page, "Limiter release", 1000);
  const slow = await exportPCM(page);
  // Quiet interval after the second hot burst independently isolates release.
  const start = Math.round(1.2 * 48000), end = Math.round(1.4 * 48000);
  const exportDelta = energyDb(fast.left.slice(start, end)) - energyDb(slow.left.slice(start, end));
  expect(exportDelta).toBeGreaterThan(3);
  await setSlider(page, "Playback volume", 1);
  await page.getByRole("button", { name: "Repeat track", exact: true }).click();
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect.poll(async () => (await outputLevel(page))?.frames ?? 0).toBeGreaterThan(48000);
  const initial = await outputLevel(page);
  await meanOutputLevel(page); // Let the slow envelope reach its periodic state.
  const slowLive = await meanOutputLevel(page);
  await setSlider(page, "Limiter release", 10);
  await meanOutputLevel(page);
  const fastLive = await meanOutputLevel(page);
  expect(fastLive - slowLive).toBeGreaterThan(1);
  expect((await outputLevel(page))?.instanceId).toBe(initial?.instanceId);
  await setSlider(page, "Limiter release", 500);
  await page.getByRole("slider", { name: "Limiter release", exact: true }).dblclick();
  await expect(page.getByRole("slider", { name: "Limiter release", exact: true })).toHaveValue("85");
  await info.attach("limiter-burst-recovery", { body: JSON.stringify({ exportDeltaDb: exportDelta, slowLiveDbfs: slowLive, fastLiveDbfs: fastLive }, null, 2), contentType: "application/json" });
});

test("populated filter controls retain six-width accessibility and 44 pixel touch geometry", async ({ page }) => {
  test.setTimeout(120_000);
  await uploadProject(page, "qa-filter-layout.wav");
  await page.getByRole("tab", { name: "Mid", exact: true }).click();
  for (const width of [320, 375, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const type of ["highpass", "highshelf"]) {
      await page.getByRole("combobox", { name: "Mid filter type", exact: true }).selectOption(type);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
      for (const control of [page.getByRole("combobox", { name: "Mid filter type", exact: true }), page.getByText("Enable Mid band", { exact: true }), page.getByRole("slider", { name: "Limiter release", exact: true })]) {
        const box = await control.boundingBox();
        expect(box?.width).toBeGreaterThanOrEqual(44);
        expect(box?.height).toBeGreaterThanOrEqual(44);
      }
      const handles = page.locator(".eq-handle");
      await expect(handles).toHaveCount(1);
      await handles.scrollIntoViewIfNeeded();
      const box = await handles.boundingBox();
      expect(box?.width).toBeGreaterThanOrEqual(44);
      expect(box?.height).toBeGreaterThanOrEqual(44);
      const active = await handles.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        // Probe the center and four inset cardinal edges of the circular target.
        return [[0.5, 0.5], [0.1, 0.5], [0.9, 0.5], [0.5, 0.1], [0.5, 0.9]].every(([x, y]) =>
          document.elementFromPoint(rect.left + rect.width * x!, rect.top + rect.height * y!)?.closest(".eq-handle") === element);
      });
      expect(active, `${width}px ${type} selected handle is unobscured`).toBe(true);
      await handles.focus();
      await expect(handles).toBeFocused();
      const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
      expect(axe.violations, `${width}px ${type}: ${JSON.stringify(axe.violations)}`).toEqual([]);
    }
  }
});
