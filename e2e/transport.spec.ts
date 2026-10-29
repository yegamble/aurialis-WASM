import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
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


test("mobile meter regions remain above the fixed transport when focused", async ({ page }, info) => {
  await uploadProject(page, "mobile-meter-clearance.wav", 8);
  for (const playing of [false, true]) {
    if (playing) {
      await page.getByRole("button", { name: "Repeat track", exact: true }).click();
      await page.getByRole("button", { name: "Play", exact: true }).click();
      await expect(page.getByRole("region", { name: "Live loudness of the processed output", exact: true }).locator("strong").nth(3)).not.toHaveText("—");
    }
    for (const width of [320, 375, 390]) {
      await page.setViewportSize({ width, height: 640 });
      for (const name of ["Live loudness of the processed output", "Measured audio levels"]) {
        const meters = page.getByRole("region", { name, exact: true });
        await meters.focus(); await meters.scrollIntoViewIfNeeded();
        const meterBox = await meters.boundingBox(), transport = await page.locator(".transport").boundingBox(), header = await page.locator(".mobile-header").boundingBox();
        if (!meterBox || !transport || !header) throw new Error("Missing meter, header or transport geometry");
        expect(meterBox.height).toBeGreaterThanOrEqual(44);
        expect(meterBox.y, `${String(width)}px ${name} header clearance`).toBeGreaterThanOrEqual(header.y + header.height);
        expect(meterBox.y + meterBox.height, `${String(width)}px ${name} clearance`).toBeLessThanOrEqual(transport.y);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
      const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
      expect(axe.violations, `${String(width)}px mobile meter accessibility`).toEqual([]);
      await page.screenshot({ path: info.outputPath(`meters-${String(width)}-${playing ? "playing" : "stopped"}.png`) });
    }
  }
});


test("Repeat wraps Forward 10 and Shift+Right while an absolute End seek stops", async ({ page }) => {
  await uploadProject(page, "repeat-relative.wav", 12);
  const position = page.getByRole("slider", { name: "Track playback position", exact: true });
  const transport = page.locator(".transport");
  await page.getByRole("button", { name: "Repeat track", exact: true }).click();
  for (const action of ["forward", "key"]) {
    await position.focus(); await position.press("End");
    await expect(transport).toHaveAttribute("data-playing", "false");
    await position.press("ArrowLeft");
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await expect(transport).toHaveAttribute("data-playing", "true");
    if (action === "forward") await page.getByRole("button", { name: "Skip forward 10 seconds", exact: true }).click();
    else { await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); }); await page.keyboard.press("Shift+ArrowRight"); }
    await expect(transport).toHaveAttribute("data-playing", "true");
    const seconds = Number(await transport.getAttribute("data-position"));
    expect(seconds).toBeGreaterThanOrEqual(9); expect(seconds).toBeLessThan(10.5);
  }
  await position.focus(); await position.press("End");
  await expect(transport).toHaveAttribute("data-playing", "false");
});
