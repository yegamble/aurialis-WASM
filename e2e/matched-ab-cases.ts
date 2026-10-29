/* Test-owned Playwright download paths never come from audio filenames. */
/* eslint-disable security/detect-non-literal-fs-filename */
// cspell:words describedby
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { meanOutputLevel, observeOutput } from "./live-output";
import { uploadProject } from "./workflow-fixture";

async function exportHash(page: Page): Promise<string> {
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const dialog = page.getByRole("dialog");
  const pending = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Render & download WAV", exact: true }).click();
  const download = await pending;
  expect(await download.failure()).toBeNull();
  const path = await download.path();
  if (!path) throw new Error("Missing export download");
  await expect(dialog.getByRole("status")).toContainText("Exported");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

/** Listen to one side long enough for the 10 ms match and 8 ms A/B ramps to settle, then average 0.5 s. */
async function sideLevel(page: Page, side: "A Processed" | "B Original"): Promise<number> {
  await page.getByRole("button", { name: side, exact: true }).click();
  await expect(page.getByRole("button", { name: side, exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.waitForTimeout(150);
  return meanOutputLevel(page, 24_000);
}

/** One whole source loop of K-weighted speaker output for A or B (equal content, so only loudness differs). */
async function sideLoudness(page: Page, side: "A Processed" | "B Original", loopFrames: number): Promise<number> {
  await page.getByRole("button", { name: side, exact: true }).click();
  await expect(page.getByRole("button", { name: side, exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.waitForTimeout(150);
  return meanOutputLevel(page, loopFrames, "k");
}

type LimitedEvidence = { matchedDeltaLu: number; unmatchedDeltaLu: number; offsetDb: number };

/**
 * Round E REQUIRED-1: a heavily limited master (+14 dB into the −1 dBTP
 * limiter on the dense loop). The match is measured on what live playback
 * plays, so speaker-output K-weighted loudness of A and B agrees within 0.5 LU.
 */
export async function verifyLimitedMatchedAB(page: Page): Promise<LimitedEvidence> {
  await observeOutput(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await uploadProject(page, "matched-ab-limited.wav", 8, "dense");
  await page.getByRole("slider", { name: "Input gain", exact: true }).fill("14");
  const limiter = page.getByRole("checkbox", { name: "Enable limiter", exact: true });
  await limiter.check();
  await expect(limiter).toBeChecked();
  const toggle = page.getByRole("button", { name: "Equal-loudness A/B", exact: true });
  await page.getByRole("button", { name: "Repeat track", exact: true }).click();
  await page.getByRole("button", { name: "Play", exact: true }).click();
  const transport = page.locator(".transport");
  await expect(transport).toHaveAttribute("data-playing", "true");
  const loopFrames = await page.evaluate(() => 8 * ((window as Window & { qaOutput?: { sampleRate: number } }).qaOutput?.sampleRate ?? 48000));
  const unmatchedA = await sideLoudness(page, "A Processed", loopFrames);
  const unmatchedB = await sideLoudness(page, "B Original", loopFrames);
  await toggle.click();
  await expect(page.locator(".match-status")).toHaveText(/^A −\d+\.\d dB to match B$/, { timeout: 60_000 });
  const offsetDb = Number(await transport.getAttribute("data-match-processed-db"));
  const matchedA = await sideLoudness(page, "A Processed", loopFrames);
  const matchedB = await sideLoudness(page, "B Original", loopFrames);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await toggle.click();
  const evidence = { matchedDeltaLu: matchedA - matchedB, unmatchedDeltaLu: unmatchedA - unmatchedB, offsetDb };
  expect(Math.abs(evidence.matchedDeltaLu), JSON.stringify(evidence)).toBeLessThanOrEqual(0.5);
  expect(evidence.unmatchedDeltaLu, JSON.stringify(evidence)).toBeGreaterThan(3);
  return evidence;
}

/**
 * Round E REQUIRED-2: Export right after an edit, while Equal-loudness A/B is
 * re-measuring (or about to), must succeed: the measurement yields the native
 * server's single audio slot and resumes afterwards.
 */
export async function verifyExportDuringMeasurement(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await uploadProject(page, "matched-ab-export.wav", 30, "dense");
  const toggle = page.getByRole("button", { name: "Equal-loudness A/B", exact: true });
  await toggle.click();
  const status = page.locator(".match-status");
  await expect(status).toHaveText(/to match|already match/, { timeout: 60_000 });
  const gain = page.getByRole("slider", { name: "Input gain", exact: true });
  for (const [value, waitMs] of [["-3", 0], ["-5", 600]] as const) {
    await gain.fill(value);
    // 0 ms: before the 400 ms debounce; 600 ms: while the measurement renders.
    if (waitMs) await page.waitForTimeout(waitMs);
    await exportHash(page);
  }
  // The measurement resumes after Export and reports the new offset.
  await expect(status).toHaveText("B −5.0 dB to match A", { timeout: 60_000 });
}

type MatchedABEvidence = { matchedDeltaDb: number; unmatchedDeltaDb: number; offsetDb: number; exportHash: string };

/**
 * V1-11 acceptance through the real live path. A −6 dB input gain on a 1 kHz
 * tone makes A a pure, spectrally identical gain change of B, so the measured
 * RMS difference at the speakers equals the BS.1770 loudness difference.
 */
export async function verifyMatchedAB(page: Page): Promise<MatchedABEvidence> {
  await observeOutput(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await uploadProject(page, "matched-ab.wav", 4);
  const toggle = page.getByRole("button", { name: "Equal-loudness A/B", exact: true });
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(page.getByText("Listening only — export unchanged", { exact: true })).toBeVisible();
  await page.getByRole("slider", { name: "Input gain", exact: true }).fill("-6");
  const off = await exportHash(page);

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  const status = page.locator(".match-status");
  await expect(status).toHaveAttribute("aria-live", "polite");
  await expect(status).toHaveText("B −6.0 dB to match A", { timeout: 30_000 });
  await expect(toggle).toHaveAttribute("aria-describedby", new RegExp(`^${(await status.getAttribute("id")) ?? "missing"} `));
  const transport = page.locator(".transport");
  const offsetDb = Number(await transport.getAttribute("data-match-original-db"));
  expect(Number(await transport.getAttribute("data-match-processed-db"))).toBe(0);
  expect(offsetDb).toBeCloseTo(-6, 1);

  // Export bytes are identical with the match on.
  const on = await exportHash(page);
  expect(on).toBe(off);

  await page.getByRole("button", { name: "Repeat track", exact: true }).click();
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(transport).toHaveAttribute("data-playing", "true");
  const matchedA = await sideLevel(page, "A Processed");
  const matchedB = await sideLevel(page, "B Original");
  await toggle.click();
  await expect(status).toHaveText("");
  await expect(transport).toHaveAttribute("data-match-original-db", "0");
  const unmatchedB = await sideLevel(page, "B Original");
  const unmatchedA = await sideLevel(page, "A Processed");
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  const evidence = { matchedDeltaDb: matchedA - matchedB, unmatchedDeltaDb: unmatchedA - unmatchedB, offsetDb, exportHash: off };
  expect(Math.abs(evidence.matchedDeltaDb), JSON.stringify(evidence)).toBeLessThanOrEqual(0.5);
  // Control: without the match the same path differs by the measured offset.
  expect(evidence.unmatchedDeltaDb, JSON.stringify(evidence)).toBeCloseTo(offsetDb, 0);

  // The opt-in is a per-browser preference and survives a reload.
  await toggle.click();
  await page.reload();
  await expect(page.getByRole("button", { name: "Equal-loudness A/B", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".match-status")).toHaveText("B −6.0 dB to match A", { timeout: 30_000 });
  for (const width of [320, 1440]) {
    await page.setViewportSize({ width, height: width === 320 ? 640 : 900 });
    const box = await page.getByRole("button", { name: "Equal-loudness A/B", exact: true }).boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(44);
    expect(box?.height).toBeGreaterThanOrEqual(44);
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    const results = await new AxeBuilder({ page }).include(".transport").withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
    expect(results.violations, `WCAG 2.2 AA in the transport at ${String(width)}px: ${JSON.stringify(results.violations)}`).toEqual([]);
    if (width === 320) {
      // The taller fixed transport must not cover the last page control.
      await page.evaluate(() => { window.scrollTo(0, document.documentElement.scrollHeight); });
      const last = await page.getByRole("button", { name: "Reset modules", exact: true }).boundingBox();
      const bar = await page.locator(".transport").boundingBox();
      if (!last || !bar) throw new Error("Missing layout boxes");
      expect(last.y + last.height).toBeLessThanOrEqual(bar.y);
    }
  }
  // Keyboard: the toggle is reachable and operable without a pointer.
  await page.getByRole("button", { name: "Equal-loudness A/B", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Equal-loudness A/B", exact: true })).toHaveAttribute("aria-pressed", "false");
  return evidence;
}

/** Applied automation uses the same monitor match and leaves its export unchanged. */
export async function verifyDeepMatchedAB(page: Page): Promise<{ deltaLu: number; exportHash: string }> {
  await observeOutput(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await uploadProject(page, "matched-ab-deep.wav", 8, "dense");
  await page.getByRole("tab", { name: "deep", exact: true }).click();
  await page.getByRole("button", { name: "Analyze Deep proposal", exact: true }).click();
  await expect(page.getByText("Measured proposal ready. Your applied processing has not changed.", { exact: true })).toBeVisible({ timeout: 60000 });
  await page.getByRole("combobox", { name: "New move target", exact: true }).selectOption("inputGainDb");
  await page.getByRole("button", { name: "Add baseline move", exact: true }).click();
  for (const point of [1, 2]) {
    const value = page.getByRole("spinbutton", { name: `Point ${String(point)} value`, exact: true });
    await value.fill("3"); await value.blur();
  }
  await page.getByRole("button", { name: "Apply Deep proposal", exact: true }).click();
  await expect.poll(() => page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem("aurialis-state-v1") ?? "{}") as { tracks: { deepMastering?: { applied?: { revision: number } } }[] };
    return saved.tracks[0]?.deepMastering?.applied?.revision ?? 0;
  })).toBeGreaterThan(0);
  const off = await exportHash(page);
  await page.getByRole("button", { name: "Repeat track", exact: true }).click();
  await page.getByRole("button", { name: "Play", exact: true }).click();
  const toggle = page.getByRole("button", { name: "Equal-loudness A/B", exact: true });
  await toggle.click();
  await expect(page.locator(".match-status")).toHaveText(/^(?:[AB] −[\d.]+ dB to match [AB]|A and B already match)$/, { timeout: 60000 });
  const frames = await page.evaluate(() => 8 * ((window as Window & { qaOutput?: { sampleRate: number } }).qaOutput?.sampleRate ?? 48000));
  const a = await sideLoudness(page, "A Processed", frames), b = await sideLoudness(page, "B Original", frames);
  expect(Math.abs(a - b), "applied Deep speaker loudness").toBeLessThanOrEqual(0.5);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  expect(await exportHash(page), "monitor matching cannot alter a Deep export").toBe(off);
  return { deltaLu: a - b, exportHash: off };
}
