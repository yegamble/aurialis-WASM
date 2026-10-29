import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { decode, fixture } from "./audio-fixture";
import { uploadProject } from "./workflow-fixture";
import { verifyReleaseQualityStaleness } from "./release-quality-cases";
import { exportScript } from "../src/lib/engine-params";
import type { ReleaseReport } from "../src/lib/release-review";
import type { Track } from "../src/lib/types";

async function project(page: Page): Promise<Track> {
  const track = await page.evaluate(() => (JSON.parse(localStorage.getItem("aurialis-state-v1") ?? "{}") as { tracks: Track[] }).tracks[0]);
  if (!track) throw new Error("Missing source project"); return track;
}
async function download(page: Page, label: string): Promise<Buffer> {
  const pending = page.waitForEvent("download"); await page.getByRole("button", { name: label, exact: true }).click();
  const path = await (await pending).path(); if (!path) throw new Error("Missing downloaded artifact"); return readFile(path);
}
async function report(page: Page): Promise<ReleaseReport> { return JSON.parse((await download(page, "Download JSON report")).toString()) as ReleaseReport; }
async function chooseBits(page: Page, bits: number) {
  await page.getByRole("group", { name: "Bit depth", exact: true }).getByRole("button", { name: bits === 32 ? "32-bit Float" : `${String(bits)}-bit PCM`, exact: true }).click();
}
async function run(page: Page) {
  await page.getByRole("button", { name: "Run release check", exact: true }).click();
  await expect(page.getByRole("region", { name: "Encoded audio review", exact: true })).toBeVisible({ timeout: 30_000 });
}

test("16/24/32-bit release reviews measure, hash and repeatedly download the same encoded bytes", async ({ page, request }, info) => {
  const id = await uploadProject(page, "release-artifact.wav");
  await page.getByRole("slider", { name: "Input gain", exact: true }).fill("3");
  await page.goto(`/release-check/${id}`);
  let audioRequests = 0; page.on("request", (item) => { if (item.method() === "POST" && item.url().endsWith("/api/master/render")) audioRequests++; });
  for (const bits of [16, 24, 32]) {
    await chooseBits(page, bits); await run(page);
    const beforeDownloads = audioRequests, receipt = await report(page), wav = await download(page, "Download measured WAV");
    expect(await download(page, "Download measured WAV")).toEqual(wav); expect(audioRequests).toBe(beforeDownloads);
    const pcm = decode(wav); expect(pcm.bits).toBe(bits); expect(pcm.rate).toBe(48000); expect(pcm.left).toHaveLength(48000);
    expect(receipt.output.sha256).toBe(createHash("sha256").update(wav).digest("hex")); expect(receipt.output.bytes).toBe(wav.length);
    const peak = pcm.left.reduce((value, sample, index) => Math.max(value, Math.abs(sample), Math.abs(pcm.right[index] ?? 0)), 0);
    expect(receipt.metrics.samplePeakDbfs).toBeCloseTo(20 * Math.log10(peak), 8);
    const measured = await request.post("/api/master/render", { multipart: { file: { name: "encoded.wav", mimeType: "audio/wav", buffer: wav }, params: JSON.stringify({ bypass: true }), format: "json" } });
    expect(measured.ok()).toBe(true); expect((await measured.json() as { afterMetrics: unknown }).afterMetrics).toEqual(receipt.metrics);
    await info.attach(`release-${String(bits)}.json`, { body: JSON.stringify(receipt), contentType: "application/json" });
  }
});

test("six delivery profiles and a populated encoded review remain accessible at six widths", async ({ page }, info) => {
  test.setTimeout(90_000); const id = await uploadProject(page, "release-responsive.wav"); await page.goto(`/release-check/${id}`); await run(page);
  const profiles = page.getByRole("group", { name: "Delivery profile", exact: true });
  await expect(profiles.getByRole("button")).toHaveText(["Spotify", "Apple Music", "YouTube", "SoundCloud", "CD", "Podcast"]);
  for (const name of ["Spotify", "Apple Music", "YouTube", "SoundCloud", "CD", "Podcast"]) {
    const control = profiles.getByRole("button", { name, exact: true }); await control.focus(); await page.keyboard.press("Enter"); await expect(control).toHaveAttribute("aria-pressed", "true");
    const receipt = await report(page); expect(receipt.platform).toBe(name); expect(receipt.output.frames).toBe(48000);
  }
  for (const width of [320, 375, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const targets = await page.locator("button:visible, select:visible, a:visible").evaluateAll((elements) => elements.map((element) => ({ label: element.textContent, rect: element.getBoundingClientRect() })).filter((item) => item.rect.width > 0 && item.rect.height > 0).map((item) => ({ label: item.label, width: item.rect.width, height: item.rect.height })));
    expect(targets.filter((item) => item.width < 43.5 || item.height < 43.5), `${String(width)}px targets`).toEqual([]);
    const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze(); expect(axe.violations, `${String(width)}px encoded report`).toEqual([]);
    if (width === 320 || width === 1440) await page.screenshot({ path: info.outputPath(`release-${String(width)}.png`), fullPage: true });
  }
});

test("saved release receipts survive reload, invalidate on edits and recover visibly from missing source", async ({ page }) => {
  const id = await uploadProject(page, "release-recovery.wav"); await page.goto(`/release-check/${id}`); await run(page);
  const original = await report(page); await page.getByRole("button", { name: "Save report to project", exact: true }).click();
  await expect.poll(async () => (await project(page)).releaseReview?.output.sha256).toBe(original.output.sha256);
  await page.reload(); await expect(page.getByRole("region", { name: "Encoded audio review", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Download measured WAV", exact: true })).toBeDisabled(); expect((await report(page)).output).toEqual(original.output);
  await verifyReleaseQualityStaleness(page, id);
  await chooseBits(page, 16); await expect(page.getByRole("region", { name: "Encoded audio review", exact: true })).toHaveCount(0);
  await page.goto(`/master/${id}`); await page.getByRole("slider", { name: "Input gain", exact: true }).fill("6"); await page.goto(`/release-check/${id}`);
  await expect(page.getByRole("region", { name: "Encoded audio review", exact: true })).toHaveCount(0);
  const track = await project(page);
  await page.evaluate(async (key) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const opening = indexedDB.open("aurialis-local", 2); opening.onsuccess = () => resolve(opening.result); opening.onerror = () => reject(opening.error); });
    try { await new Promise<void>((resolve, reject) => { const transaction = db.transaction("audio", "readwrite"); transaction.objectStore("audio").delete(key); transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error); }); } finally { db.close(); }
  }, track.sourceAudioId ?? id);
  await page.reload(); await page.getByRole("button", { name: "Run release check", exact: true }).click();
  await expect(page.locator("main").getByRole("alert")).toContainText("Restore the matching source in Library"); await expect(page.getByRole("region", { name: "Encoded audio review", exact: true })).toHaveCount(0);
});

test("Release uses the acknowledged Deep script and produces the exact native scripted WAV", async ({ page, request }) => {
  const id = await uploadProject(page, "release-deep.wav"); await page.getByRole("tab", { name: "deep", exact: true }).click();
  await page.getByRole("button", { name: "Analyze Deep proposal", exact: true }).click(); await expect(page.getByText("Measured proposal ready. Your applied processing has not changed.", { exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Apply Deep proposal", exact: true }).click(); await expect.poll(async () => (await project(page)).deepMastering?.applied?.revision ?? 0).toBeGreaterThan(0);
  const applied = (await project(page)).deepMastering?.applied; if (!applied) throw new Error("Missing accepted script");
  await page.goto(`/release-check/${id}`); await run(page); const receipt = await report(page), actual = await download(page, "Download measured WAV");
  expect(receipt.scriptRevision).toBe(applied.revision);
  const native = await request.post("/api/master/render", { multipart: { file: { name: "source.wav", mimeType: "audio/wav", buffer: fixture() }, script: JSON.stringify(exportScript(applied)), bitDepth: "24" } });
  expect(native.ok()).toBe(true); expect(actual).toEqual(await native.body());
});

test("cancel and encoding changes reject a late real rendered artifact", async ({ page }) => {
  const id = await uploadProject(page, "release-cancel.wav"); await page.goto(`/release-check/${id}`);
  for (const action of ["cancel", "encoding"]) {
    let release: (() => void) | undefined, received = false;
    const held = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/api/master/render", async (route) => {
      if (route.request().headers().accept === "application/json") { await route.continue(); return; }
      const response = await route.fetch(); received = true; await held; await route.fulfill({ response }).catch(() => undefined);
    });
    try {
      await page.getByRole("button", { name: "Run release check", exact: true }).click(); await expect.poll(() => received).toBe(true);
      if (action === "cancel") await page.getByRole("button", { name: "Cancel release check", exact: true }).click();
      else await chooseBits(page, 16);
      release?.(); await expect(page.getByRole("button", { name: "Run release check", exact: true })).toBeEnabled();
      await expect(page.getByRole("region", { name: "Encoded audio review", exact: true })).toHaveCount(0); expect((await project(page)).releaseReview).toBeUndefined();
    } finally { release?.(); await page.unroute("**/api/master/render"); }
  }
  await run(page); await expect(page.getByRole("button", { name: "Download measured WAV", exact: true })).toBeEnabled();
});

// V1-04: a 48 kHz source checked for CD measures the 44.1 kHz / 16-bit file Export delivers.
test("a 48 kHz source checked at CD format measures the delivered 44.1 kHz/16-bit WAV that Export renders", async ({ page, request }, info) => {
  const id = await uploadProject(page, "release-cd.wav");
  await page.getByRole("slider", { name: "Input gain", exact: true }).fill("3");
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("group", { name: "Bit depth", exact: true }).getByRole("button", { name: "16-bit PCM", exact: true }).click();
  await dialog.getByRole("group", { name: "Sample rate", exact: true }).getByRole("button", { name: "44.1 kHz", exact: true }).click();
  const exporting = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Render & download WAV", exact: true }).click();
  const exportedPath = await (await exporting).path(); await page.keyboard.press("Escape");
  const exported = await readFile(exportedPath);
  await page.goto(`/release-check/${id}`);
  await page.getByRole("group", { name: "Delivery profile", exact: true }).getByRole("button", { name: "CD", exact: true }).click();
  await page.getByRole("button", { name: "Use CD format: 44.1 kHz, 16-bit", exact: true }).click();
  await expect(page.getByText("Checks 44.1 kHz · 16-bit PCM · TPDF dither, the same file Export renders at this format.", { exact: true })).toBeVisible();
  await run(page);
  await expect(page.getByText("Output format (Within guidance)", { exact: true })).toBeVisible();
  await expect(page.getByText("44.1 kHz · 16-bit PCM · stereo", { exact: true })).toBeVisible();
  const receipt = await report(page), wav = await download(page, "Download measured WAV");
  // The WAV header itself says 44.1 kHz, 16-bit stereo PCM.
  expect([wav.toString("ascii", 0, 4), wav.readUInt16LE(20), wav.readUInt16LE(22), wav.readUInt32LE(24), wav.readUInt16LE(34)]).toEqual(["RIFF", 1, 2, 44100, 16]);
  const pcm = decode(wav); expect([pcm.rate, pcm.bits, pcm.left.length]).toEqual([44100, 16, 44100]);
  expect(receipt.output).toMatchObject({ sampleRate: 44100, bitDepth: 16, frames: 44100, bytes: wav.length, sha256: createHash("sha256").update(wav).digest("hex") });
  expect(receipt.dither).toBe("tpdf"); expect(receipt.source.sampleRate).toBe(48000);
  // The measured file is the delivered file, and it measures exactly as reported.
  expect(wav).toEqual(exported);
  const measured = await request.post("/api/master/render", { multipart: { file: { name: "encoded.wav", mimeType: "audio/wav", buffer: wav }, params: JSON.stringify({ bypass: true }), format: "json" } });
  expect(measured.ok()).toBe(true);
  const reading = await measured.json() as { sampleRate: number; afterMetrics: unknown };
  expect(reading.sampleRate).toBe(44100); expect(reading.afterMetrics).toEqual(receipt.metrics);
  await info.attach("release-cd.json", { body: JSON.stringify(receipt, null, 2), contentType: "application/json" });
});
