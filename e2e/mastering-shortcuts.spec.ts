import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import type { AdvancedParams } from "../src/lib/types";
import { decode, fixture } from "./audio-fixture";

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
  await page.getByLabel("Upload audio file").setInputFiles({ name: "qa-shortcut.wav", mimeType: "audio/wav", buffer: fixture(frequency, 2) });
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
  test(`${shortcut.label} activates its real settings and changes exported audio without stacking`, async ({ page }) => {
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
      expect(applied.saturationModule).toEqual({ enabled: true, character: "Tape", drive: 10 });
      expect(applied.saturation).toBe(10);
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
    await button.click();
    await expect(button).toHaveAttribute("aria-pressed", "true");
    expect(await settings(page)).toEqual(applied);
    const repeated = await exported(page);
    expect(repeated.left).toEqual(processed.left);
    expect(repeated.right).toEqual(processed.right);
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
