// cspell:words spinbutton
import { readFile } from "node:fs/promises";
import { decode } from "./audio-fixture";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import type { Track } from "../src/lib/types";
import { uploadProject } from "./workflow-fixture";
import { captureDeepDevice, capturedDevice, capturedProgress } from "./deep-capture";
async function project(page: Page): Promise<Track> { const track = await page.evaluate(() => (JSON.parse(localStorage.getItem("aurialis-state-v1") ?? "{}") as { tracks: Track[] }).tracks[0]); if (!track) throw new Error("Missing project"); return track; }

test("actual measured Deep proposal preserves audio settings and its populated editor passes six widths", async ({ page }, info) => {
  await uploadProject(page, "deep-source.wav", 2);
  await page.getByRole("slider", { name: "Input gain", exact: true }).fill("6");
  await page.getByRole("tab", { name: "deep", exact: true }).click();
  const before = (await project(page)).advanced;
  await page.getByRole("button", { name: "Analyze Deep proposal", exact: true }).click();
  await expect(page.getByText("Measured proposal ready. Your applied processing has not changed.", { exact: true })).toBeVisible({ timeout: 30000 });
  const proposed = await project(page);
  expect(proposed.advanced).toEqual(before); expect(proposed.deepMastering?.applied).toBeUndefined();
  expect(proposed.deepMastering?.proposal.source).toEqual(proposed.sourceIdentity);
  expect(proposed.deepMastering?.proposal.chainParams).toMatchObject({ algorithmVersion: 1, limiter: { truePeak: false }, repair: { enabled: false } });
  await expect(page.getByRole("list", { name: "Measured proposal sections" })).toContainText("musical role unknown");
  await page.getByRole("combobox", { name: "New move target", exact: true }).selectOption("stereo.widthPct");
  await page.getByRole("button", { name: "Add baseline move", exact: true }).click();
  const selected = (await project(page)).deepMastering?.proposal.moves.at(-1); if (!selected) throw new Error("Missing authored move");
  for (const width of [320, 375, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    if (width < 1024) await expect(page.getByRole("dialog")).toBeVisible();
    else await expect(page.getByRole("region", { name: "Edit selected draft move" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    const targets = await page.locator('button:visible, input:visible, select:visible').evaluateAll((elements) => elements.filter((element) => !element.closest('[aria-hidden="true"]')).map((element) => ({ name: element.getAttribute("aria-label") ?? element.textContent ?? "", rect: element.getBoundingClientRect() })).filter((item) => item.rect.width > 0 && item.rect.height > 0).map((item) => ({ name: item.name, width: item.rect.width, height: item.rect.height })));
    expect(targets.filter((item) => item.width < 43.5 || item.height < 43.5), String(width) + "px touch targets").toEqual([]);
    const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze(); expect(axe.violations, String(width) + "px populated Deep editor").toEqual([]);
    if (width === 320 || width === 1440) await page.screenshot({ path: info.outputPath("deep-editor-" + String(width) + ".png"), fullPage: true });
  }
  await page.getByRole("spinbutton", { name: "Point 1 value", exact: true }).fill("-10"); await page.getByRole("spinbutton", { name: "Point 1 value", exact: true }).blur();
  expect((await project(page)).advanced).toEqual(before);
  expect((await project(page)).deepMastering?.proposal.moves.find((move) => move.id === selected.id)?.points[0]?.value).toBe(-10);
});

test("Deep cancel detaches immediately during admission and deletes the actual late job", async ({ page }) => {
  await uploadProject(page, "deep-cancel.wav", 1); await page.getByRole("tab", { name: "deep", exact: true }).click();
  let release: (() => void) | undefined; const held = new Promise<void>((resolve) => { release = resolve; }); let id = "";
  await page.route("**/api/analyze/deep", async (route) => { const response = await route.fetch(); id = (await response.json() as { jobId: string }).jobId; await held; await route.fulfill({ response }); });
  await page.getByRole("button", { name: "Analyze Deep proposal", exact: true }).click(); await expect.poll(() => id).not.toBe("");
  await page.getByRole("button", { name: "Cancel Deep analysis", exact: true }).click();
  await expect(page.getByRole("button", { name: "Analyze Deep proposal", exact: true })).toBeEnabled(); await expect(page.getByRole("button", { name: "Cancel Deep analysis", exact: true })).toHaveCount(0);
  const deleted = page.waitForRequest((request) => request.url().endsWith("/api/jobs/" + id) && request.method() === "DELETE"); release?.(); await deleted;
  expect((await project(page)).deepMastering).toBeUndefined();
  const response = await page.request.get("/api/jobs/" + id); expect((await response.json() as { status: string }).status).toBe("cancel" + "led");
});

test("applied Deep revisions are idempotent and Advanced edits, export, Detach and Revert use acknowledged snapshots", async ({ page }) => {
  test.setTimeout(90000);
  await uploadProject(page, "deep-apply.wav", 3); const original = await project(page);
  await page.getByRole("tab", { name: "deep", exact: true }).click();
  await page.getByRole("button", { name: "Analyze Deep proposal", exact: true }).click();
  await expect(page.getByText("Measured proposal ready. Your applied processing has not changed.", { exact: true })).toBeVisible({ timeout: 30000 });
  await page.getByRole("button", { name: "Apply Deep proposal", exact: true }).click();
  await expect.poll(async () => (await project(page)).deepMastering?.applied?.revision ?? 0).toBeGreaterThan(0);
  const first = await project(page); expect(first.deepMastering?.before?.advanced).toEqual(original.advanced);
  await page.getByRole("button", { name: "Apply Deep proposal", exact: true }).click();
  await expect.poll(async () => (await project(page)).deepMastering?.applied?.revision ?? 0).toBeGreaterThan(first.deepMastering?.applied?.revision ?? 0);
  const repeated = await project(page); expect(repeated.deepMastering?.before).toEqual(first.deepMastering?.before);
  expect({ ...repeated.deepMastering?.applied, revision: 1 }).toEqual({ ...first.deepMastering?.applied, revision: 1 });
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(page.getByLabel("Playback transport")).toHaveAttribute("data-playing", "true");
  await page.getByRole("tab", { name: "advanced", exact: true }).click();
  await page.getByRole("slider", { name: "Input gain", exact: true }).fill("3");
  await expect.poll(async () => (await project(page)).deepMastering?.applied?.chainParams.inputGainDb).toBe(3);
  await page.getByRole("checkbox", { name: "Enable De-Harsh", exact: true }).check();
  await expect.poll(async () => (await project(page)).deepMastering?.applied?.chainParams.deHarsh.enabled).toBe(true);
  await page.getByRole("checkbox", { name: "Enable multiband", exact: true }).check();
  await expect.poll(async () => (await project(page)).deepMastering?.applied?.chainParams.multiband.enabled).toBe(true);
  const edited = await project(page); expect(edited.deepMastering?.before).toEqual(first.deepMastering?.before);
  expect(edited.deepMastering?.applied?.moves).toEqual(first.deepMastering?.applied?.moves);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const dialog = page.getByRole("dialog"); await dialog.getByRole("button", { name: "32-bit Float", exact: true }).click();
  await page.evaluate(() => {
    const native = window.fetch;
    window.fetch = (input, init) => {
      if (typeof input === "string" && input.endsWith("/api/master/render") && init?.body instanceof FormData)
        (window as Window & { exportFields?: { keys: string[]; script: unknown } }).exportFields = { keys: Array.from(init.body.keys()), script: JSON.parse(String(init.body.get("script"))) as unknown };
      return native(input, init);
    };
  });
  const downloaded = page.waitForEvent("download"); await dialog.getByRole("button", { name: "Render & download WAV", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as Window & { exportFields?: { keys: string[] } }).exportFields?.keys)).toEqual(["file", "script", "bitDepth"]);
  // Export renders a copy of the applied script with the algorithm 2 true-peak limiter.
  const applied = edited.deepMastering?.applied; if (!applied) throw new Error("Missing applied script");
  expect(await page.evaluate(() => (window as Window & { exportFields?: { script: unknown } }).exportFields?.script)).toEqual({ ...applied, chainParams: { ...applied.chainParams, algorithmVersion: 2, limiter: { ...applied.chainParams.limiter, truePeak: true } } });
  const download = await downloaded; expect(await download.failure()).toBeNull(); const path = await download.path(); if (!path) throw new Error("Missing applied script export");
  const pcm = decode(await readFile(path)); expect(pcm.left.length).toBe(3 * 48000); expect(pcm.rate).toBe(48000); expect(pcm.bits).toBe(32);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Detach automation", exact: true }).click();
  await expect.poll(async () => (await project(page)).deepMastering?.applied).toBeUndefined();
  expect((await project(page)).advanced.input).toBe(3);
  await page.getByRole("tab", { name: "deep", exact: true }).click();
  await page.getByRole("button", { name: "Apply Deep proposal", exact: true }).click();
  await expect.poll(async () => !!(await project(page)).deepMastering?.applied).toBe(true);
  await page.getByRole("button", { name: "Revert before first Apply", exact: true }).click();
  await expect.poll(async () => (await project(page)).deepMastering?.applied).toBeUndefined();
  expect((await project(page)).advanced.input).toBe(3);
});

async function exportFloat(page: Page) {
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const dialog = page.getByRole("dialog"); await dialog.getByRole("button", { name: "32-bit Float", exact: true }).click();
  const pending = page.waitForEvent("download"); await dialog.getByRole("button", { name: "Render & download WAV", exact: true }).click();
  const download = await pending; expect(await download.failure()).toBeNull(); const path = await download.path(); if (!path) throw new Error("Missing native script export");
  const bytes = await readFile(path); await page.keyboard.press("Escape"); return bytes;
}

test("muted and explicitly soloed proposals drive the same live and native export snapshot", async ({ page }) => {
  test.setTimeout(60000); await captureDeepDevice(page, 48000); await uploadProject(page, "deep-mute-solo.wav", 6);
  await page.getByRole("tab", { name: "deep", exact: true }).click(); await page.getByRole("button", { name: "Analyze Deep proposal", exact: true }).click();
  await expect(page.getByText("Measured proposal ready. Your applied processing has not changed.", { exact: true })).toBeVisible({ timeout: 30000 });
  await page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem("aurialis-state-v1") ?? "{}") as { tracks: Track[] }; const track = state.tracks[0], deep = track?.deepMastering; if (!deep) throw new Error("Missing measured proposal");
    const section = deep.proposal.sections[0]; if (!section) throw new Error("Missing source section");
    deep.proposal.revision++;
    deep.proposal.moves = [{ id: "manual-gain", target: "inputGainDb", value: 4 }, { id: "manual-width", target: "stereo.widthPct", value: 0 }].map((item) => ({ id: item.id, sectionId: section.id, target: item.target as "inputGainDb" | "stereo.widthPct", operation: "absolute", muted: false, reason: "Explicit manual envelope for live and export comparison", fadeFrames: 2400, points: [{ frame: section.startFrame, value: item.value }, { frame: section.endFrame, value: item.value }] }));
    localStorage.setItem("aurialis-state-v1", JSON.stringify(state));
  });
  await page.reload(); await expect(page.getByRole("button", { name: "Apply Deep proposal", exact: true })).toBeEnabled();
  const select = page.getByRole("combobox", { name: "Automation move", exact: true }); await select.selectOption("manual-width"); await page.getByRole("button", { name: "Mute draft move", exact: true }).click(); await page.getByRole("button", { name: "Close move editor", exact: true }).click();
  await page.getByRole("button", { name: "Apply Deep proposal", exact: true }).click(); await expect.poll(async () => !!(await project(page)).deepMastering?.applied).toBe(true);
  await page.getByRole("button", { name: "Play", exact: true }).click(); await expect.poll(async () => (await capturedProgress(page))?.frames ?? 0).toBeGreaterThanOrEqual(65536); await page.getByRole("button", { name: "Pause", exact: true }).click();
  const capture = await capturedDevice(page); if (!capture) throw new Error("Missing muted live capture"); const muted = await exportFloat(page), pcm = decode(muted); let maximum = 0;
  for (let index = 0; index < 65536; index++) maximum = Math.max(maximum, Math.abs((pcm.left[index] ?? 0) - (capture.outputLeft[index] ?? 0)), Math.abs((pcm.right[index] ?? 0) - (capture.outputRight[index] ?? 0)));
  expect(maximum).toBeLessThan(1e-6);
  await select.selectOption("manual-width"); await page.getByRole("button", { name: "Unmute draft move", exact: true }).click(); await page.getByRole("button", { name: "Close move editor", exact: true }).click();
  await select.selectOption("manual-gain"); await page.getByRole("button", { name: "Solo in proposal", exact: true }).click(); await page.getByRole("button", { name: "Close move editor", exact: true }).click();
  await expect(page.getByText("Solo proposal: Apply will mute the other moves in both live playback and export.", { exact: true })).toBeVisible();
  const previous = (await project(page)).deepMastering?.applied?.revision ?? 0; await page.getByRole("button", { name: "Apply solo proposal", exact: true }).click(); await expect.poll(async () => (await project(page)).deepMastering?.applied?.revision ?? 0).toBeGreaterThan(previous);
  expect((await project(page)).deepMastering?.proposal.moves.every((move) => !move.muted)).toBe(true);
  expect((await project(page)).deepMastering?.applied?.moves.find((move) => move.id === "manual-width")?.muted).toBe(true);
  expect(await exportFloat(page)).toEqual(muted);
  await select.selectOption("manual-gain"); await page.getByRole("button", { name: "Clear solo proposal", exact: true }).click(); await page.getByRole("button", { name: "Close move editor", exact: true }).click();
  const soloRevision = (await project(page)).deepMastering?.applied?.revision ?? 0; await page.getByRole("button", { name: "Apply Deep proposal", exact: true }).click(); await expect.poll(async () => (await project(page)).deepMastering?.applied?.revision ?? 0).toBeGreaterThan(soloRevision);
  const unmuted = await exportFloat(page); expect(unmuted.equals(muted)).toBe(false); const mono = decode(unmuted); let difference = 0; for (let index = 4800; index < 6 * 48000 - 4800; index++) difference = Math.max(difference, Math.abs((mono.left[index] ?? 0) - (mono.right[index] ?? 0))); expect(difference).toBeLessThan(1e-7);
});

test("reanalysis requires explicit draft replacement and Cancel or Escape preserves authored work", async ({ page }, info) => {
  test.setTimeout(90000); let analyses = 0; page.on("request", (request) => { if (request.url().endsWith("/api/analyze/deep") && request.method() === "POST") analyses++; });
  await uploadProject(page, "deep-discard.wav", 2); await page.getByRole("tab", { name: "deep", exact: true }).click();
  await page.getByRole("button", { name: "Analyze Deep proposal", exact: true }).click();
  await expect(page.getByText("Measured proposal ready. Your applied processing has not changed.", { exact: true })).toBeVisible({ timeout: 30000 });
  await page.getByRole("button", { name: "Apply Deep proposal", exact: true }).click(); await expect.poll(async () => !!(await project(page)).deepMastering?.applied).toBe(true);
  await page.getByRole("button", { name: "Add baseline move", exact: true }).click();
  const point = page.getByRole("spinbutton", { name: "Point 1 value", exact: true }); await point.fill("-2"); await point.blur();
  await page.getByRole("button", { name: "Add baseline point", exact: true }).click(); await page.getByRole("button", { name: "Mute draft move", exact: true }).click();
  await page.getByRole("button", { name: "Close move editor", exact: true }).click();
  await page.getByRole("combobox", { name: "New move target", exact: true }).selectOption("stereo.widthPct"); await page.getByRole("button", { name: "Add baseline move", exact: true }).click(); await page.getByRole("button", { name: "Delete draft move", exact: true }).click();
  const before = await project(page), authored = before.deepMastering?.proposal.moves.find((move) => move.muted); if (!authored) throw new Error("Missing authored muted draft"); expect(authored.points).toHaveLength(3); expect(authored.points[0]?.value).toBe(-2);
  await page.getByRole("combobox", { name: "Deep engineer profile", exact: true }).selectOption("Vocal Forward");
  const requestsBefore = analyses, analyze = page.getByRole("button", { name: "Analyze Deep proposal", exact: true }); await analyze.click();
  const dialog = page.getByRole("dialog", { name: "Replace Deep draft?", exact: true }); await expect(dialog).toBeVisible(); await expect(dialog).toContainText("Vocal Forward");
  for (const width of [320, 375, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    for (const button of await dialog.getByRole("button").all()) { const box = await button.boundingBox(); expect(box?.width).toBeGreaterThanOrEqual(44); expect(box?.height).toBeGreaterThanOrEqual(44); }
    const exposed = await page.locator("button:visible,input:visible,select:visible").evaluateAll((elements) => elements.filter((element) => !element.closest('[role="dialog"]')).filter((element) => { const box = element.getBoundingClientRect(), x = box.x + box.width / 2, y = box.y + box.height / 2; if (x < 0 || x >= innerWidth || y < 0 || y >= innerHeight) return false; const hit = document.elementFromPoint(x, y); return hit === element || !!hit && element.contains(hit); }).map((element) => element.getAttribute("aria-label") ?? element.textContent));
    expect(exposed, String(width) + "px modal backdrop must block background controls").toEqual([]);
    expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations, String(width) + "px replacement confirmation").toEqual([]);
    await dialog.getByRole("button", { name: "Close dialog", exact: true }).focus(); await page.keyboard.press("Shift+Tab"); await expect(dialog.getByRole("button", { name: "Replace draft and analyze", exact: true })).toBeFocused(); await page.keyboard.press("Tab"); await expect(dialog.getByRole("button", { name: "Close dialog", exact: true })).toBeFocused();
    if (width === 320 || width === 1440) await page.screenshot({ path: info.outputPath("deep-replace-draft-" + String(width) + ".png"), fullPage: true });
  }
  await dialog.getByRole("button", { name: "Keep draft", exact: true }).click(); await expect(dialog).toHaveCount(0); await expect(analyze).toBeFocused();
  expect((await project(page)).deepMastering).toEqual(before.deepMastering); expect((await project(page)).advanced).toEqual(before.advanced); expect(analyses).toBe(requestsBefore);
  await analyze.click(); await expect(dialog).toBeVisible(); await page.keyboard.press("Escape"); await expect(dialog).toHaveCount(0); await expect(analyze).toBeFocused();
  expect((await project(page)).deepMastering).toEqual(before.deepMastering); expect(analyses).toBe(requestsBefore);
  await analyze.click(); await dialog.getByRole("button", { name: "Replace draft and analyze", exact: true }).click();
  await expect.poll(async () => (await project(page)).deepMastering?.proposal.revision ?? 0).toBeGreaterThan(before.deepMastering?.proposal.revision ?? 0);
  const replaced = await project(page); expect(analyses).toBe(requestsBefore + 1); expect(replaced.deepMastering?.proposal.profile).toBe("Vocal Forward"); expect(replaced.deepMastering?.proposal.moves.some((move) => move.id === authored.id)).toBe(false);
  expect(replaced.deepMastering?.applied).toEqual(before.deepMastering?.applied); expect(replaced.deepMastering?.before).toEqual(before.deepMastering?.before); expect(replaced.advanced).toEqual(before.advanced);
});
