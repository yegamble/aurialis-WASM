import { expect, test } from "@playwright/test";
import { observeOutput, outputLevel } from "./live-output";
import { uploadProject } from "./workflow-fixture";

test("Next preserves playback and volume through the packaged route transition", async ({ page }) => {
  await observeOutput(page);
  const first = await uploadProject(page, "queue-first.wav", 16);
  await page.getByRole("slider", { name: "Input gain", exact: true }).fill("-6");
  await uploadProject(page, "queue-newest.wav", 16);
  await page.getByRole("slider", { name: "Playback volume", exact: true }).fill("0.37");
  await page.getByRole("button", { name: "Repeat track", exact: true }).click();
  await page.getByRole("button", { name: "B Original", exact: true }).click();
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect.poll(async () => (await outputLevel(page))?.rmsDbfs ?? -Infinity).toBeGreaterThan(-40);
  await page.getByRole("button", { name: "Next track: queue first", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/master/${first}$`));
  await expect(page.locator(".transport")).toHaveAttribute("data-playing", "true", { timeout: 15_000 });
  await expect(page.getByRole("slider", { name: "Playback volume", exact: true })).toHaveValue("0.37");
  await expect(page.getByRole("button", { name: "A Processed", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Repeat track", exact: true })).toHaveAttribute("aria-pressed", "false");
  await expect.poll(async () => (await outputLevel(page))?.rmsDbfs ?? -Infinity).toBeCloseTo(-33.66, 0);
  await page.evaluate((trackId) => {
    sessionStorage.setItem("aurialis-next-playback-v1", JSON.stringify({ fromTrackId: "outgoing-test-source", trackId, playing: true, volume: 0.37, issuedAt: Date.now() }));
  }, first);
  await page.reload();
  await expect(page.getByRole("button", { name: "A Processed", exact: true })).toBeEnabled();
  await expect(page.locator(".transport")).toHaveAttribute("data-playing", "false");
  expect(await page.evaluate(() => sessionStorage.getItem("aurialis-next-playback-v1"))).toBeNull();
});

test("keyboard holds retain focus and focused controls keep their own arrow behavior", async ({ page }) => {
  await uploadProject(page, "hold-controls.wav", 30);
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(page.locator(".transport")).toHaveAttribute("data-playing", "true");
  const forward = page.getByRole("button", { name: "Skip forward 10 seconds", exact: true });
  await forward.focus();
  await page.keyboard.down("Space");
  await expect(page.locator(".transport")).toHaveAttribute("data-playing", "false");
  await expect.poll(async () => Number(await page.locator(".transport").getAttribute("data-position"))).toBeGreaterThan(1);
  await page.keyboard.press("Escape");
  await page.keyboard.up("Space");
  await expect(page.locator(".transport")).toHaveAttribute("data-playing", "true");
  await expect(forward).toBeFocused();
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  const position = Number(await page.locator(".transport").getAttribute("data-position"));
  const input = page.getByRole("slider", { name: "Input gain", exact: true });
  await input.fill("3"); await input.press("ArrowRight");
  await expect(input).toHaveValue("3.5");
  expect(Number(await page.locator(".transport").getAttribute("data-position"))).toBe(position);
  await input.dblclick(); await expect(input).toHaveValue("0");
  await page.setViewportSize({ width: 320, height: 640 });
  const meters = page.getByRole("region", { name: "Measured audio levels", exact: true });
  await meters.focus(); await page.keyboard.press("ArrowRight");
  await expect.poll(() => meters.evaluate((element) => element.scrollLeft)).toBeGreaterThan(0);
  expect(Number(await page.locator(".transport").getAttribute("data-position"))).toBe(position);
});

test("wide transport centers Play and uses a legible ten-second icon", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  await uploadProject(page, "transport-layout.wav", 5);
  const transport = page.locator(".transport");
  const play = page.getByRole("button", { name: "Play", exact: true });
  const barBox = await transport.boundingBox();
  const playBox = await play.boundingBox();
  expect(barBox).not.toBeNull();
  expect(playBox).not.toBeNull();
  expect(Math.abs((playBox!.x + playBox!.width / 2) - (barBox!.x + barBox!.width / 2))).toBeLessThan(1);
  const forward = page.getByRole("button", { name: "Skip forward 10 seconds", exact: true });
  await expect(forward.locator("svg text")).toHaveText("10");
  const backBox = await page.getByRole("button", { name: "Restart track", exact: true }).boundingBox();
  const forwardBox = await forward.boundingBox();
  expect(backBox?.width).toBe(forwardBox?.width);
  expect(backBox?.y).toBe(forwardBox?.y);
});
