import { expect, test, type Page } from "@playwright/test";
import { fixture } from "./audio-fixture";
import { observeOutput, outputLevel } from "./live-output";

async function startTone(page: Page, frequency: number, hot = false) {
  await observeOutput(page);
  const wav = fixture(frequency, 60);
  if (hot) {
    for (let offset = 44; offset < wav.length; offset += 2)
      wav.writeInt16LE(wav.readInt16LE(offset) * 3, offset);
  }
  await page.goto("/");
  await page.getByLabel("Upload audio file").setInputFiles({ name: `qa-extended-${frequency}.wav`, mimeType: "audio/wav", buffer: wav });
  await expect(page).toHaveURL(/\/master\/track-/, { timeout: 30_000 });
  await expect(page.getByRole("button", { name: "A Processed", exact: true })).toBeEnabled();
  await page.getByRole("slider", { name: "Playback volume", exact: true }).fill("1");
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(page.locator(".transport")).toHaveAttribute("data-playing", "true");
  await expect.poll(async () => (await outputLevel(page))?.rmsDbfs ?? -Infinity).toBeCloseTo(hot ? -9.49 : -19.03, 0);
  const initial = await outputLevel(page);
  if (!initial) throw new Error("Missing actual live output");
  return initial;
}

async function level(page: Page) { return (await outputLevel(page))?.rmsDbfs ?? -Infinity; }
async function slider(page: Page, name: string, value: number) {
  await page.getByRole("slider", { name, exact: true }).fill(String(value));
}
async function sameGraph(page: Page, instanceId: string, frames: number) {
  await expect(page.locator(".transport")).toHaveAttribute("data-playing", "true");
  const output = await outputLevel(page);
  expect(output?.instanceId).toBe(instanceId);
  expect(output?.frames ?? 0).toBeGreaterThan(frames);
  await expect(page.locator(".workspace-canvas").getByRole("alert")).toHaveCount(0);
}

// The observer captures real speaker-feed PCM. Mid/side arithmetic here is an
// independent measurement, not a replacement processing graph.
async function midSideLevel(page: Page, channel: "mid" | "side") {
  return page.evaluate((which) => {
    const probe = (window as unknown as { qaOutput?: { left: number[]; right: number[] } }).qaOutput;
    if (!probe?.left.length) return -Infinity;
    let energy = 0;
    for (let i = 0; i < probe.left.length; i++) {
      const sample = ((probe.left[i] ?? 0) + (which === "mid" ? 1 : -1) * (probe.right[i] ?? 0)) / 2;
      energy += sample * sample;
    }
    return 10 * Math.log10(energy / probe.left.length);
  }, channel);
}

test("live mid/side and compressor makeup gains change measured output without restarting", async ({ page }) => {
  const initial = await startTone(page, 1000);
  await slider(page, "Mid channel gain", 6);
  // Source Mid=.15, Side=.05. The independent path must retain its own level.
  await expect.poll(() => midSideLevel(page, "mid")).toBeCloseTo(-13.49, 0);
  await expect.poll(() => midSideLevel(page, "side")).toBeCloseTo(-29.03, 0);
  await slider(page, "Side channel gain", -6);
  await expect.poll(() => midSideLevel(page, "side")).toBeCloseTo(-35.03, 0);
  await expect.poll(() => midSideLevel(page, "mid")).toBeCloseTo(-13.49, 0);
  await page.getByRole("slider", { name: "Mid channel gain", exact: true }).dblclick();
  await page.getByRole("slider", { name: "Side channel gain", exact: true }).dblclick();
  await expect(page.getByRole("slider", { name: "Mid channel gain", exact: true })).toHaveValue("0");
  await expect.poll(() => level(page)).toBeCloseTo(-19.03, 0);
  await slider(page, "Makeup gain", 6);
  await expect.poll(() => level(page)).toBeCloseTo(-13.03, 0);
  await sameGraph(page, initial.instanceId, initial.frames);
});

test("live De-Harsh bounds its selected-frequency cut and bypass restores the source", async ({ page }) => {
  const initial = await startTone(page, 4500, true);
  await slider(page, "De-Harsh frequency", 4500);
  await slider(page, "De-Harsh threshold", -60);
  await slider(page, "De-Harsh range", 6);
  await page.getByLabel("Enable De-Harsh", { exact: true }).check();
  await expect.poll(() => level(page)).toBeCloseTo(-15.49, 0);
  await slider(page, "De-Harsh frequency", 1000);
  await expect.poll(() => level(page)).toBeGreaterThan(-11);
  await page.getByLabel("Enable De-Harsh", { exact: true }).uncheck();
  await expect.poll(() => level(page)).toBeCloseTo(-9.49, 0);
  await sameGraph(page, initial.instanceId, initial.frames);
});

test("live low-band compression and Tube coloration have audible effects with transparent Clean", async ({ page }) => {
  const initial = await startTone(page, 80, true);
  for (const band of ["Low", "Mid", "High"])
    await slider(page, `${band} band ratio`, 1);
  await page.getByLabel("Enable multiband", { exact: true }).check();
  await expect.poll(() => level(page)).toBeCloseTo(-9.49, 0);
  await slider(page, "Low band threshold", -40);
  await slider(page, "Low band ratio", 8);
  await expect.poll(() => level(page)).toBeLessThan(-15);
  await page.getByLabel("Enable multiband", { exact: true }).uncheck();
  await expect.poll(() => level(page)).toBeCloseTo(-9.49, 0);
  await page.getByRole("button", { name: "Tube", exact: true }).click();
  await slider(page, "Saturation", 100);
  await expect.poll(() => level(page)).toBeLessThan(-12);
  await page.getByRole("button", { name: "Clean", exact: true }).click();
  await expect(page.getByRole("slider", { name: "Saturation", exact: true })).toBeDisabled();
  await expect.poll(() => level(page)).toBeCloseTo(-9.49, 0);
  await sameGraph(page, initial.instanceId, initial.frames);
});
