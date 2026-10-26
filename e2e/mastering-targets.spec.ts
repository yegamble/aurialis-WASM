import { readFile } from "node:fs/promises";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import type { Track } from "../src/lib/types";
import { denseFixture, uploadProject } from "./workflow-fixture";

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

type MeasuredLevel = { integratedLufs: number; truePeakDbtp: number };

/** Native BS.1770 loudness and 4x true peak of a WAV, unprocessed. */
async function measureWAV(request: APIRequestContext, buffer: Buffer): Promise<MeasuredLevel> {
  const response = await request.post("/api/master/render", { multipart: { file: { name: "measure.wav", mimeType: "audio/wav", buffer }, params: JSON.stringify({ bypass: true }), format: "json" } });
  expect(response.status()).toBe(200);
  return (await response.json() as { beforeMetrics: MeasuredLevel }).beforeMetrics;
}

// A dense program needs limiting to reach these targets. Normalization must
// measure the export algorithm (true-peak limiter), not the live sample-peak
// limiter whose inter-sample overshoot used to reject it.
for (const { name, targetLufs, ceiling } of [{ name: "Streaming", targetLufs: -14, ceiling: -1 }, { name: "Loud", targetLufs: -9, ceiling: -0.2 }]) {
  test(`Set target loudness exports a dense program at the ${name} target`, async ({ page, request }, info) => {
    test.setTimeout(180_000);
    const source = await measureWAV(request, denseFixture(8));
    expect(source.integratedLufs).toBeGreaterThan(-17);
    expect(source.integratedLufs).toBeLessThan(-15);
    expect(source.truePeakDbtp).toBeGreaterThan(-1.2);
    expect(source.truePeakDbtp).toBeLessThan(-0.4);
    const id = await uploadProject(page, `qa-dense-${name.toLowerCase()}.wav`, 8, "dense");
    await page.getByRole("tab", { name: "simple", exact: true }).click();
    // A Simple direction enables the limiter that every named target relies on.
    await page.getByRole("button", { name: "Pop", exact: true }).click();
    await page.getByRole("button", { name: "Clean", exact: true }).click();
    await page.getByRole("combobox", { name: "Output target", exact: true }).selectOption(name);
    await expect.poll(async () => (await savedTrack(page, id)).advanced.limiter).toMatchObject({ enabled: true, targetLufs, ceiling });
    const before = (await savedTrack(page, id)).advanced;
    const apply = page.getByRole("button", { name: "Set target loudness", exact: true });
    await apply.click();
    await expect(page.getByRole("button", { name: "Setting loudness…", exact: true })).toHaveCount(0, { timeout: 120_000 });
    await expect(apply).toBeEnabled();
    await expect(page.getByText(/exceeds the measured peak ceiling|could not be reached/u)).toHaveCount(0);
    await expect.poll(async () => (await savedTrack(page, id)).advanced.input).not.toBe(before.input);
    // The status reports the export measurement, not the algorithm 1 preview.
    const summary = page.getByText(/^Preview ready\. Export measures (−?\d+\.\d{2}) LUFS, (−?\d+\.\d{2}) dBTP\. Live meters and the offline preview use the preview limiter and can read higher\.$/u);
    await expect(summary).toBeVisible();
    const [, statusLufs, statusPeak] = /Export measures (−?\d+\.\d{2}) LUFS, (−?\d+\.\d{2}) dBTP/u.exec(await summary.innerText()) ?? [];

    await page.getByRole("button", { name: "Export", exact: true }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: "24-bit PCM", exact: true }).click();
    const pending = page.waitForEvent("download");
    await dialog.getByRole("button", { name: "Render & download WAV", exact: true }).click();
    const download = await pending;
    expect(await download.failure()).toBeNull();
    const path = await download.path();
    const exported = await measureWAV(request, await readFile(path));
    await info.attach(`dense-${name}-levels`, { body: JSON.stringify({ source, input: (await savedTrack(page, id)).advanced.input, exported }, null, 2), contentType: "application/json" });
    expect(Math.abs(exported.integratedLufs - targetLufs)).toBeLessThanOrEqual(0.2);
    expect(exported.truePeakDbtp).toBeLessThanOrEqual(ceiling);
    expect(Number(statusLufs?.replace("−", "-"))).toBeCloseTo(exported.integratedLufs, 1);
    expect(Number(statusPeak?.replace("−", "-"))).toBeCloseTo(exported.truePeakDbtp, 1);
  });
}

test("Elevated accepts a dense program whose export true peak meets the ceiling", async ({ page }, info) => {
  test.setTimeout(120_000);
  const id = await uploadProject(page, "qa-dense-elevated.wav", 8, "dense");
  await page.getByRole("tab", { name: "simple", exact: true }).click();
  await page.getByRole("button", { name: "Pop", exact: true }).click();
  // +2 dB drives the limiter: the live sample-peak limiter overshoots the
  // ceiling between samples here, the export true-peak limiter does not.
  await page.getByRole("tab", { name: "advanced", exact: true }).click();
  await page.getByRole("slider", { name: "Input gain", exact: true }).fill("2");
  await page.getByRole("tab", { name: "simple", exact: true }).click();
  await page.getByRole("button", { name: "Elevated", exact: true }).click();
  const check = page.getByText(/^Rendered check: (-?\d+\.\d) LUFS · (-?\d+\.\d{2}) dBTP\.$/u);
  await expect(check).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole("alert").filter({ hasText: "Elevated exceeds" })).toHaveCount(0);
  const [, , peak] = /(-?\d+\.\d) LUFS · (-?\d+\.\d{2}) dBTP/u.exec(await check.innerText()) ?? [];
  await info.attach("dense-elevated-check", { body: await check.innerText(), contentType: "text/plain" });
  const { ceiling } = (await savedTrack(page, id)).advanced.limiter;
  expect(Number(peak)).toBeLessThanOrEqual(ceiling);
  await expect(page.getByRole("button", { name: "Elevated", exact: true })).toHaveAttribute("aria-pressed", "true");
  expect((await savedTrack(page, id)).advanced.input).toBe(2);
});
