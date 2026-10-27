import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { playingAt, upload96, verifyAuditionMatchesExport } from "./audition-export-cases";

test("Audition export plays the exact Export WAV of a 96 kHz source from its Blob, decoding nothing", async ({ page }) => {
  test.setTimeout(120_000);
  await verifyAuditionMatchesExport(page);
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
