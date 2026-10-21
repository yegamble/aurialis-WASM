import { expect, test, type Page } from "@playwright/test";
import type { Track } from "../src/lib/types";
import { observeOutput, outputLevel } from "./live-output";
import { uploadProject } from "./workflow-fixture";

type SavedTrack = Track & { simpleCustom?: boolean };
type StateWrite = { tracks: SavedTrack[] };
type ObservedWindow = Window & { qaCanonicalWrites?: StateWrite[] };

async function savedTrack(page: Page, id: string): Promise<SavedTrack> {
  return page.evaluate((trackId) => {
    const raw = localStorage.getItem("aurialis-state-v1");
    if (!raw) throw new Error("Missing saved settings");
    const track = (JSON.parse(raw) as StateWrite).tracks.find((item) => item.id === trackId);
    if (!track) throw new Error("Missing source project");
    return track;
  }, id);
}

async function snapshot(page: Page, id: string) {
  await expect.poll(async () => {
    const transport = page.locator(".transport");
    return Number(await transport.getAttribute("data-parameter-version"))
      - Number(await transport.getAttribute("data-applied-version"));
  }).toBe(0);
  const output = await outputLevel(page);
  if (!output) throw new Error("Missing actual destination signal");
  return {
    track: await savedTrack(page, id), output,
    version: Number(await page.locator(".transport").getAttribute("data-parameter-version")),
    applied: Number(await page.locator(".transport").getAttribute("data-applied-version")),
    fresh: await page.getByRole("button", { name: "Download offline preview", exact: true }).count() === 1,
  };
}

async function mode(page: Page, id: string, value: "simple" | "advanced") {
  await page.getByRole("tab", { name: value, exact: true }).click();
  await expect.poll(async () => (await savedTrack(page, id)).mode).toBe(value);
}

async function customSelections(page: Page) {
  await expect(page.getByText("Custom settings", { exact: true })).toBeVisible();
  for (const name of ["Pop", "Hip-hop", "Rock", "Electronic", "Acoustic", "R&B", "Warm", "Open", "Punchy", "Intimate", "Wide", "Clean"]) {
    await expect(page.getByRole("button", { name, exact: true })).toHaveAttribute("aria-pressed", "false");
  }
}

test("Simple and Advanced share one audible settings snapshot without changing sound on a view switch", async ({ page }, info) => {
  test.setTimeout(120_000);
  await observeOutput(page);
  const id = await uploadProject(page, "qa-shared-settings.wav", 16);
  await page.getByRole("button", { name: "Render offline preview", exact: true }).click();
  await expect(page.getByRole("button", { name: "Download offline preview", exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Repeat track", exact: true }).click();
  await page.getByRole("slider", { name: "Playback volume", exact: true }).fill("1");
  const requests: string[] = [];
  page.on("request", (request) => { if (request.url().includes("/api/")) requests.push(request.url()); });
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect.poll(async () => (await outputLevel(page))?.rmsDbfs ?? -Infinity).toBeCloseTo(-19.03, 0);
  const evidence: { mode: "simple" | "advanced"; before: Awaited<ReturnType<typeof snapshot>>; after: Awaited<ReturnType<typeof snapshot>> }[] = [];
  const views = async (before: Awaited<ReturnType<typeof snapshot>>, values: ("simple" | "advanced")[]) => {
    for (const value of values) {
      await mode(page, id, value);
      const after = await snapshot(page, id);
      expect(after.track.advanced).toEqual(before.track.advanced);
      expect(after.version).toBe(before.version);
      expect(after.applied).toBe(before.applied);
      expect(after.output.generation).toBe(before.output.generation);
      expect(after.output.instanceId).toBe(before.output.instanceId);
      expect(after.fresh).toBe(before.fresh);
      await expect(page.locator(".transport")).toHaveAttribute("data-playing", "true");
      await expect.poll(async () => Math.abs(((await outputLevel(page))?.rmsDbfs ?? -Infinity) - before.output.rmsDbfs)).toBeLessThan(0.12);
      await expect(page.getByRole("button", { name: "Export", exact: true })).toBeEnabled();
      evidence.push({ mode: value, before, after });
    }
  };
  const neutral = await snapshot(page, id);
  expect(neutral.fresh).toBe(true);
  await views(neutral, ["simple", "advanced"]);
  await page.getByRole("slider", { name: "Input gain", exact: true }).fill("6");
  await page.getByRole("tab", { name: "Mid", exact: true }).click();
  await page.getByRole("slider", { name: "Mid gain", exact: true }).fill("3");
  await expect.poll(async () => (await outputLevel(page))?.rmsDbfs ?? -Infinity).toBeCloseTo(-10.03, 0);
  const manual = await snapshot(page, id);
  expect(manual.track.advanced.input).toBe(6);
  expect(manual.track.advanced.eqBands[2].gainDb).toBe(3);
  expect(manual.track.simpleCustom).toBe(true);
  expect(manual.fresh).toBe(false);
  await views(manual, ["simple", "advanced", "simple"]);
  await customSelections(page);

  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    (window as ObservedWindow).qaCanonicalWrites = [];
    Storage.prototype.setItem = function (key: string, value: string): void {
      if (key === "aurialis-state-v1") (window as ObservedWindow).qaCanonicalWrites?.push(JSON.parse(value) as StateWrite);
      Reflect.apply(original, this, [key, value]);
    };
  });
  for (const choice of ["Rock", "Clean"]) {
    await page.evaluate(() => { (window as ObservedWindow).qaCanonicalWrites = []; });
    const beforeVersion = Number(await page.locator(".transport").getAttribute("data-parameter-version"));
    await page.getByRole("button", { name: choice, exact: true }).click();
    await expect.poll(async () => (await savedTrack(page, id)).simpleCustom).toBe(false);
    await expect.poll(async () => Number(await page.locator(".transport").getAttribute("data-applied-version"))).toBe(beforeVersion + 1);
    const writes = await page.evaluate((trackId) => (window as ObservedWindow).qaCanonicalWrites?.map((state) => state.tracks.find((track) => track.id === trackId)), id);
    expect(writes).toHaveLength(1);
    expect(writes?.[0]?.advanced).toEqual((await savedTrack(page, id)).advanced);
  }
  const preset = await savedTrack(page, id);
  expect(preset.advanced.input).toBe(0);
  expect(preset.advanced.eqBands.map((band) => band.gainDb)).toEqual([0.3, 0, 0, 0.6, 0.5]);
  expect(preset.advanced.compressor).toMatchObject({ threshold: -15.5, ratio: 1.6, attack: 25, release: 200 });
  expect(preset.advanced.saturationModule).toMatchObject({ drive: 6.5, character: "Crisp" });
  await expect(page.getByRole("button", { name: "Rock", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Clean", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.waitForTimeout(650);
  await views(await snapshot(page, id), ["advanced", "simple", "advanced"]);
  await page.getByRole("slider", { name: "Input gain", exact: true }).fill("4");
  await mode(page, id, "simple");
  await customSelections(page);
  await page.getByRole("button", { name: "Rock", exact: true }).click();
  await expect.poll(async () => (await savedTrack(page, id)).advanced.input).toBe(0);
  await mode(page, id, "advanced");
  await page.getByRole("tab", { name: "Mid", exact: true }).click();
  await page.getByRole("slider", { name: "Mid gain", exact: true }).fill("2.5");
  await mode(page, id, "simple");
  await customSelections(page);
  const custom = await savedTrack(page, id);
  await page.getByRole("combobox", { name: "Output target", exact: true }).selectOption("Dynamic");
  await expect.poll(async () => (await savedTrack(page, id)).target).toBe("Dynamic");
  const target = await savedTrack(page, id);
  expect(target.simpleCustom).toBe(true);
  expect(target.advanced).toEqual({ ...custom.advanced, limiter: { ...custom.advanced.limiter, targetLufs: -16, ceiling: -1 } });
  await customSelections(page);
  expect(requests).toEqual([]);
  await info.attach("canonical settings and actual mode output", { body: JSON.stringify(evidence, null, 2), contentType: "application/json" });
});
