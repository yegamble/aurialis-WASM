import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { decode } from "./audio-fixture";
import { uploadProject } from "./workflow-fixture";
import type { AdvancedParams } from "../src/lib/types";

async function previewPCM(page: Page) {
  const bytes = await page.locator("audio").evaluate(async (audio: HTMLAudioElement) => Array.from(new Uint8Array(await (await fetch(audio.src)).arrayBuffer())));
  return decode(Buffer.from(bytes));
}
async function exportPCM(page: Page) {
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "32-bit Float", exact: true }).click();
  const waiting = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Render & download WAV", exact: true }).click();
  const download = await waiting;
  const path = await download.path();
  if (!path) throw new Error("Missing download");
  const pcm = decode(await readFile(path));
  await page.keyboard.press("Escape");
  return pcm;
}

test("EQ handles support keyboard and dragging without changing other bands or modules", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const id = await uploadProject(page);
  const settings = () => page.evaluate((id) => {
    const raw = localStorage.getItem("aurialis-state-v1");
    if (!raw) throw new Error("Missing project settings");
    const track = (JSON.parse(raw) as { tracks: { id: string; advanced: AdvancedParams }[] }).tracks.find((track) => track.id === id);
    if (!track) throw new Error("Missing uploaded project");
    return track.advanced;
  }, id);
  const before = await settings();
  const handle = page.locator(".eq-handle").nth(2);
  await handle.focus();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowRight");
  const keyboard = await settings();
  expect(keyboard.eqBands[2].gainDb).toBe(before.eqBands[2].gainDb + 0.5);
  expect(keyboard.eqBands[2].freqHz).toBeGreaterThan(before.eqBands[2].freqHz);
  const box = await handle.boundingBox();
  if (!box) throw new Error("Missing EQ touch target");
  expect(box.width).toBeGreaterThanOrEqual(44);
  expect(box.height).toBeGreaterThanOrEqual(44);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 35, box.y + box.height / 2 - 15, { steps: 5 });
  await page.mouse.up();
  const dragged = await settings();
  expect(dragged.eqBands[2].gainDb).not.toBe(keyboard.eqBands[2].gainDb);
  for (const actual of [keyboard, dragged]) {
    for (const index of [0, 1, 3, 4]) expect(actual.eqBands[index]).toEqual(before.eqBands[index]);
    expect({ ...actual, eqBands: before.eqBands }).toEqual(before);
  }
});

test("first Simple apply previews exactly the settings exported from the uploaded source", async ({ page }) => {
  test.setTimeout(120_000);
  await uploadProject(page);
  await page.getByRole("tab", { name: "simple", exact: true }).click();
  await page.getByRole("button", { name: "Apply master direction", exact: true }).click();
  await expect(page.getByRole("button", { name: "B Processed", exact: true })).toBeEnabled({ timeout: 30_000 });
  await expect(page.getByText("Preview matches your settings.", { exact: true })).toBeVisible();
  await expect.poll(() => page.locator("audio").evaluate((audio: HTMLAudioElement) => audio.readyState)).toBeGreaterThanOrEqual(2);
  await page.getByRole("button", { name: "Open", exact: true }).click();
  await expect(page.getByRole("button", { name: "B Processed", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "Apply master direction", exact: true }).click();
  await expect(page.getByRole("button", { name: "B Processed", exact: true })).toBeEnabled({ timeout: 30_000 });
  await expect(page.getByText("Preview matches your settings.", { exact: true })).toBeVisible();
  await expect.poll(() => page.locator("audio").evaluate((audio: HTMLAudioElement) => audio.readyState)).toBeGreaterThanOrEqual(2);
  const preview = await previewPCM(page);
  const exported = await exportPCM(page);
  expect(preview.left).toHaveLength(exported.left.length);
  for (const channel of ["left", "right"] as const) {
    expect(Math.max(...preview[channel].map((sample, index) => Math.abs(sample - (exported[channel][index] ?? Infinity))))).toBeLessThan(1e-5);
  }
});

test("re-applying an unchanged Simple direction never compounds EQ or other settings", async ({ page }) => {
  test.setTimeout(120_000);
  await uploadProject(page);
  await page.getByRole("tab", { name: "simple", exact: true }).click();
  await page.getByRole("button", { name: "Rock", exact: true }).click();
  await page.getByRole("button", { name: "Clean", exact: true }).click();
  const snapshots: unknown[] = [];
  for (let repeat = 0; repeat < 3; repeat++) {
    const apply = page.getByRole("button", { name: "Apply master direction", exact: true });
    await apply.click();
    await expect(apply).toBeEnabled({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: "B Processed", exact: true })).toBeEnabled({ timeout: 30_000 });
    snapshots.push(await page.evaluate(() => {
      const raw = localStorage.getItem("aurialis-state-v1");
      if (!raw) throw new Error("Missing project settings");
      return (JSON.parse(raw) as { tracks: { advanced: unknown }[] }).tracks[0]?.advanced;
    }));
  }
  expect(snapshots[0]).toBeDefined();
  expect(snapshots[1]).toEqual(snapshots[0]);
  expect(snapshots[2]).toEqual(snapshots[0]);
});

test("A/B switches preserve playback and retain matched level after repeated metadata events", async ({ page }) => {
  await uploadProject(page, "qa-comparison.wav", 3);
  await page.getByRole("slider", { name: "Input gain", exact: true }).fill("6");
  await page.getByRole("button", { name: "Render preview", exact: true }).click();
  await expect(page.getByRole("button", { name: "B Processed", exact: true })).toBeEnabled({ timeout: 30_000 });
  await expect.poll(() => page.locator("audio").evaluate((audio: HTMLAudioElement) => audio.readyState)).toBeGreaterThanOrEqual(2);
  await page.getByRole("button", { name: "Match level", exact: true }).click();
  const audio = page.locator("audio");
  await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.volume)).toBeCloseTo(0.4, 2);
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.currentTime)).toBeGreaterThan(0.1);
  const before = await audio.evaluate((element: HTMLAudioElement) => element.currentTime);
  await page.getByRole("button", { name: "A Original", exact: true }).click();
  await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.paused)).toBe(false);
  await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.currentTime)).toBeGreaterThan(before - 0.03);
  await page.getByRole("button", { name: "B Processed", exact: true }).click();
  await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.volume)).toBeCloseTo(0.4, 2);
  await expect.poll(() => audio.evaluate((element: HTMLAudioElement) => element.paused)).toBe(false);
});

test("reference settings honor unchecked width and protected low bands", async ({ page }) => {
  const sourceId = await uploadProject(page, "qa-source.wav");
  const referenceId = await uploadProject(page, "qa-reference.wav");
  await page.getByRole("slider", { name: "Stereo width", exact: true }).fill("140");
  await page.getByRole("tab", { name: "Sub", exact: true }).click();
  await page.getByRole("slider", { name: "Sub gain", exact: true }).fill("6");
  await page.getByRole("tab", { name: "Presence", exact: true }).click();
  await page.getByRole("slider", { name: "Presence gain", exact: true }).fill("4");
  await page.goto(`/reference/${sourceId}`);
  await page.getByRole("combobox", { name: "Reference track", exact: true }).selectOption(referenceId);
  await expect(page.getByRole("checkbox", { name: "Include width", exact: true })).not.toBeChecked();
  await page.getByRole("button", { name: "Apply EQ settings", exact: true }).click();
  await expect(page.getByRole("slider", { name: "Stereo width", exact: true })).toHaveValue("100");
  await page.getByRole("tab", { name: "Sub", exact: true }).click();
  await expect(page.getByRole("slider", { name: "Sub gain", exact: true })).toHaveValue("0");
  await page.getByRole("tab", { name: "Presence", exact: true }).click();
  await expect(page.getByRole("slider", { name: "Presence gain", exact: true })).toHaveValue("2.5");
});

test("album processing produces real full-length WAVs and release checks measure rendered audio", async ({ page, request }) => {
  const id = await uploadProject(page, "qa-album-source.wav");
  await page.goto("/albums");
  await page.getByRole("button", { name: "New album", exact: true }).click();
  await page.getByRole("link", { name: /Untitled sequence 1/ }).click();
  await page.getByRole("button", { name: "qa album source", exact: true }).click();
  await page.getByRole("button", { name: "Render album masters", exact: true }).click();
  const downloadButton = page.getByRole("button", { name: "Download qa album source", exact: true });
  await expect(downloadButton).toBeVisible();
  const waiting = page.waitForEvent("download");
  await downloadButton.click();
  const download = await waiting;
  const path = await download.path();
  if (!path) throw new Error("Missing album WAV");
  const pcm = decode(await readFile(path));
  expect(pcm.bits).toBe(24);
  expect(pcm.left).toHaveLength(48000);
  expect(pcm.left.some((value) => Math.abs(value) > 0.01)).toBe(true);
  await page.goto(`/release-check/${id}`);
  const pendingMeasurement = page.waitForResponse((response) => response.url().endsWith("/api/master/render") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Run release check", exact: true }).click();
  const measurement = await (await pendingMeasurement).json() as { afterMetrics: { integratedLufs: number; samplePeakDbfs: number } };
  await expect(page.getByText(`${measurement.afterMetrics.integratedLufs.toFixed(1)} LUFS`, { exact: true })).toBeVisible();
  await expect(page.getByText(`${measurement.afterMetrics.samplePeakDbfs.toFixed(1)} dBFS`, { exact: true })).toBeVisible();
  await expect(page.getByText("Unmeasured", { exact: false })).toHaveCount(0);
  expect((await request.get("/health")).ok()).toBe(true);
});

test("each visible audio slider changes its own settings without mutating another module", async ({ page }) => {
  await uploadProject(page);
  const settings = async () => page.evaluate(() => {
    const raw = localStorage.getItem("aurialis-state-v1");
    if (!raw) throw new Error("Missing persisted project settings");
    return (JSON.parse(raw) as { tracks: { advanced: Record<string, unknown> }[] }).tracks[0]?.advanced;
  });
  const cases = [
    { label: "Input gain", value: "3", changed: ["input"] },
    { label: "Threshold", value: "-24", changed: ["threshold", "compressor"] },
    { label: "Ratio", value: "4", changed: ["ratio", "compressor"] },
    { label: "Attack", value: "40", changed: ["attack", "compressor"] },
    { label: "Release", value: "180", changed: ["release", "compressor"] },
    { label: "Stereo width", value: "125", changed: ["width", "stereo"] },
    { label: "Saturation", value: "20", changed: ["saturation", "saturationModule"] },
    { label: "Limiter ceiling", value: "-2", changed: ["limiter"] },
  ];
  for (const item of cases) {
    const before = await settings();
    const slider = page.getByRole("slider", { name: item.label, exact: true });
    await slider.fill(item.value);
    await expect(slider).toHaveValue(item.value);
    const after = await settings();
    if (!before || !after) throw new Error("Missing advanced settings");
    expect(after, `${item.label} must change the project`).not.toEqual(before);
    for (const key of Object.keys(before).filter((key) => !item.changed.includes(key))) {
      expect(after[key], `${item.label} changed unrelated ${key}`).toEqual(before[key]);
    }
  }
  for (const band of ["Sub", "Low", "Mid", "Presence", "Air"]) {
    await page.getByRole("tab", { name: band, exact: true }).click();
    for (const [field, value] of [["gain", "3"], ["frequency", "1500"], ["Q", "2"]]) {
      const before = await settings();
      if (!before) throw new Error("Missing baseline EQ settings");
      const slider = page.getByRole("slider", { name: `${band} ${field}`, exact: true });
      await slider.fill(value!);
      const after = await settings();
      if (!after) throw new Error("Missing updated EQ settings");
      for (const key of Object.keys(before).filter((key) => key !== "eqBands")) expect(after[key]).toEqual(before[key]);
      const oldBands = before.eqBands as { label: string }[];
      const newBands = after.eqBands as { label: string }[];
      for (let index = 0; index < oldBands.length; index++) {
        if (oldBands[index]?.label !== band) expect(newBands[index], `${band} ${field} changed another band`).toEqual(oldBands[index]);
      }
    }
  }
});
