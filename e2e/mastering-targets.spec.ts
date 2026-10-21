import { expect, test, type Page } from "@playwright/test";
import type { Track } from "../src/lib/types";
import { uploadProject } from "./workflow-fixture";

type NativeParameters = { inputGainDb: number; limiter: { targetLufs: number; ceilingDbtp: number } };
type TargetWindow = Window & { qaTargetParameters?: NativeParameters[] };

async function savedTrack(page: Page, id: string): Promise<Track> {
  return page.evaluate((trackId) => {
    const raw = localStorage.getItem("aurialis-state-v1");
    if (!raw) throw new Error("Missing saved project");
    const state = JSON.parse(raw) as { tracks: Track[] };
    const track = state.tracks.find((item) => item.id === trackId);
    if (!track) throw new Error("Missing uploaded project");
    return track;
  }, id);
}

test("canonical loudness targets survive reset and custom project normalization", async ({ page }, info) => {
  test.setTimeout(90_000);
  await page.addInitScript(() => {
    const nativeFetch = window.fetch.bind(window);
    (window as TargetWindow).qaTargetParameters = [];
    window.fetch = (input, init) => {
      if (typeof input === "string" && input.endsWith("/api/master/render") && init?.body instanceof FormData) {
        const raw = init.body.get("params");
        if (typeof raw === "string") (window as TargetWindow).qaTargetParameters?.push(JSON.parse(raw) as NativeParameters);
      }
      return nativeFetch(input, init);
    };
  });
  const id = await uploadProject(page, "qa-canonical-target.wav", 3);
  await page.getByRole("tab", { name: "simple", exact: true }).click();
  await page.getByRole("combobox", { name: "Output target", exact: true }).selectOption("Loud");
  await expect.poll(async () => (await savedTrack(page, id)).advanced.limiter.targetLufs).toBe(-9);
  await page.getByRole("tab", { name: "advanced", exact: true }).click();
  await page.getByRole("button", { name: "Reset modules", exact: true }).click();
  await expect.poll(async () => (await savedTrack(page, id)).advanced.limiter.targetLufs).toBe(-14);
  const reset = (await savedTrack(page, id)).advanced;
  await page.getByRole("tab", { name: "simple", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Output target", exact: true })).toHaveValue("Streaming");
  await expect(page.getByText("Current target: −14 LUFS · ceiling −1 dBFS. Set target loudness measures these current settings.", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Rock", exact: true }).click();
  expect((await savedTrack(page, id)).advanced.limiter).toMatchObject({ targetLufs: -14, ceiling: -1 });

  // There is no arbitrary LUFS input. Seed a persisted custom/profile project,
  // then exercise the real UI and native normalization without mocking either.
  const custom = { ...reset, limiter: { ...reset.limiter, targetLufs: -12, ceiling: -0.7 } };
  await page.evaluate(({ id: trackId, advanced }) => {
    const raw = localStorage.getItem("aurialis-state-v1");
    if (!raw) throw new Error("Missing saved project");
    const state = JSON.parse(raw) as { tracks: Track[] };
    state.tracks = state.tracks.map((track) => track.id === trackId
      ? { ...track, mode: "simple", target: "Loud", simpleCustom: true, advanced }
      : track);
    localStorage.setItem("aurialis-state-v1", JSON.stringify(state));
  }, { id, advanced: custom });
  await page.reload();
  await expect(page.getByRole("button", { name: "Set target loudness", exact: true })).toBeEnabled({ timeout: 30_000 });
  await expect(page.getByRole("combobox", { name: "Output target", exact: true })).toHaveValue("custom");
  await expect(page.getByRole("option", { name: "Custom (−12 LUFS)", exact: true })).toBeAttached();
  await expect(page.getByText("Current target: −12 LUFS · ceiling −0.7 dBFS. Set target loudness measures these current settings.", { exact: true })).toBeVisible();
  await page.evaluate(() => { (window as TargetWindow).qaTargetParameters = []; });
  const measurements: { integratedLufs: number; truePeakDbtp: number }[] = [];
  const responses: Promise<void>[] = [];
  page.on("response", (response) => {
    if (response.url().endsWith("/api/master/render") && response.request().method() === "POST") {
      responses.push((async () => {
        expect(response.status()).toBe(200);
        const body = await response.json() as { afterMetrics: { integratedLufs: number; truePeakDbtp: number } };
        measurements.push(body.afterMetrics);
      })());
    }
  });
  await page.getByRole("button", { name: "Set target loudness", exact: true }).click();
  await expect(page.getByRole("button", { name: "Download offline preview", exact: true })).toBeVisible({ timeout: 30_000 });
  await Promise.all(responses);
  const params = await page.evaluate(() => (window as TargetWindow).qaTargetParameters);
  expect(params?.length).toBeGreaterThan(1);
  for (const value of params ?? []) expect(value.limiter).toMatchObject({ targetLufs: -12, ceilingDbtp: -0.7 });
  const last = measurements.at(-1);
  expect(last).toBeDefined();
  expect(Math.abs((last?.integratedLufs ?? -Infinity) + 12)).toBeLessThanOrEqual(0.2);
  expect(last?.truePeakDbtp).toBeLessThanOrEqual(-0.5);
  const normalized = (await savedTrack(page, id)).advanced;
  expect(normalized.input).not.toBe(custom.input);
  expect({ ...normalized, input: custom.input }).toEqual(custom);
  await info.attach("canonical-target-measurements", { body: JSON.stringify({ params, measurements, normalized }, null, 2), contentType: "application/json" });
});
