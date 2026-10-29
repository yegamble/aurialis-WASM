/* Test-owned download paths never originate in audio filenames. */
/* eslint-disable security/detect-non-literal-fs-filename */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, type Page } from "@playwright/test";
import { meanOutputLevel, observeOutput, outputLevel } from "./live-output";
import { uploadProject } from "./workflow-fixture";
async function exportHash(page: Page) {
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const dialog = page.getByRole("dialog"); await dialog.getByRole("button", { name: "32-bit Float", exact: true }).click();
  const pending = page.waitForEvent("download"); await dialog.getByRole("button", { name: "Render & download WAV", exact: true }).click();
  const path = await (await pending).path(); if (!path) throw new Error("No export download");
  const hash = createHash("sha256").update(await readFile(path)).digest("hex");
  await page.keyboard.press("Escape"); return hash;
}
async function channelRelation(page: Page) {
  return page.evaluate(() => {
    const probe = (window as Window & { qaOutput?: { left: number[]; right: number[] } }).qaOutput;
    if (!probe?.left.length) return null;
    let difference = 0, sum = 0, energy = 0;
    for (let i = 0; i < probe.left.length; i++) {
      const l = probe.left[i] ?? 0, r = probe.right[i] ?? 0;
      difference += (l - r) ** 2; sum += (l + r) ** 2; energy += l * l + r * r;
    }
    return { difference: difference / Math.max(energy, 1e-30), sum: sum / Math.max(energy, 1e-30), energy };
  });
}
/** Actual Go speaker output, selected-mode matching, and unchanged exported PCM. */
export async function verifyMonitorModes(page: Page) {
  const measurements: { mode: string; measure: string | null; format: string | null }[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname !== "/api/master/render" || request.method() !== "POST") return;
    const body = request.postData() ?? "";
    const field = (name: string) => body.match(new RegExp('name="' + name + '"\\r?\\n\\r?\\n([^\\r\\n]*)', "u"))?.[1] ?? null;
    const mode = field("monitorMode"); if (mode) measurements.push({ mode, measure: field("measure"), format: field("format") });
  });
  await observeOutput(page); await uploadProject(page, "monitor-check.wav", 4);
  await page.getByRole("slider", { name: "Input gain", exact: true }).fill("6");
  const before = await exportHash(page);
  await page.getByRole("button", { name: "Repeat track", exact: true }).click();
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(page.locator(".transport")).toHaveAttribute("data-playing", "true");
  const evidence = [];
  const originalLevels = [];
  for (const mode of ["Mono", "Side"] as const) {
    const match = page.getByRole("button", { name: "Equal-loudness A/B", exact: true });
    if (await match.getAttribute("aria-pressed") === "true") await match.click();
    const beforeFrames = (await outputLevel(page))?.frames ?? 0;
    await page.getByRole("button", { name: mode, exact: true }).click();
    await expect.poll(async () => (await outputLevel(page))?.frames ?? 0).toBeGreaterThan(beforeFrames + 48000);
    for (const side of ["A Processed", "B Original"] as const) {
      await page.getByRole("button", { name: side, exact: true }).click();
      await expect.poll(async () => {
        const relation = await channelRelation(page);
        return relation && relation.energy > 1e-6 ? relation.difference : 1;
      }).toBeLessThan(1e-8);
    }
    await page.waitForTimeout(150);
    originalLevels.push(await meanOutputLevel(page, 48000));
    if (await match.getAttribute("aria-pressed") !== "true") await match.click();
    await expect(page.locator(".match-status")).not.toHaveText(/Measuring|Re-measuring|unavailable|^$/iu, { timeout: 30_000 });
    const levels = [];
    for (const side of ["A Processed", "B Original"] as const) {
      await page.getByRole("button", { name: side, exact: true }).click(); await page.waitForTimeout(150);
      levels.push(await meanOutputLevel(page, 48000, "k"));
    }
    expect(Math.abs((levels[0] ?? 0) - (levels[1] ?? 0))).toBeLessThanOrEqual(.5);
    evidence.push({ mode, levels, relation: await channelRelation(page) });
  }
  // Independent fixture: L=.2sin, R=.1sin; Mono=.15sin, Side=.05sin.
  expect((originalLevels[1] ?? 0) - (originalLevels[0] ?? 0)).toBeCloseTo(20 * Math.log10(1 / 3), 1);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  expect(await exportHash(page)).toBe(before);
  await page.reload(); await expect(page.getByRole("button", { name: "Side", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.goto("/library"); await page.getByRole("button", { name: /^Actions for /u }).click();
  await page.getByRole("button", { name: /^Preview /u }).click();
  const preview = page.getByRole("dialog", { name: /^Preview /u });
  await expect(preview.getByRole("button", { name: "Side", exact: true })).toHaveAttribute("aria-pressed", "true");
  const libraryMatch = preview.getByRole("button", { name: "Equal-loudness A/B", exact: true });
  if (await libraryMatch.getAttribute("aria-pressed") === "true") await libraryMatch.click();
  await preview.getByRole("button", { name: "B Original", exact: true }).click();
  await preview.getByRole("button", { name: "Play", exact: true }).click();
  await expect.poll(async () => (await outputLevel(page))?.frames ?? 0).toBeGreaterThan(48000);
  await expect.poll(async () => { const relation = await channelRelation(page); return relation && relation.energy > 1e-6 ? relation.difference : 1; }).toBeLessThan(1e-8);
  const libraryOriginalDb = await meanOutputLevel(page, 48000);
  expect(libraryOriginalDb).toBeCloseTo(originalLevels[1] ?? 0, 1);
  await page.keyboard.press("Escape");
  return { evidence, measurements, originalLevels, libraryOriginalDb, expectedSideMinusMonoDb: 20 * Math.log10(1 / 3), exportHash: before, librarySidePlayback: true };
}
