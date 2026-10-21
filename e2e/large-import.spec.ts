import { expect, test } from "@playwright/test";
import { fixture } from "./audio-fixture";
import { observeOutput, outputLevel } from "./live-output";

test("a full song over 35 MB imports in one bounded request and survives reopening", async ({ page }) => {
  test.setTimeout(90_000);
  await observeOutput(page);
  await page.goto("/");
  let requests = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/api/master/render") requests++;
  });
  const buffer = fixture(997, 200);
  expect(buffer.length).toBeGreaterThan(35 * 1024 * 1024);
  await page.getByLabel("Upload audio file").setInputFiles({ name: "full-song.wav", mimeType: "audio/wav", buffer });
  await expect(page).toHaveURL(/\/master\/track-/, { timeout: 60_000 });
  await expect(page.getByRole("button", { name: "A Processed", exact: true })).toBeEnabled({ timeout: 30_000 });
  await expect(page.getByRole("slider", { name: "Track playback position", exact: true })).toHaveAttribute("aria-valuemax", "200");
  const url = page.url();
  await page.reload();
  await expect(page).toHaveURL(url);
  await expect(page.getByRole("button", { name: "A Processed", exact: true })).toBeEnabled({ timeout: 30_000 });
  expect(requests).toBe(1);
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(page.locator(".transport")).toHaveAttribute("data-playing", "true");
  await expect.poll(async () => (await outputLevel(page))?.rmsDbfs ?? -Infinity).toBeGreaterThan(-40);
});
