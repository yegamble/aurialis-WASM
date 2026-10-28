import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { playingAt, upload96, verifyAuditionMatchesExport } from "./audition-export-cases";

test("Audition export plays the exact Export WAV of a 96 kHz source from its Blob, decoding nothing", async ({ page }) => {
  test.setTimeout(120_000);
  await verifyAuditionMatchesExport(page, true);
});

test("an edit marks the audition stale and stops it; a re-render can be canceled", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await upload96(page);
  await page.getByRole("button", { name: "Audition export", exact: true }).click();
  await expect.poll(() => playingAt(page), { timeout: 30_000 }).toBeGreaterThan(0.2);
  await page.getByRole("slider", { name: "Input gain", exact: true }).fill("3");
  await expect(page.getByText("Settings changed after this audition was rendered, so it no longer matches the export. Re-render to hear the current export.", { exact: true })).toBeVisible();
  await expect.poll(() => playingAt(page)).toBe(0);
  await expect(page.getByRole("button", { name: /^(Play|Pause) audition$/u })).toHaveCount(0);

  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  const seen = new Promise<void>((resolve) => {
    void page.route("**/api/master/render", async (route) => { resolve(); await held; await route.abort("failed").catch(() => undefined); });
  });
  try {
    await page.getByRole("button", { name: "Re-render audition", exact: true }).click();
    await seen;
    await expect(page.getByRole("progressbar", { name: "Audition export render progress" })).toBeVisible();
    await page.getByRole("button", { name: "Cancel audition render", exact: true }).click();
    await expect(page.getByText("Audition render canceled.", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Audition export", exact: true })).toBeEnabled();
    expect(await playingAt(page)).toBe(0);
  } finally {
    release();
  }
});

/** Hold the next render request until `release()`, then let it through. */
async function holdNextRender(page: Page) {
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  const seen = new Promise<void>((resolve) => {
    void page.route("**/api/master/render", async (route) => { resolve(); await held; await route.continue(); }, { times: 1 });
  });
  return { seen, release };
}

// R-1 (Round 5): a render that completes after an edit, or after live Play,
// must not play or take over the transport.
test("an edit during the audition render leaves it stale; it never plays", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await upload96(page);
  const render = await holdNextRender(page);
  await page.getByRole("button", { name: "Audition export", exact: true }).click();
  await render.seen;
  await page.getByRole("slider", { name: "Input gain", exact: true }).fill("3");
  render.release();
  await expect(page.getByText("Settings changed after this audition was rendered, so it no longer matches the export. Re-render to hear the current export.", { exact: true })).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1000);
  expect(await playingAt(page)).toBe(0);
  await expect(page.getByRole("button", { name: "Re-render audition", exact: true })).toBeVisible();
});

test("live Play during the audition render keeps playing live; the audition waits, ready", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await upload96(page);
  const render = await holdNextRender(page);
  await page.getByRole("button", { name: "Repeat track", exact: true }).click();
  await page.getByRole("button", { name: "Audition export", exact: true }).click();
  await render.seen;
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(page.locator(".transport")).toHaveAttribute("data-playing", "true");
  render.release();
  await expect(page.getByText("Ready: the exact export file (96 kHz (source) · 24-bit PCM · TPDF dither).", { exact: true })).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(1000);
  expect(await playingAt(page)).toBe(0);
  await expect(page.locator(".transport")).toHaveAttribute("data-playing", "true");
  await page.getByRole("button", { name: "Pause", exact: true }).click();
});

// Q-S1 (QA audition-probe P3): live Play, then Pause, during the held render.
// The finished audition must not auto-play after the listener paused.
test("live Play then Pause during the audition render: the audition waits, ready", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await upload96(page);
  const render = await holdNextRender(page);
  await page.getByRole("button", { name: "Audition export", exact: true }).click();
  await render.seen;
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(page.locator(".transport")).toHaveAttribute("data-playing", "true");
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await expect(page.locator(".transport")).toHaveAttribute("data-playing", "false");
  render.release();
  await expect(page.getByText("Ready: the exact export file (96 kHz (source) · 24-bit PCM · TPDF dither).", { exact: true })).toBeVisible({ timeout: 30_000 });
  await page.waitForTimeout(2000);
  expect(await playingAt(page)).toBe(0);
});

// Q-S2: keyboard focus follows the one audition button through every state.
test("keyboard focus stays on the audition button through render, cancel, play and re-render", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 375, height: 800 });
  await upload96(page);
  const focused = () => page.evaluate(() => (document.activeElement instanceof HTMLButtonElement ? document.activeElement.textContent?.trim() : document.activeElement?.tagName) ?? "");
  const render = await holdNextRender(page);
  await page.getByRole("button", { name: "Audition export", exact: true }).focus();
  await page.keyboard.press("Enter");
  await render.seen;
  expect(await focused()).toBe("Cancel audition render");
  await page.keyboard.press("Enter");
  await expect(page.getByText("Audition render canceled.", { exact: true })).toBeVisible();
  expect(await focused()).toBe("Audition export");
  render.release();
  await page.keyboard.press("Enter");
  await expect.poll(() => playingAt(page), { timeout: 30_000 }).toBeGreaterThan(0.1);
  expect(await focused()).toBe("Pause audition");
  await page.keyboard.press("Enter");
  await expect.poll(focused).toBe("Play audition");
  await page.getByRole("slider", { name: "Input gain", exact: true }).fill("3");
  await page.getByRole("button", { name: "Re-render audition", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => playingAt(page), { timeout: 30_000 }).toBeGreaterThan(0.1);
  expect(await focused()).toBe("Pause audition");
});

// Round 8b Q-S2 (QA E7 e7-ab-space): A/B during the audition hands the
// play/pause keys back to live; Space then starts live with B applied. B and
// Space go in one task, before the media "pause" event fires, so the case
// fails if A/B leaves the audition marked as playing until that event (92322ab).
test("after A/B during the audition, Space starts live with B applied, not the audition", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await upload96(page);
  // The 4 s source would end before a loaded host checks it; loop it.
  await page.getByRole("button", { name: "Repeat track", exact: true }).click();
  await page.getByRole("button", { name: "Audition export", exact: true }).click();
  await expect.poll(() => playingAt(page), { timeout: 30_000 }).toBeGreaterThan(0.2);
  await page.evaluate(() => {
    (document.activeElement as HTMLElement | null)?.blur();
    const original = document.querySelector<HTMLButtonElement>('button[aria-label="B Original"]');
    if (!original) throw new Error("Missing B Original");
    original.click();
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: " ", code: "Space", bubbles: true, cancelable: true }));
  });
  await expect(page.locator(".transport")).toHaveAttribute("data-playing", "true", { timeout: 30_000 });
  await expect.poll(() => playingAt(page)).toBe(0);
  await page.waitForTimeout(1000);
  expect(await playingAt(page)).toBe(0);
  await expect(page.getByRole("button", { name: "B Original", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Play audition", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Pause", exact: true }).click();
});

// QA E9 P2-1 (probe V5): Play audition and B in one task, before the media
// "play" event. A/B must still pause the starting audition, so B is not shown
// pressed while the processed audition plays.
test("Play audition and B in the same task leave the audition paused with B applied", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await upload96(page);
  await page.getByRole("button", { name: "Audition export", exact: true }).click();
  await expect.poll(() => playingAt(page), { timeout: 30_000 }).toBeGreaterThan(0.2);
  await page.getByRole("button", { name: "Pause audition", exact: true }).click();
  await expect.poll(() => playingAt(page)).toBe(0);
  const play = await page.getByRole("button", { name: "Play audition", exact: true }).elementHandle();
  const original = await page.getByRole("button", { name: "B Original", exact: true }).elementHandle();
  await page.evaluate(([first, second]) => { (first as HTMLButtonElement).click(); (second as HTMLButtonElement).click(); }, [play, original]);
  await page.waitForTimeout(1000);
  expect(await playingAt(page), "audition position while playing (0 = paused)").toBe(0);
  await expect(page.getByRole("button", { name: "B Original", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Play audition", exact: true })).toBeVisible();
});

// Round 6 REQUIRED-1: the audition follows the Playback volume, like live.
test("Audition export follows the Playback volume on start and on every move", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await upload96(page);
  const volume = page.getByRole("slider", { name: "Playback volume", exact: true });
  await volume.fill("0.1");
  await page.getByRole("button", { name: "Audition export", exact: true }).click();
  await expect.poll(() => playingAt(page), { timeout: 30_000 }).toBeGreaterThan(0.1);
  const level = () => page.evaluate(() => document.querySelector<HTMLAudioElement>("audio.audition-export")?.volume ?? -1);
  expect(await level()).toBeCloseTo(0.1, 3);
  await volume.fill("0.6");
  await expect.poll(level).toBeCloseTo(0.6, 3);
  await page.getByRole("button", { name: "Pause audition", exact: true }).click();
});

for (const width of [320, 1440]) {
  test(`Audition export is a 44 px, keyboard-operable control without overflow or axe violations at ${String(width)} px`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.setViewportSize({ width, height: 900 });
    await upload96(page);
    const button = page.getByRole("button", { name: "Audition export", exact: true });
    const box = await button.boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(44);
    expect(box?.width).toBeGreaterThanOrEqual(44);
    expect((box?.x ?? Infinity) + (box?.width ?? 0)).toBeLessThanOrEqual(width);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await button.focus();
    await page.keyboard.press("Enter");
    await expect.poll(() => playingAt(page), { timeout: 30_000 }).toBeGreaterThan(0.1);
    const results = await new AxeBuilder({ page }).include('[aria-label="Audition export"]')
      .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    expect(results.violations, JSON.stringify(results.violations)).toEqual([]);
  });
}
