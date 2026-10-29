import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import type { AdvancedParams } from "../src/lib/types";
import { decode, fixture } from "./audio-fixture";
import { meanOutputLevel, observeOutput, outputLevel } from "./live-output";

const shortcuts = [
  { label: "Add Air", frequency: 7000, slider: "Air gain", edit: "2", band: "Air" },
  { label: "Cut Mud", frequency: 250, slider: "Low gain", edit: "-3", band: "Low" },
  { label: "Tape Warmth", frequency: 1000, slider: "Saturation", edit: "20" },
  { label: "Glue Comp", frequency: 1000, slider: "Threshold", edit: "-24" },
] as const;

async function settings(page: Page): Promise<AdvancedParams> {
  return page.evaluate(() => {
    const raw = localStorage.getItem("aurialis-state-v1");
    if (!raw) throw new Error("Missing saved project");
    const id = location.pathname.split("/")[2];
    const track = (JSON.parse(raw) as { tracks: { id: string; advanced: AdvancedParams }[] }).tracks.find((item) => item.id === id);
    if (!track) throw new Error("Missing source project");
    return track.advanced;
  });
}

async function upload(page: Page, frequency: number) {
  await page.goto("/");
  await page.getByLabel("Import audio file").setInputFiles({ name: "qa-shortcut.wav", mimeType: "audio/wav", buffer: fixture(frequency, 2) });
  await expect(page).toHaveURL(/\/master\/track-/, { timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Export", exact: true })).toBeEnabled({ timeout: 30_000 });
  await page.getByRole("button", { name: "Reset modules", exact: true }).click();
}

async function exported(page: Page) {
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "32-bit Float", exact: true }).click();
  const pending = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Render & download WAV", exact: true }).click();
  const download = await pending;
  expect(await download.failure()).toBeNull();
  const path = await download.path();
  if (!path) throw new Error("Missing native WAV download");
  const pcm = decode(await readFile(path));
  expect(pcm.bits).toBe(32);
  expect(pcm.left).toHaveLength(96000);
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  return pcm;
}

for (const shortcut of shortcuts) {
  test(`${shortcut.label} toggles its real settings and restores exported audio independently`, async ({ page }) => {
    await upload(page, shortcut.frequency);
    const button = page.getByRole("button", { name: shortcut.label, exact: true });
    await expect(button).toHaveAttribute("aria-pressed", "false");
    const inactiveBackground = await button.evaluate((element) => getComputedStyle(element).backgroundColor);
    const before = await settings(page);
    const original = await exported(page);
    // Exercise native keyboard activation as well as pointer activation.
    await button.focus();
    await button.press("Enter");
    await expect(button).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => button.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe(inactiveBackground);
    const applied = await settings(page);
    if (shortcut.label === "Add Air" || shortcut.label === "Cut Mud") {
      const index = shortcut.label === "Add Air" ? 4 : 1;
      const expectedBand = shortcut.label === "Add Air"
        ? { enabled: true, type: "highshelf", freqHz: 12000, gainDb: 1, q: 0.707 }
        : { enabled: true, type: "peaking", freqHz: 250, gainDb: -1.5, q: 0.8 };
      expect(applied.eqBands[index]).toMatchObject(expectedBand);
      expect(applied.eqEnabled).toBe(true);
      for (let i = 0; i < 5; i++) if (i !== index) expect(applied.eqBands[i]).toEqual(before.eqBands[i]);
      expect({ ...applied, eqEnabled: before.eqEnabled, eqBands: before.eqBands }).toEqual(before);
    } else if (shortcut.label === "Tape Warmth") {
      expect(applied.saturationModule).toEqual({ enabled: true, character: "Tape", drive: 15 });
      expect(applied.saturation).toBe(15);
      expect({ ...applied, saturation: before.saturation, saturationModule: before.saturationModule }).toEqual(before);
    } else {
      expect(applied.compressor).toEqual({ ...before.compressor, enabled: true, threshold: -18, ratio: 2, attack: 30, release: 200, autoRelease: true, sidechainHpfHz: 90, knee: 6, makeup: 0 });
      expect({ ...applied, compressor: before.compressor, threshold: before.threshold, ratio: before.ratio, attack: before.attack, release: before.release }).toEqual(before);
    }
    const processed = await exported(page);
    let maximumDifference = 0;
    for (const channel of ["left", "right"] as const) {
      for (let i = 0; i < original[channel].length; i++) maximumDifference = Math.max(maximumDifference, Math.abs(original[channel][i]! - processed[channel][i]!));
    }
    expect(maximumDifference, "Shortcut must alter actual rendered PCM").toBeGreaterThan(1e-5);
    // A second click must disable the shortcut and recover the exact baseline.
    await button.click();
    await expect(button).toHaveAttribute("aria-pressed", "false");
    await expect(button).toHaveCSS("background-color", inactiveBackground);
    expect(await settings(page)).toEqual(before);
    const restored = await exported(page);
    expect(restored.left).toEqual(original.left);
    expect(restored.right).toEqual(original.right);
    await button.click();
    await expect(button).toHaveAttribute("aria-pressed", "true");
    expect(await settings(page)).toEqual(applied);
    const repeated = await exported(page);
    expect(repeated.left).toEqual(processed.left);
    expect(repeated.right).toEqual(processed.right);
    // Restore history must survive hydration, not merely the current component.
    await page.reload();
    await expect(button).toHaveAttribute("aria-pressed", "true");
    await button.click();
    await expect(button).toHaveAttribute("aria-pressed", "false");
    expect(await settings(page)).toEqual(before);
    await button.click();
    await expect(button).toHaveAttribute("aria-pressed", "true");
    const bypass = page.getByLabel(shortcut.label === "Tape Warmth" ? "Enable saturation" : shortcut.label === "Glue Comp" ? "Enable compressor" : "Enable EQ", { exact: true });
    await bypass.uncheck();
    await expect(button).toHaveAttribute("aria-pressed", "false");
    await expect(button).toHaveCSS("background-color", inactiveBackground);
    await bypass.check();
    await expect(button).toHaveAttribute("aria-pressed", "true");
    if ("band" in shortcut) await page.getByRole("tab", { name: shortcut.band, exact: true }).click();
    await page.getByRole("slider", { name: shortcut.slider, exact: true }).fill(shortcut.edit);
    await expect(button).toHaveAttribute("aria-pressed", "false");
  });
}

test("starting points coexist, survive reload, and clear only when their own settings change", async ({ page }) => {
  await upload(page, 1000);
  for (const shortcut of shortcuts) await page.getByRole("button", { name: shortcut.label, exact: true }).click();
  const applied = await settings(page);
  for (const shortcut of shortcuts) await expect(page.getByRole("button", { name: shortcut.label, exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.reload();
  for (const shortcut of shortcuts) await expect(page.getByRole("button", { name: shortcut.label, exact: true })).toHaveAttribute("aria-pressed", "true");
  expect(await settings(page)).toEqual(applied);
  await page.getByRole("slider", { name: "Input gain", exact: true }).fill("3");
  for (const shortcut of shortcuts) await expect(page.getByRole("button", { name: shortcut.label, exact: true })).toHaveAttribute("aria-pressed", "true");
  for (const shortcut of shortcuts) {
    if ("band" in shortcut) await page.getByRole("tab", { name: shortcut.band, exact: true }).click();
    await page.getByRole("slider", { name: shortcut.slider, exact: true }).fill(shortcut.edit);
    await expect(page.getByRole("button", { name: shortcut.label, exact: true })).toHaveAttribute("aria-pressed", "false");
    for (const other of shortcuts.filter((item) => item.label !== shortcut.label)) await expect(page.getByRole("button", { name: other.label, exact: true })).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: shortcut.label, exact: true }).click();
    await expect(page.getByRole("button", { name: shortcut.label, exact: true })).toHaveAttribute("aria-pressed", "true");
  }
});


test("disabling one active starting point preserves the other three and unrelated edits", async ({ page }) => {
  await upload(page, 1000);
  const baseline = await settings(page);
  for (const shortcut of shortcuts) await page.getByRole("button", { name: shortcut.label, exact: true }).click();
  await page.getByRole("slider", { name: "Input gain", exact: true }).fill("3");
  const allActive = await settings(page);
  for (const shortcut of shortcuts) {
    const button = page.getByRole("button", { name: shortcut.label, exact: true });
    await button.click();
    await expect(button).toHaveAttribute("aria-pressed", "false");
    for (const other of shortcuts.filter((item) => item.label !== shortcut.label))
      await expect(page.getByRole("button", { name: other.label, exact: true })).toHaveAttribute("aria-pressed", "true");
    const off = await settings(page);
    expect(off.input).toBe(3);
    if (shortcut.label === "Add Air" || shortcut.label === "Cut Mud") {
      const index = shortcut.label === "Add Air" ? 4 : 1;
      expect(off.eqBands[index]).toEqual(baseline.eqBands[index]);
      expect({ ...off, eqBands: allActive.eqBands }).toEqual(allActive);
    } else if (shortcut.label === "Tape Warmth") {
      expect(off.saturationModule).toEqual(baseline.saturationModule);
      expect({ ...off, saturationModule: allActive.saturationModule, saturation: allActive.saturation }).toEqual(allActive);
    } else {
      expect(off.compressor).toEqual(baseline.compressor);
      expect({ ...off, compressor: allActive.compressor, threshold: allActive.threshold, ratio: allActive.ratio, attack: allActive.attack, release: allActive.release }).toEqual(allActive);
    }
    await button.click();
    expect(await settings(page)).toEqual(allActive);
  }
  // Remove both EQ shortcuts as well: no residual boost/cut or enabled module.
  for (const shortcut of shortcuts) await page.getByRole("button", { name: shortcut.label, exact: true }).click();
  expect(await settings(page)).toEqual({ ...baseline, input: 3 });
});

for (const shortcut of shortcuts) {
  test(`${shortcut.label} changes live speaker-feed PCM and disabling restores its level`, async ({ page }, info) => {
    await observeOutput(page);
    // Keep the tone below Nyquist even when the browser opens a 24 kHz device.
    const frequency = shortcut.frequency;
    const wav = fixture(frequency, 30);
    for (let offset = 44; offset < wav.length; offset += 2) wav.writeInt16LE(wav.readInt16LE(offset) * 3, offset);
    await page.goto("/");
    await page.getByLabel("Import audio file").setInputFiles({ name: "qa-shortcut-live.wav", mimeType: "audio/wav", buffer: wav });
    await expect(page).toHaveURL(/\/master\/track-/, { timeout: 30_000 });
    await expect(page.getByRole("button", { name: "Play", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "Reset modules", exact: true }).click();
    await page.getByRole("slider", { name: "Playback volume", exact: true }).fill("1");
    await page.getByRole("button", { name: "B Original", exact: true }).click();
    await page.getByRole("button", { name: "Play", exact: true }).click();
    // Device resampling changes high-frequency amplitude. Measure the original
    // through the same speaker feed instead of assuming its theoretical RMS.
    await expect.poll(async () => (await outputLevel(page))?.rmsDbfs ?? -Infinity).toBeGreaterThan(-12);
    const original = await outputLevel(page);
    if (!original) throw new Error("Missing original live PCM");
    expect(original.rmsDbfs).toBeLessThan(-8);
    const originalMean = await meanOutputLevel(page);
    await page.getByRole("button", { name: "A Processed", exact: true }).click();
    // The first audible callback can still include startup silence. Advance
    // the speaker clock, then compare full-period means at the same tolerance.
    await expect.poll(async () => (await outputLevel(page))?.frames ?? 0)
      .toBeGreaterThanOrEqual(original.frames + original.sampleRate / 2);
    const baselineMean = await meanOutputLevel(page);
    expect(Math.abs(baselineMean - originalMean)).toBeLessThan(0.1);
    const baseline = await outputLevel(page);
    if (!baseline) throw new Error("Missing live PCM baseline");
    const button = page.getByRole("button", { name: shortcut.label, exact: true });
    await button.click();
    await expect(button).toHaveAttribute("aria-pressed", "true");
    await expect.poll(async () => {
      const transport = page.locator(".transport");
      return Number(await transport.getAttribute("data-parameter-version")) - Number(await transport.getAttribute("data-applied-version"));
    }).toBe(0);
    await expect.poll(async () => (await outputLevel(page))?.frames ?? 0).toBeGreaterThan(baseline.frames + baseline.sampleRate / 2);
    // A 1024-frame callback contains fractional tone periods at device rates.
    // Its phase-dependent RMS can vary by 0.059 dB without any signal change.
    // Integrate one full second of actual speaker-feed PCM, preserving the
    // activation threshold while excluding callback phase and settling buffers.
    const enabledMean = await meanOutputLevel(page);
    expect(Math.abs(enabledMean - baselineMean)).toBeGreaterThan(0.08);
    const enabled = await outputLevel(page);
    if (!enabled) throw new Error("Missing enabled live PCM");
    await button.click();
    await expect(button).toHaveAttribute("aria-pressed", "false");
    await expect.poll(async () => {
      const transport = page.locator(".transport");
      return Number(await transport.getAttribute("data-parameter-version")) - Number(await transport.getAttribute("data-applied-version"));
    }).toBe(0);
    await expect.poll(async () => (await outputLevel(page))?.frames ?? 0).toBeGreaterThan(enabled.frames + enabled.sampleRate / 2);
    const restoredMean = await meanOutputLevel(page);
    expect(Math.abs(restoredMean - baselineMean)).toBeLessThan(0.1);
    const restored = await outputLevel(page);
    expect(restored?.instanceId).toBe(baseline.instanceId);
    expect(restored?.frames ?? 0).toBeGreaterThan(baseline.frames);
    await expect(page.locator(".transport")).toHaveAttribute("data-playing", "true");
    await info.attach("whole-period-shortcut-levels", { body: JSON.stringify({ shortcut: shortcut.label, sampleRate: baseline.sampleRate, originalMean, baselineMean, enabledMean, restoredMean, activationDeltaDb: enabledMean - baselineMean, restorationDeltaDb: restoredMean - baselineMean }, null, 2), contentType: "application/json" });
  });
}
