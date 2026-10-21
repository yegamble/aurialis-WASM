import { expect, test, type Page } from "@playwright/test";
import { fixture } from "./audio-fixture";
import { observeOutput, outputLevel } from "./live-output";
import { uploadProject } from "./workflow-fixture";

async function play(page: Page) {
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(page.locator(".transport")).toHaveAttribute("data-playing", "true");
  await expect.poll(async () => (await outputLevel(page))?.frames ?? 0).toBeGreaterThan(1024);
}

async function audibleDb(page: Page) {
  return (await outputLevel(page))?.rmsDbfs ?? -Infinity;
}

test("live A processed / B original share a clock and gain and EQ change actual output", async ({ page }, info) => {
  await observeOutput(page);
  await uploadProject(page, "qa-live-controls.wav", 16);
  await page.getByRole("slider", { name: "Playback volume", exact: true }).fill("1");
  await page.getByRole("slider", { name: "Input gain", exact: true }).fill("6");
  await expect(page.getByRole("button", { name: "A Processed", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Match level", exact: true })).toHaveCount(0);
  const requests: string[] = [];
  page.on("request", (request) => { if (request.url().includes("/api/")) requests.push(request.url()); });
  await play(page);
  await expect.poll(() => audibleDb(page)).toBeCloseTo(-13.03, 0);
  const processed = await outputLevel(page);
  const before = Number(await page.locator(".transport").getAttribute("data-position"));
  await page.getByRole("button", { name: "B Original", exact: true }).click();
  await expect.poll(() => audibleDb(page)).toBeCloseTo(-19.03, 0);
  await expect(page.locator(".transport")).toHaveAttribute("data-playing", "true");
  expect(Number(await page.locator(".transport").getAttribute("data-position"))).toBeGreaterThanOrEqual(before);
  await page.getByRole("button", { name: "A Processed", exact: true }).click();
  await expect.poll(() => audibleDb(page)).toBeCloseTo(-13.03, 0);
  await page.getByRole("tab", { name: "Mid", exact: true }).click();
  const previousVersion = Number(await page.locator(".transport").getAttribute("data-parameter-version"));
  await page.evaluate((before) => {
    const timing = { start: 0, applied: 0 };
    (window as unknown as { qaParameterTiming: typeof timing }).qaParameterTiming = timing;
    document.addEventListener("input", (event) => {
      if ((event.target as Element).getAttribute("aria-label") === "Mid gain") timing.start = performance.now();
    }, { capture: true });
    const transport = document.querySelector(".transport");
    if (!transport) throw new Error("Missing live transport");
    const observer = new MutationObserver(() => {
      const version = Number(transport.getAttribute("data-parameter-version"));
      if (timing.start && version > before && version === Number(transport.getAttribute("data-applied-version"))) {
        timing.applied = performance.now();
        observer.disconnect();
      }
    });
    observer.observe(transport, { attributes: true });
  }, previousVersion);
  await page.getByRole("slider", { name: "Mid gain", exact: true }).fill("6");
  await expect.poll(async () => {
    const transport = page.locator(".transport");
    const version = Number(await transport.getAttribute("data-parameter-version"));
    return version > previousVersion && version === Number(await transport.getAttribute("data-applied-version"));
  }, { intervals: [20] }).toBe(true);
  const parameterLatencyMs = await page.evaluate(() => {
    const timing = (window as unknown as { qaParameterTiming: { start: number; applied: number } }).qaParameterTiming;
    if (!timing.start || !timing.applied) throw new Error("Missing live parameter timing");
    return timing.applied - timing.start;
  });
  expect(parameterLatencyMs).toBeLessThan(250);
  await expect.poll(() => audibleDb(page)).toBeCloseTo(-7.03, 0);
  await expect(page.locator(".transport")).toHaveAttribute("data-playing", "true");
  const eq = await outputLevel(page);
  expect(requests, "live edits and A/B must not submit native whole-track jobs").toEqual([]);
  await expect(page.locator(".live-spectrum polyline")).toBeVisible();
  const colors = await page.locator(".wave-bars > i").evaluateAll((bars) => bars.map((bar) => getComputedStyle(bar).backgroundColor));
  expect(new Set(colors).size, "played and remaining waveform samples need distinct colors").toBe(2);
  await info.attach("actual-speaker-output", { body: JSON.stringify({ processed, eq, parameterLatencyMs }, null, 2), contentType: "application/json" });
});

test("meters and measured spectrum follow tone into silence instead of whole-track statistics", async ({ page }) => {
  await observeOutput(page);
  const wav = fixture(997, 10);
  wav.fill(0, 44 + 48000 * 4 * 2);
  await page.goto("/");
  await page.getByLabel("Upload audio file").setInputFiles({ name: "qa-tone-then-silence.wav", mimeType: "audio/wav", buffer: wav });
  await expect(page).toHaveURL(/\/master\/track-/, { timeout: 30_000 });
  await expect(page.getByRole("button", { name: "A Processed", exact: true })).toBeEnabled();
  await page.getByRole("slider", { name: "Playback volume", exact: true }).fill("1");
  await play(page);
  await expect.poll(() => audibleDb(page)).toBeGreaterThan(-21);
  const spectrum = page.locator(".live-spectrum polyline");
  await expect(spectrum).toBeVisible();
  const tonePoints = await spectrum.getAttribute("points");
  await expect.poll(() => audibleDb(page), { timeout: 8000 }).toBeLessThan(-100);
  const levels = page.getByRole("region", { name: "Measured audio levels", exact: true });
  await expect(levels).toContainText("−∞");
  await expect.poll(() => spectrum.getAttribute("points")).not.toBe(tonePoints);
  await expect(page.locator(".live-spectrum")).toContainText("Below −100 dB");
  await expect(page.locator(".transport")).toHaveAttribute("data-playing", "true");
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(page.locator(".transport")).toHaveAttribute("data-playing", "false");
  await expect(page.locator(".live-spectrum")).toContainText("Waiting for playback");
});

test("leave, reopen, reload and switch tracks without losing playable saved audio", async ({ page }) => {
  await observeOutput(page);
  const first = await uploadProject(page, "qa-return-first.wav", 12);
  await page.getByRole("slider", { name: "Playback volume", exact: true }).fill("1");
  await page.getByRole("slider", { name: "Input gain", exact: true }).fill("6");
  await play(page);
  await expect.poll(() => audibleDb(page)).toBeCloseTo(-13.03, 0);
  const firstInstance = (await outputLevel(page))?.instanceId;
  await page.getByRole("link", { name: "Library", exact: true }).first().click();
  await expect(page).toHaveURL(/\/library$/);
  const api: string[] = [];
  await page.route("**/api/**", async (route) => { api.push(route.request().url()); await route.abort("failed"); });
  await page.getByRole("link", { name: /qa return first/ }).click();
  await expect(page.getByRole("slider", { name: "Input gain", exact: true })).toHaveValue("6");
  await page.getByRole("slider", { name: "Playback volume", exact: true }).fill("1");
  await play(page);
  await expect.poll(() => audibleDb(page)).toBeCloseTo(-13.03, 0);
  expect((await outputLevel(page))?.instanceId).not.toBe(firstInstance);
  expect(api, "cached source preparation must not need a native request").toEqual([]);
  await page.reload();
  await expect(page.getByRole("button", { name: "Play", exact: true })).toBeEnabled();
  await page.getByRole("slider", { name: "Playback volume", exact: true }).fill("1");
  await play(page);
  await expect.poll(() => audibleDb(page)).toBeCloseTo(-13.03, 0);
  await page.unroute("**/api/**");
  await uploadProject(page, "qa-return-second.wav", 12);
  await expect(page.getByRole("slider", { name: "Input gain", exact: true })).toHaveValue("0");
  await page.getByRole("slider", { name: "Input gain", exact: true }).fill("-6");
  await page.getByRole("slider", { name: "Playback volume", exact: true }).fill("1");
  await play(page);
  await expect.poll(() => audibleDb(page)).toBeCloseTo(-25.03, 0);
  await page.goto(`/master/${first}`);
  await expect(page.getByRole("slider", { name: "Input gain", exact: true })).toHaveValue("6");
  await page.getByRole("slider", { name: "Playback volume", exact: true }).fill("1");
  await play(page);
  await expect.poll(() => audibleDb(page)).toBeCloseTo(-13.03, 0);
});
