import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { albumLinearParams, type AlbumReport } from "../src/lib/album-batch";
import { engineParams } from "../src/lib/browser-engine";
import type { Album, Track } from "../src/lib/types";
import { decode, fixture } from "./audio-fixture";
import { uploadProject } from "./workflow-fixture";

async function workspace(page: Page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem("aurialis-state-v1") ?? "{}") as { tracks: Track[]; albums: Album[] });
}
async function openAlbum(page: Page, titles: string[]) {
  await page.goto("/albums"); await page.getByRole("button", { name: "New album", exact: true }).click();
  await page.getByRole("link", { name: /Untitled sequence 1/u }).click();
  for (const title of titles) await page.getByRole("button", { name: title, exact: true }).click();
}
async function download(page: Page, name: string) {
  const waiting = page.waitForEvent("download"); await page.getByRole("button", { name, exact: true }).click();
  const path = await (await waiting).path(); if (!path) throw new Error("Missing album download"); return readFile(path);
}
async function report(page: Page) { return JSON.parse((await download(page, "Download album JSON report")).toString()) as AlbumReport; }
async function run(page: Page, count: number) {
  await page.getByRole("button", { name: "Render album masters", exact: true }).click();
  await expect(page.getByText(`${String(count)} of ${String(count)} verified masters.`, { exact: true })).toBeVisible({ timeout: 30_000 });
}

test("album gain preserves every accepted chain and Deep script, then hashes and measures each exact native 24-bit output", async ({ page, request }, info) => {
  const first = await uploadProject(page, "album-static.wav");
  await page.getByRole("slider", { name: "Input gain", exact: true }).fill("2");
  const second = await uploadProject(page, "album-deep.wav");
  await page.getByRole("tab", { name: "deep", exact: true }).click(); await page.getByRole("button", { name: "Analyze Deep proposal", exact: true }).click();
  await expect(page.getByText("Measured proposal ready. Your applied processing has not changed.", { exact: true })).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: "Apply Deep proposal", exact: true }).click();
  await expect.poll(async () => (await workspace(page)).tracks.find((track) => track.id === second)?.deepMastering?.applied?.revision ?? 0).toBeGreaterThan(0);
  const original = (await workspace(page)).tracks;
  await openAlbum(page, ["album static", "album deep"]);
  await page.getByRole("combobox", { name: "Album target", exact: true }).selectOption("-18");
  await page.getByRole("slider", { name: "Manual gain for album deep", exact: true }).fill("1");
  await run(page, 2); const receipt = await report(page);
  expect(receipt.complete).toBe(true); expect(receipt.cohortIds).toEqual([first, second]); expect(receipt.mode).toBe("relationships");
  expect(receipt.tracks[1]?.gain.gainDb).toBeCloseTo((receipt.tracks[0]?.gain.gainDb ?? 0) + 1, 10);
  for (const trackId of [first, second]) {
    const track = original.find((item) => item.id === trackId), row = receipt.tracks.find((item) => item.id === trackId); if (!track || !row) throw new Error("Missing album source or receipt");
    const actual = await download(page, `Download ${track.title}`), repeated = await download(page, `Download ${track.title}`);
    expect(repeated).toEqual(actual); const pcm = decode(actual); expect(pcm.bits).toBe(24); expect(pcm.rate).toBe(48000); expect(pcm.left).toHaveLength(48000);
    expect(row.output.sha256).toBe(createHash("sha256").update(actual).digest("hex")); expect(row.output.bytes).toBe(actual.length);
    const chain = await request.post("/api/master/render", { multipart: { file: { name: "source.wav", mimeType: "audio/wav", buffer: fixture() }, ...(track.deepMastering?.applied ? { script: JSON.stringify(track.deepMastering.applied) } : { params: JSON.stringify(engineParams(track.advanced)) }), bitDepth: "32" } });
    expect(chain.ok()).toBe(true);
    const native = await request.post("/api/master/render", { multipart: { file: { name: "chain.wav", mimeType: "audio/wav", buffer: await chain.body() }, params: JSON.stringify(albumLinearParams(row.gain.gainDb)), bitDepth: "24" } });
    expect(native.ok()).toBe(true); expect(actual).toEqual(await native.body());
    const measured = await request.post("/api/master/render", { multipart: { file: { name: "final.wav", mimeType: "audio/wav", buffer: actual }, params: JSON.stringify({ bypass: true }), format: "json" } });
    expect(measured.ok()).toBe(true); expect((await measured.json() as { afterMetrics: unknown }).afterMetrics).toEqual(row.metrics);
    const peak = pcm.left.reduce((value, sample, index) => Math.max(value, Math.abs(sample), Math.abs(pcm.right[index] ?? 0)), 0);
    expect(row.metrics.samplePeakDbfs).toBeCloseTo(20 * Math.log10(peak), 8);
  }
  expect((await workspace(page)).tracks).toEqual(original);
  await info.attach("album-receipt.json", { body: JSON.stringify(receipt), contentType: "application/json" });
  await page.getByRole("button", { name: "Save album report", exact: true }).click();
  await expect.poll(async () => (await workspace(page)).albums[0]?.report?.bindingHash).toBe(receipt.bindingHash);
  expect(await download(page, "Download album static")).toEqual(await download(page, "Download album static"));
  await page.reload(); await expect(page.getByRole("region", { name: "Rendered album downloads", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Download album static", exact: true })).toHaveCount(0); expect((await report(page)).tracks).toEqual(receipt.tracks);
  await page.getByRole("slider", { name: "Manual gain for album static", exact: true }).fill("-1"); await expect(page.getByRole("region", { name: "Rendered album downloads", exact: true })).toHaveCount(0);
});

test("album management, all gain targets, populated charts and explicit reorder controls work at six accessible widths", async ({ page }, info) => {
  test.setTimeout(90_000); await page.setViewportSize({ width: 1440, height: 1000 });
  const longTitle = `album ${"long".repeat(48)}`;
  await uploadProject(page, "album-one.wav"); await uploadProject(page, `${longTitle.replace(" ", "-")}.wav`);
  await openAlbum(page, ["album one", longTitle]);
  const target = page.getByRole("combobox", { name: "Album target", exact: true });
  for (const value of [-23, -18, -16, -14, -12, -9]) { await target.selectOption(String(value)); expect((await workspace(page)).albums[0]?.target).toBe(`${String(value).replace("-", "−")} LUFS`); }
  await target.selectOption("-18");
  const down = page.getByRole("button", { name: "Move album one down", exact: true }); await down.focus(); await page.keyboard.press("Enter");
  expect((await workspace(page)).albums[0]?.trackIds).toEqual((await workspace(page)).tracks.map((track) => track.id));
  await page.getByRole("button", { name: "Move album one up", exact: true }).click();
  const order = page.getByRole("list", { name: "Album running order", exact: true });
  await order.getByRole("listitem").filter({ has: page.getByRole("link", { name: "album one", exact: true }) }).dragTo(order.getByRole("listitem").filter({ has: page.getByRole("link", { name: longTitle, exact: true }) }));
  expect((await workspace(page)).albums[0]?.trackIds).toEqual((await workspace(page)).tracks.map((track) => track.id));
  await page.getByRole("button", { name: "Move album one up", exact: true }).click();
  await run(page, 2);
  for (const name of ["Loudness", "Tone", "Dynamics"]) { const control = page.getByRole("group", { name: "Consistency view", exact: true }).getByRole("button", { name, exact: true }); await control.focus(); await page.keyboard.press("Enter"); await expect(control).toHaveAttribute("aria-pressed", "true"); await expect(page.getByRole("list", { name: `${name} text readings`, exact: true })).toContainText("album one"); }
  for (const width of [320, 375, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 }); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const targets = await page.locator("button:visible, input:visible, select:visible, a:visible").evaluateAll((elements) => elements.map((element) => ({ label: element.getAttribute("aria-label") ?? element.textContent, rect: element.getBoundingClientRect() })).filter((item) => item.rect.width > 0 && item.rect.height > 0).map((item) => ({ label: item.label, width: item.rect.width, height: item.rect.height })));
    expect(targets.filter((item) => item.width < 43.5 || item.height < 43.5), `${String(width)}px album targets`).toEqual([]);
    const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze(); expect(axe.violations, `${String(width)}px populated album`).toEqual([]);
    if (width === 320 || width === 1440) await page.screenshot({ path: info.outputPath(`album-${String(width)}.png`), fullPage: true });
  }
  await page.goto("/albums"); await page.getByRole("button", { name: "Rename Untitled sequence 1", exact: true }).click();
  await page.getByLabel("Album name", { exact: true }).fill("A measured sequence"); await page.getByRole("button", { name: "Save name", exact: true }).click();
  await page.getByRole("button", { name: "Delete A measured sequence", exact: true }).click(); await page.keyboard.press("Escape"); await expect(page.getByRole("link", { name: /A measured sequence/u })).toBeVisible();
  await page.getByRole("button", { name: "Delete A measured sequence", exact: true }).click(); await page.getByRole("button", { name: "Delete album", exact: true }).click();
  expect((await workspace(page)).albums).toHaveLength(0); expect((await workspace(page)).tracks).toHaveLength(2);
});

test("cancel keeps only a verified prefix, retry reuses it, and cohort edits invalidate every retained download", async ({ page }) => {
  await uploadProject(page, "prefix-one.wav"); await uploadProject(page, "prefix-two.wav"); await openAlbum(page, ["prefix one", "prefix two"]);
  let finalOutputs = 0, held = false, release: (() => void) | undefined;
  const waiting = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/master/render", async (route) => {
    const body = route.request().postDataBuffer()?.toString("utf8") ?? "";
    if (!/name="bitDepth"\r\n\r\n24\r\n/u.test(body)) { await route.continue(); return; }
    finalOutputs++;
    if (finalOutputs !== 2) { await route.continue(); return; }
    const response = await route.fetch(); held = true; await waiting; await route.fulfill({ response }).catch(() => undefined);
  });
  try {
    await page.getByRole("button", { name: "Render album masters", exact: true }).click(); await expect.poll(() => held).toBe(true);
    const prefix = await download(page, "Download prefix one"); await page.getByRole("button", { name: "Cancel album render", exact: true }).click(); release?.();
    await expect(page.getByRole("button", { name: "Render album masters", exact: true })).toBeEnabled(); await expect(page.getByRole("button", { name: "Download prefix two", exact: true })).toHaveCount(0);
    expect((await report(page)).tracks).toHaveLength(1); await run(page, 2); expect(finalOutputs).toBe(3); expect(await download(page, "Download prefix one")).toEqual(prefix);
    await page.getByRole("combobox", { name: "Album gain mode", exact: true }).selectOption("normalize"); await expect(page.getByRole("region", { name: "Rendered album downloads", exact: true })).toHaveCount(0);
  } finally { release?.(); await page.unroute("**/api/master/render"); }
});

test("direct album import and an all-silent short sequence require explicit manual gain and keep diagnostic uncertainty", async ({ page }) => {
  await page.goto("/albums"); await page.getByRole("button", { name: "New album", exact: true }).click(); await page.getByRole("link", { name: /Untitled sequence 1/u }).click();
  const silent = fixture(1000, 0.1); silent.fill(0, 44);
  await page.getByLabel("Import album audio", { exact: true }).setInputFiles({ name: "silent-short.wav", mimeType: "audio/wav", buffer: silent });
  await expect(page.getByRole("link", { name: "silent short", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Render album masters", exact: true }).click();
  await expect(page.locator("main").getByRole("alert")).toContainText("No measurable tracks");
  await expect(page.getByRole("button", { name: "Download silent short", exact: true })).toHaveCount(0);
  await page.getByRole("combobox", { name: "Album gain mode", exact: true }).selectOption("manual");
  await page.getByRole("slider", { name: "Manual gain for silent short", exact: true }).fill("6"); await run(page, 1);
  const receipt = await report(page), row = receipt.tracks[0]; expect(receipt.medianTrackLufs).toBeNull(); expect(receipt.commonGainDb).toBeNull();
  expect(row?.gain).toMatchObject({ gainDb: 6, requestedLufs: null, measurable: false });
  expect(row?.output.encoding).toMatchObject({ frames: 4800, leadingSilenceFrames: 4800, trailingSilenceFrames: 4800 });
  expect(decode(await download(page, "Download silent short")).left).toHaveLength(4800);
  await expect(page.getByText("Review: Too quiet or short for a reliable loudness comparison.", { exact: true })).toBeVisible();
});
