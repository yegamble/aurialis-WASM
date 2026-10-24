import { expect, test } from "@playwright/test";
import { resolve } from "node:path";
import { observeAlbum, workspace, openAlbum } from "./album-cases";
import { beforeOwnedWork, scaleSource, memoryProfile } from "./album-scale-tools";

test("the real 180-second source is refused by the 512 MiB Album policy before a worker starts", async ({ page }) => {
  test.setTimeout(240_000); await observeAlbum(page); await memoryProfile(page, 8);
  const source = await scaleSource(resolve(process.env.AURIALIS_ALBUM_SCALE_SOURCES ?? "artifacts/album-scale-shared-sources"), 0);
  await page.goto("/"); await beforeOwnedWork(); await page.getByLabel("Upload audio file").setInputFiles(source.path); await expect(page).toHaveURL(/\/master\/track-/u, { timeout: 130_000 }); await expect(page.getByRole("button", { name: "A Processed", exact: true })).toBeEnabled({ timeout: 130_000 });
  await openAlbum(page, ["source 0"]); await page.evaluate(() => { (window as Window & { albumDeviceProfile?: number }).albumDeviceProfile = 4; });
  await beforeOwnedWork(); const before = await page.evaluate(() => window.albumQA.jobs.length); await page.getByRole("button", { name: "Render album masters", exact: true }).click(); await expect(page.locator("main").getByRole("alert")).toContainText("conservative audio memory budget", { timeout: 30_000 });
  expect(await page.evaluate(() => window.albumQA.jobs.length)).toBe(before); await expect(page.getByRole("button", { name: "Download source 0", exact: true })).toHaveCount(0); expect((await workspace(page)).tracks[0]?.sourceIdentity?.pcmHash).toBe(source.pcmHash);
});
