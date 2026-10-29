import { expect, type Page } from "@playwright/test";

/** A saved receipt describes one actual renderer even when source and knobs are unchanged. */
export async function verifyReleaseQualityStaleness(page: Page, id: string) {
  const binding = () => page.evaluate((trackId) => {
    const state = JSON.parse(localStorage.getItem("aurialis-state-v1") ?? "{}") as { tracks: { id: string; releaseReview?: { bindingHash: string } }[] };
    return state.tracks.find((track) => track.id === trackId)?.releaseReview?.bindingHash ?? null;
  }, id);
  const save = page.getByRole("button", { name: "Save report to project", exact: true });
  await save.click(); await expect.poll(binding).not.toBeNull(); const classic = await binding();
  const change = async (quality: "Classic" | "Oversampled") => {
    await page.goto(`/master/${id}`); await page.getByRole("button", { name: quality, exact: true }).click();
    await expect(page.getByRole("button", { name: quality, exact: true })).toHaveAttribute("aria-pressed", "true");
    await page.goto(`/release-check/${id}`);
  };
  await change("Oversampled");
  await expect(page.getByRole("region", { name: "Encoded audio review", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Download JSON report", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Run release check", exact: true }).click();
  await expect(page.getByRole("region", { name: "Encoded audio review", exact: true })).toBeVisible({ timeout: 30_000 });
  await save.click(); await expect.poll(binding).not.toBe(classic); const oversampled = await binding();
  await change("Classic");
  await expect(page.getByRole("region", { name: "Encoded audio review", exact: true })).toHaveCount(0);
  await change("Oversampled");
  await expect(page.getByRole("region", { name: "Encoded audio review", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Download measured WAV", exact: true })).toBeDisabled();
  expect(await binding()).toBe(oversampled);
}
