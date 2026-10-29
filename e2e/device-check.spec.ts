/* Test-owned Playwright downloads never come from audio filenames. */
/* eslint-disable security/detect-non-literal-fs-filename */
import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
type DeviceRecord = { classification: string; recordedAudioSeconds: number; operator: { physicalRouteConfirmedByOwner: boolean }; samples: { diagnostics: { deviceStats: unknown; kernel: { frames: number } | null; acceptedControls: { values: number[] } | null } }[] };
async function downloadRecord(page: Page): Promise<DeviceRecord> {
  const pending = page.waitForEvent("download"); await page.getByRole("button", { name: "Download diagnostic JSON", exact: true }).click();
  const path = await (await pending).path(); if (!path) throw new Error("Missing diagnostics record");
  return JSON.parse(await readFile(path, "utf8")) as DeviceRecord;
}
test("device bundle prepares real CDR audio without starting playback or declaring physical qualification", async ({ page }, info) => {
  await page.goto("/device-check/");
  await page.getByRole("button", { name: "Prepare 20-second source", exact: true }).click();
  await expect(page.getByText("Source ready. Start is a separate user gesture, as Safari requires.", { exact: true })).toBeVisible({ timeout: 30_000 });
  const record = await downloadRecord(page); expect(record.classification).toBe("pending_owner_and_peer_review");
  expect(record.samples).toEqual([]); expect(record.operator.physicalRouteConfirmedByOwner).toBe(false);
  for (const width of [320, 375, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
    if (width === 320 || width === 1440) await page.screenshot({ path: info.outputPath(`device-check-${String(width)}.png`), fullPage: true });
  }
});
test("device bundle records the production kernel and accepted packet while remaining unqualified", async ({ page }) => {
  await page.goto("/device-check/"); await page.getByRole("button", { name: "Prepare 20-second source", exact: true }).click();
  await expect(page.getByRole("button", { name: "Start ten-minute run", exact: true })).toBeEnabled({ timeout: 30_000 });
  await page.getByRole("button", { name: "Start ten-minute run", exact: true }).click();
  await expect.poll(async () => Number(await page.getByRole("progressbar", { name: "Rendered audio seconds in ten-minute run", exact: true }).getAttribute("value")), { timeout: 20_000 }).toBeGreaterThan(2);
  await page.getByRole("button", { name: "Stop run", exact: true }).click();
  const record = await downloadRecord(page); expect(record.classification).toBe("pending_owner_and_peer_review");
  expect(record.recordedAudioSeconds).toBeGreaterThan(2); expect(record.recordedAudioSeconds).toBeLessThan(600);
  expect(record.samples.some((sample) => (sample.diagnostics.kernel?.frames ?? 0) > 0)).toBe(true);
  expect(record.samples.some((sample) => sample.diagnostics.acceptedControls?.values.length === 82)).toBe(true);
});
