import { expect, test } from "@playwright/test";
import type { AdvancedParams } from "../src/lib/types";
import { uploadProject } from "./workflow-fixture";

test("selected overlapping EQ handles receive pointer resets and preserve other settings", async ({ page }, info) => {
  const id = await uploadProject(page, "qa-overlapping-eq.wav", 2);
  const settings = () => page.evaluate((trackId) => {
    const raw = localStorage.getItem("aurialis-state-v1");
    if (!raw) throw new Error("Missing saved project");
    const tracks = (JSON.parse(raw) as { tracks: { id: string; advanced: AdvancedParams }[] }).tracks;
    const track = tracks.find((item) => item.id === trackId);
    if (!track) throw new Error("Missing source project");
    return track.advanced;
  }, id);
  const evidence = [];
  for (const width of [320, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.getByRole("tab", { name: "Low", exact: true }).click();
    await page.getByRole("slider", { name: "Low Q", exact: true }).fill("1.234");
    await page.getByRole("slider", { name: "Low frequency", exact: true }).fill("1200");
    await page.getByRole("slider", { name: "Low gain", exact: true }).fill("4");
    const selected = page.locator(".eq-handle").nth(1);
    await expect(selected).toHaveAttribute("aria-pressed", "true");
    await selected.scrollIntoViewIfNeeded();
    const before = await settings();
    const hit = await selected.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const target = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)?.closest(".eq-handle");
      return { owner: target?.getAttribute("aria-label"), width: bounds.width, height: bounds.height };
    });
    expect(hit.owner).toMatch(/^Low EQ:/);
    expect(hit.width).toBeGreaterThanOrEqual(44);
    expect(hit.height).toBeGreaterThanOrEqual(44);
    await selected.dblclick();
    await expect(page.getByRole("slider", { name: "Low frequency", exact: true })).toHaveValue("250");
    await expect(page.getByRole("slider", { name: "Low gain", exact: true })).toHaveValue("0");
    await expect(page.getByRole("slider", { name: "Low Q", exact: true })).toHaveValue("1.234");
    const after = await settings();
    expect(after.eqBands[1]).toEqual({ ...before.eqBands[1], freqHz: 250, gainDb: 0 });
    for (const index of [0, 2, 3, 4]) expect(after.eqBands[index]).toEqual(before.eqBands[index]);
    expect({ ...after, eqBands: before.eqBands }).toEqual(before);
    evidence.push({ width, hit, before: before.eqBands[1], after: after.eqBands[1] });
  }
  await info.attach("overlapping EQ pointer reset", { body: JSON.stringify(evidence, null, 2), contentType: "application/json" });
});
