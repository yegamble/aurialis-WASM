import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { exportParams } from "../src/lib/engine-params";
import type { Track } from "../src/lib/types";
import { decode } from "./audio-fixture";
import { meanOutputLevel, observeOutput, outputLevel } from "./live-output";

function material(hot = false): Buffer {
  const rate = 48000, frames = rate * 4, wav = Buffer.alloc(44 + frames * 8);
  wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(3, 20); wav.writeUInt16LE(2, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 8, 28); wav.writeUInt16LE(8, 32); wav.writeUInt16LE(32, 34);
  wav.write("data", 36); wav.writeUInt32LE(frames * 8, 40);
  for (let frame = 0; frame < frames; frame++) {
    const t = frame / rate;
    const mid = hot ? .9 * Math.sin(2 * Math.PI * 4000 * t) : .07 * Math.sin(2 * Math.PI * 60 * t) + .05 * Math.sin(2 * Math.PI * 250 * t) + .16 * Math.sin(2 * Math.PI * 997 * t) + .1 * Math.sin(2 * Math.PI * 4000 * t) + .05 * Math.sin(2 * Math.PI * 9000 * t);
    const side = hot ? 0 : .02 * Math.sin(2 * Math.PI * 3001 * t);
    wav.writeFloatLE(mid + side, 44 + frame * 8); wav.writeFloatLE(mid - side, 48 + frame * 8);
  }
  return wav;
}
async function saved(page: Page): Promise<Track> {
  return page.evaluate(() => {
    const raw = localStorage.getItem("aurialis-state-v1"); if (!raw) throw new Error("Missing project");
    const id = location.pathname.split("/")[2];
    const track = (JSON.parse(raw) as { tracks: Track[] }).tracks.find((item) => item.id === id);
    if (!track) throw new Error("Missing track"); return track;
  });
}
async function upload(page: Page, source: Buffer) {
  await page.goto("/"); await page.getByLabel("Import audio file").setInputFiles({ name: "qa-simple-styles.wav", mimeType: "audio/wav", buffer: source });
  await expect(page).toHaveURL(/\/master\/track-/u); await expect(page.getByRole("button", { name: "Export", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Reset modules", exact: true }).click();
  await page.getByRole("tab", { name: "simple", exact: true }).click();
}
async function exported(page: Page) {
  await page.getByRole("button", { name: "Export", exact: true }).click(); const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "32-bit Float", exact: true }).click();
  const pending = page.waitForEvent("download"); await dialog.getByRole("button", { name: "Render & download WAV", exact: true }).click();
  const path = await (await pending).path(); if (!path) throw new Error("Missing downloaded PCM");
  const pcm = decode(await readFile(path)); await page.keyboard.press("Escape"); return pcm;
}
function level(pcm: ReturnType<typeof decode>) {
  const left = pcm.left.slice(-pcm.rate), right = pcm.right.slice(-pcm.rate);
  return 10 * Math.log10((left.reduce((sum, sample) => sum + sample * sample, 0) + right.reduce((sum, sample) => sum + sample * sample, 0)) / (left.length * 2));
}
async function settledLive(page: Page) {
  await expect.poll(async () => Number(await page.locator(".transport").getAttribute("data-parameter-version")) - Number(await page.locator(".transport").getAttribute("data-applied-version"))).toBe(0);
  const start = (await outputLevel(page))?.frames ?? 0;
  await expect.poll(async () => (await outputLevel(page))?.frames ?? 0).toBeGreaterThan(start + 48000);
  return meanOutputLevel(page);
}
for (const control of ["Metal", "Jazz", "Organic", "Precise", "Elevated", "Depth off", "Presence off"]) {
  test(`${control} independently changes actual live and exported PCM`, async ({ page, request }, info) => {
    test.setTimeout(90_000); await observeOutput(page); const source = material(); await upload(page, source);
    await page.getByRole("button", { name: "Warm", exact: true }).click(); await page.getByRole("slider", { name: "Intensity", exact: true }).fill("100");
    await page.getByRole("combobox", { name: "Output target", exact: true }).selectOption("Loud");
    if (control === "Precise") await page.getByRole("button", { name: "Organic", exact: true }).click();
    const before = await exported(page);
    await page.getByRole("slider", { name: "Playback volume", exact: true }).fill("1"); await page.getByRole("button", { name: "Repeat track", exact: true }).click(); await page.getByRole("button", { name: "Play", exact: true }).click();
    await expect.poll(async () => (await outputLevel(page))?.frames ?? 0).toBeGreaterThan(48000);
    const liveBefore = await settledLive(page);
    await page.getByRole("button", { name: control, exact: true }).click();
    await expect(page.getByRole("button", { name: control.endsWith(" off") ? control.replace(" off", " on") : control, exact: true })).toHaveAttribute("aria-pressed", "true");
    const afterTrack = await saved(page), after = await exported(page);
    const native = await request.post("/api/master/render", { multipart: { file: { name: "source.wav", mimeType: "audio/wav", buffer: source }, params: JSON.stringify(exportParams(afterTrack.advanced)), bitDepth: "32" } });
    expect(native.ok()).toBe(true); const expected = decode(await native.body());
    expect(after.left).toEqual(expected.left); expect(after.right).toEqual(expected.right);
    let difference = 0; for (let i = 0; i < before.left.length; i++) difference = Math.max(difference, Math.abs((before.left.at(i) ?? 0) - (after.left.at(i) ?? 0)), Math.abs((before.right.at(i) ?? 0) - (after.right.at(i) ?? 0)));
    expect(difference).toBeGreaterThan(1e-5);
    const liveAfter = await settledLive(page), nativeBefore = level(before), nativeAfter = level(after);
    expect(Math.abs(liveBefore - nativeBefore)).toBeLessThan(.1); expect(Math.abs(liveAfter - nativeAfter)).toBeLessThan(.1);
    expect(Math.abs(liveAfter - liveBefore)).toBeGreaterThan(.01);
    await info.attach("simple-output", { body: JSON.stringify({ control, difference, liveBefore, liveAfter, nativeBefore, nativeAfter, settings: afterTrack.advanced }), contentType: "application/json" });
  });
}

test("Elevated rejects actual excess loudness, accepts explicit gain correction and preserves it after reload", async ({ page }) => {
  await upload(page, material(true)); const before = (await saved(page)).advanced;
  await page.getByRole("button", { name: "Elevated", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Elevated exceeds" })).toBeVisible(); expect((await saved(page)).advanced).toEqual(before);
  await page.getByRole("tab", { name: "advanced", exact: true }).click(); await page.getByRole("slider", { name: "Input gain", exact: true }).fill("-18");
  await page.getByRole("tab", { name: "simple", exact: true }).click(); await page.getByRole("button", { name: "Elevated", exact: true }).click();
  await expect(page.getByText(/Rendered check:/u)).toBeVisible(); const accepted = await saved(page); expect(accepted.advanced.input).toBe(-18);
  await page.reload(); await expect(page.getByRole("button", { name: "Elevated", exact: true })).toHaveAttribute("aria-pressed", "true");
  expect((await saved(page)).advanced).toEqual(accepted.advanced);
});

test("Simple styles and combined modifiers retain keyboard, six-width accessibility and touch geometry", async ({ page }, info) => {
  test.setTimeout(90_000); await upload(page, material()); await page.getByRole("button", { name: "Jazz", exact: true }).click();
  await page.getByRole("button", { name: "Organic", exact: true }).click(); await page.getByRole("button", { name: "Depth off", exact: true }).click(); await page.getByRole("button", { name: "Presence off", exact: true }).click();
  for (const width of [320, 375, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 900 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
    for (const control of await page.locator('.inspector button, .inspector input[type="range"], .inspector select').all()) {
      if (!(await control.isVisible())) continue; const box = await control.boundingBox(); expect(box?.width).toBeGreaterThanOrEqual(44); expect(box?.height).toBeGreaterThanOrEqual(44);
    }
    expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);
    if (width === 320 || width === 1440) await info.attach(`simple-${width}`, { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
  }
  const slider = page.getByRole("slider", { name: "Intensity", exact: true }); await slider.focus(); await page.keyboard.press("ArrowRight"); expect((await saved(page)).intensity).toBe(51);
});

for (const [genre, related] of [["Metal", "Rock"], ["Jazz", "Acoustic"]] as const) {
  test(`${genre} and ${related} retain distinct existing exported recipes`, async ({ page }, info) => {
    test.setTimeout(90_000); await upload(page, material());
    await page.getByRole("slider", { name: "Intensity", exact: true }).fill("100");
    await page.getByRole("button", { name: related, exact: true }).click(); const parent = await exported(page);
    await page.getByRole("button", { name: genre, exact: true }).click(); const chosen = await exported(page);
    expect(chosen.rate).toBe(parent.rate); expect(chosen.left).toHaveLength(parent.left.length);
    let maximumDelta = 0, residualPower = 0;
    for (let index = parent.rate; index < parent.left.length; index++) {
      for (const [a, b] of [[chosen.left.at(index) ?? 0, parent.left.at(index) ?? 0], [chosen.right.at(index) ?? 0, parent.right.at(index) ?? 0]]) {
        const delta = (a ?? 0) - (b ?? 0); maximumDelta = Math.max(maximumDelta, Math.abs(delta)); residualPower += delta * delta;
      }
    }
    const residualDbfs = 10 * Math.log10(residualPower / (2 * (parent.left.length - parent.rate)));
    expect(maximumDelta).toBeGreaterThan(1e-5); expect(residualDbfs).toBeGreaterThan(-100);
    await info.attach("existing-genre-recipe-pcm", { body: JSON.stringify({ genre, related, maximumDelta, residualDbfs, chosenRmsDbfs: level(chosen), relatedRmsDbfs: level(parent) }), contentType: "application/json" });
  });
}
