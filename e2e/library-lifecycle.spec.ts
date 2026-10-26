import { expect, test, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import type { Track } from "../src/lib/types";
import { readFile, writeFile } from "node:fs/promises";
import { dbRatio, decode, fixture } from "./audio-fixture";
import { meanOutputLevel, observeOutput, outputLevel } from "./live-output";
import { uploadProject } from "./workflow-fixture";

const file = (name: string, frequency = 1000, seconds = 1) => ({ name, mimeType: "audio/wav", buffer: fixture(frequency, seconds) });
async function projects(page: Page): Promise<Track[]> { return page.evaluate(() => (JSON.parse(localStorage.getItem("aurialis-state-v1") ?? "{}") as { tracks: Track[] }).tracks); }
async function openActions(page: Page, title: string) { await page.getByRole("button", { name: `Actions for ${title}`, exact: true }).click(); }
async function audioInfo(page: Page, key: string) {
  return page.evaluate(async (id) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open("aurialis-local", 2); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    try {
      const blob = await new Promise<Blob | undefined>((resolve, reject) => { const request = db.transaction("audio").objectStore("audio").get(id); request.onsuccess = () => resolve(request.result as Blob | undefined); request.onerror = () => reject(request.error); });
      return blob ? { size: blob.size, hash: Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()))).map((value) => value.toString(16).padStart(2, "0")).join("") } : null;
    } finally { db.close(); }
  }, key);
}
async function evict(page: Page, key: string) {
  await page.evaluate(async (id) => {
    const db = await new Promise<IDBDatabase>((resolve) => { const request = indexedDB.open("aurialis-local", 2); request.onsuccess = () => resolve(request.result); });
    await new Promise<void>((resolve, reject) => { const transaction = db.transaction("audio", "readwrite"); transaction.objectStore("audio").delete(id); transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error); }); db.close();
  }, key);
}

test("multiple imports retain successes, report a corrupt file and sort Library projects without changing their queue", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Import audio file").setInputFiles([file("Zulu.wav"), { name: "broken.wav", mimeType: "audio/wav", buffer: Buffer.from("corrupt") }, file("Alpha.wav", 500)]);
  await expect(page).toHaveURL(/\/master\/track-/);
  await expect(page.getByRole("heading", { name: "Zulu", exact: true })).toBeVisible();
  await expect(page.getByText(/2 imported\. Skipped broken.wav:/u)).toBeVisible();
  const before = (await projects(page)).map((track) => track.id);
  await page.goto("/library"); await page.getByRole("combobox", { name: "Sort projects", exact: true }).selectOption("name");
  await expect(page.locator(".library-project strong")).toHaveText(["Alpha", "Zulu"]);
  expect((await projects(page)).map((track) => track.id)).toEqual(before);
  await page.getByRole("textbox", { name: "Search your library", exact: true }).fill("absent");
  await expect(page.getByText("No projects match this search and filter.")).toBeVisible();
});

test("duplicated settings own playable audio after deleting the original and use actual WASI preview", async ({ page }, info) => {
  await observeOutput(page);
  await page.addInitScript(() => {
    const native = AudioContext.prototype.close;
    (window as Window & { closedAudioContexts?: number }).closedAudioContexts = 0;
    const owned: { context: AudioContext; stoppedAt: number }[] = [];
    (window as Window & { closedContextEvidence?: typeof owned }).closedContextEvidence = owned;
    AudioContext.prototype.close = function () {
      return native.call(this).then(() => {
        owned.push({ context: this, stoppedAt: this.currentTime });
        (window as Window & { closedAudioContexts?: number }).closedAudioContexts = owned.length;
      });
    };
  });
  const id = await uploadProject(page, "independent-source.wav", 16);
  await page.getByRole("slider", { name: "Input gain", exact: true }).fill("3");
  const original = (await projects(page)).find((track) => track.id === id);
  if (!original) throw new Error("Missing original");
  const originalAudio = await audioInfo(page, id);
  await page.goto("/library"); await openActions(page, "independent source"); await page.getByRole("button", { name: "Duplicate settings", exact: true }).click();
  await expect(page.getByRole("link", { name: /independent source copy/u })).toBeVisible();
  const copy = (await projects(page)).find((track) => track.id !== id);
  if (!copy) throw new Error("Missing copy");
  expect(copy.advanced).toEqual(original.advanced); expect(await audioInfo(page, copy.id)).toEqual(originalAudio);
  await openActions(page, "independent source"); await page.getByRole("button", { name: "Delete independent source", exact: true }).click(); await page.getByRole("button", { name: "Delete project", exact: true }).click();
  await expect(page.getByRole("link", { name: /^independent source 0:/u })).toHaveCount(0);
  expect(await audioInfo(page, id)).toBeNull(); expect(await audioInfo(page, copy.id)).toEqual(originalAudio);
  await openActions(page, "independent source copy"); await page.getByRole("button", { name: "Preview independent source copy", exact: true }).click();
  const dialog = page.getByRole("dialog"); await expect(dialog.getByRole("button", { name: "Play", exact: true })).toBeEnabled();
  await dialog.getByRole("slider", { name: "Playback volume", exact: true }).fill("1"); await dialog.getByRole("button", { name: "Play", exact: true }).click();
  await expect.poll(async () => (await outputLevel(page))?.rmsDbfs ?? -Infinity).toBeCloseTo(-16.03, 0);
  const processed = await meanOutputLevel(page); await dialog.getByRole("button", { name: "B Original", exact: true }).click(); await meanOutputLevel(page); const source = await meanOutputLevel(page);
  expect(processed - source).toBeCloseTo(3, 1);
  const transport = dialog.getByLabel("Playback transport");
  const beforeHold = Number(await transport.getAttribute("data-position"));
  const forward = dialog.getByRole("button", { name: "Skip forward 10 seconds", exact: true });
  await forward.focus(); await page.keyboard.down("Space");
  await expect(transport).toHaveAttribute("data-playing", "false");
  await expect.poll(async () => Number(await transport.getAttribute("data-position"))).toBeGreaterThan(beforeHold + 1);
  await page.keyboard.up("Space"); await expect(transport).toHaveAttribute("data-playing", "true");
  const generation = (await outputLevel(page))?.generation;
  await page.keyboard.press("Escape"); await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as Window & { closedAudioContexts?: number }).closedAudioContexts)).toBe(1);
  // A previously queued ScriptProcessor callback can be delivered after close.
  // The fulfilled native close and stopped render clock establish disposal.
  await page.waitForTimeout(250);
  expect(await page.evaluate(() => (window as Window & { closedContextEvidence?: { context: AudioContext; stoppedAt: number }[] }).closedContextEvidence?.every(({ context, stoppedAt }) => context.state === "closed" && context.currentTime === stoppedAt))).toBe(true);
  await openActions(page, "independent source copy"); await page.getByRole("button", { name: "Preview independent source copy", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Play", exact: true }).click();
  await expect.poll(async () => (await outputLevel(page))?.generation).toBe((generation ?? 0) + 1);
  await page.keyboard.press("Escape");
  await expect.poll(() => page.evaluate(() => (window as Window & { closedAudioContexts?: number }).closedAudioContexts)).toBe(2);
  await page.getByRole("link", { name: /independent source copy/u }).click();
  await expect(page.getByRole("button", { name: "Export", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Export", exact: true }).click();
  const exportDialog = page.getByRole("dialog"); await exportDialog.getByRole("button", { name: "32-bit Float", exact: true }).click();
  const pending = page.waitForEvent("download"); await exportDialog.getByRole("button", { name: "Render & download WAV", exact: true }).click();
  const download = await pending; expect(await download.failure()).toBeNull(); const path = await download.path(); if (!path) throw new Error("Missing copy export");
  const rendered = decode(await readFile(path)); const originalPCM = decode(fixture(1000, 16));
  const exportGainDb = dbRatio(rendered.left, originalPCM.left);
  expect(rendered.left.length).toBe(originalPCM.left.length); expect(exportGainDb).toBeCloseTo(3, 4);
  const evidence = { processed, source, liveGainDb: processed - source, exportGainDb, heldScrubResumed: true, closedContexts: 2 };
  const evidencePath = info.outputPath("real-library-preview-levels.json"); await writeFile(evidencePath, JSON.stringify(evidence, null, 2));
  await info.attach("real-library-preview-levels", { path: evidencePath, contentType: "application/json" });
  await page.goto("/library");
  await page.reload(); await expect(page.getByRole("link", { name: /independent source copy/u })).toBeVisible();
});

test("missing audio restores exact canonical identity without changing settings or album membership", async ({ page }) => {
  const id = await uploadProject(page, "restore-source.wav", 4);
  await page.getByRole("slider", { name: "Input gain", exact: true }).fill("4");
  await page.goto("/library"); await openActions(page, "restore source"); await page.getByRole("button", { name: "Add to album", exact: true }).click(); await page.getByRole("button", { name: "New album with this project", exact: true }).click();
  const before = (await projects(page))[0]; if (!before?.sourceIdentity) throw new Error("Missing authoritative import identity");
  await evict(page, id); await page.goto(`/master/${id}`); await expect(page.getByText(/The source audio is missing/u)).toBeVisible();
  await page.getByRole("button", { name: "Restore source", exact: true }).click(); await page.getByLabel("Restore audio file").setInputFiles(file("renamed-original.wav", 1000, 4));
  await expect(page.getByRole("dialog")).toHaveCount(0); await expect(page.getByRole("button", { name: "Play", exact: true })).toBeEnabled();
  const after = (await projects(page))[0]; expect(after?.id).toBe(id); expect(after?.advanced).toEqual(before.advanced); expect(after?.sourceIdentity).toEqual(before.sourceIdentity); expect(after?.sourceRevision).toBe(1);
  expect(await page.evaluate((trackId) => (JSON.parse(localStorage.getItem("aurialis-state-v1") ?? "{}") as { albums: { trackIds: string[] }[] }).albums[0]?.trackIds.includes(trackId), id)).toBe(true);
  expect(await audioInfo(page, after?.sourceAudioId ?? id)).not.toBeNull();
});

test("replacement confirmation and failed metadata persistence never pair old identity with new audio after reload", async ({ page }) => {
  const id = await uploadProject(page, "durable-original.wav", 4); const before = (await projects(page))[0]; const oldAudio = await audioInfo(page, id);
  await page.goto("/library"); await openActions(page, "durable original"); await page.getByRole("button", { name: "Restore source", exact: true }).click();
  await page.getByLabel("Restore audio file").setInputFiles(file("different.wav", 500, 4));
  await expect(page.getByText("This audio differs from the original source.", { exact: true })).toBeVisible(); expect((await projects(page))[0]?.sourceIdentity).toEqual(before?.sourceIdentity);
  await page.evaluate(() => { const native = Storage.prototype.setItem; Storage.prototype.setItem = function (key, value) { if (key === "aurialis-state-v1") throw new DOMException("Full", "QuotaExceededError"); native.call(this, key, value); }; });
  await page.getByRole("button", { name: "Replace source", exact: true }).click(); await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByText(/Settings could not be saved by your browser/u)).toBeVisible();
  expect(await audioInfo(page, id)).toEqual(oldAudio);
  await page.reload(); expect((await projects(page))[0]?.sourceIdentity).toEqual(before?.sourceIdentity); expect((await projects(page))[0]?.sourceAudioId).toBeUndefined();
  expect(await audioInfo(page, id)).toEqual(oldAudio);
});

test("populated Library actions, preview and source recovery keep six-width accessibility and touch targets", async ({ page }, info) => {
  test.setTimeout(120_000);
  await uploadProject(page, "accessible-library.wav", 4); await page.goto("/library");
  for (const width of [320, 375, 390, 768, 1024, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    if (width === 320 || width === 1440) await page.screenshot({ path: info.outputPath(`library-populated-${String(width)}.png`), fullPage: true });
    await openActions(page, "accessible library");
    for (const button of await page.getByRole("dialog").getByRole("button").all()) { const box = await button.boundingBox(); expect(box?.width).toBeGreaterThanOrEqual(44); expect(box?.height).toBeGreaterThanOrEqual(44); }
    let report = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze(); expect(report.violations).toEqual([]);
    if (width === 320 || width === 1440) await page.screenshot({ path: info.outputPath(`library-actions-${String(width)}.png`), fullPage: true });
    await page.getByRole("button", { name: "Restore source", exact: true }).click();
    if (width === 320 || width === 1440) await page.screenshot({ path: info.outputPath(`library-restore-${String(width)}.png`), fullPage: true });
    report = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze(); expect(report.violations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.keyboard.press("Escape");
    await openActions(page, "accessible library"); await page.getByRole("button", { name: "Preview accessible library", exact: true }).click();
    await expect(page.getByRole("dialog").getByRole("button", { name: "Play", exact: true })).toBeEnabled();
    for (const target of await page.getByRole("dialog").locator("button, input[type=range]").all()) { const box = await target.boundingBox(); expect(box?.width).toBeGreaterThanOrEqual(44); expect(box?.height).toBeGreaterThanOrEqual(44); }
    report = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze(); expect(report.violations).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true); await page.keyboard.press("Escape");
  }
});


test("cancel after a durable staged write removes only the new asset and preserves the original project", async ({ page }) => {
  const id = await uploadProject(page, "cancel-original.wav", 4); const oldAudio = await audioInfo(page, id);
  await page.goto("/library"); await openActions(page, "cancel original"); const before = (await projects(page))[0]; await page.getByRole("button", { name: "Restore source", exact: true }).click();
  await page.evaluate(() => {
    type HeldWindow = Window & { heldWrite?: { key: string; release: () => void }; stagedKey?: string };
    const nativeTransaction = IDBDatabase.prototype.transaction; const nativeAdd = IDBObjectStore.prototype.add; let hold = true;
    IDBObjectStore.prototype.add = function (value, key) { (window as HeldWindow).stagedKey = String(key); return nativeAdd.call(this, value, key); };
    IDBDatabase.prototype.transaction = function (...args: Parameters<IDBDatabase["transaction"]>) {
      const transaction = nativeTransaction.apply(this, args);
      if (args[1] === "readwrite" && hold) Object.defineProperty(transaction, "oncomplete", { set(handler: (event: Event) => void) { transaction.addEventListener("complete", (event) => { hold = false; (window as HeldWindow).heldWrite = { key: (window as HeldWindow).stagedKey ?? "", release: () => { handler.call(transaction, event); } }; }, { once: true }); } });
      return transaction;
    };
  });
  await page.getByLabel("Restore audio file").setInputFiles(file("same-source.wav", 1000, 4));
  await expect.poll(() => page.evaluate(() => (window as Window & { heldWrite?: { key: string } }).heldWrite?.key)).toMatch(/^source-/u);
  const staged = await page.evaluate(() => (window as Window & { heldWrite?: { key: string } }).heldWrite?.key ?? "");
  expect(await audioInfo(page, staged)).toEqual(oldAudio);
  await page.getByRole("button", { name: "Cancel restore", exact: true }).click(); await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.evaluate(() => { (window as Window & { heldWrite?: { release: () => void } }).heldWrite?.release(); });
  await expect.poll(() => audioInfo(page, staged)).toBeNull(); expect((await projects(page))[0]).toEqual(before); expect(await audioInfo(page, id)).toEqual(oldAudio);
});

test("leaving a pending import queue retains completed projects and cancels the pending job without late navigation", async ({ page }) => {
  await page.goto("/"); let calls = 0; let release: (() => void) | undefined; let intercepted = false;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/api/master/render", async (route) => { calls += 1; if (calls === 2) { intercepted = true; await pending; } await route.continue().catch(() => undefined); });
  await page.getByLabel("Import audio file").setInputFiles([file("retained.wav"), file("pending.wav", 500)]);
  await expect.poll(() => intercepted).toBe(true); expect((await projects(page)).map((track) => track.title)).toEqual(["retained"]);
  await page.getByRole("link", { name: "Library", exact: true }).first().click();
  await expect(page).toHaveURL(/\/library$/u); release?.();
  await expect(page.getByRole("link", { name: /retained 0:/u })).toBeVisible(); await page.waitForTimeout(250);
  expect((await projects(page)).map((track) => track.title)).toEqual(["retained"]); await expect(page).toHaveURL(/\/library$/u);
});

test("editable paste and native history preserve denied-storage audio through Library, Back, Forward and export until reload", async ({ page }, info) => {
  test.setTimeout(90_000);
  await observeOutput(page);
  await page.addInitScript(() => { Object.defineProperty(window, "indexedDB", { configurable: true, value: { open: () => { throw new DOMException("Denied", "SecurityError"); } } }); });
  await page.goto("/"); const origin = await page.evaluate(() => performance.timeOrigin); let imports = 0; page.on("request", (request) => { if (request.url().endsWith("/api/master/render")) imports += 1; });
  await page.evaluate((bytes) => {
    const editable = document.createElement("div"); editable.contentEditable = "true"; document.body.append(editable); editable.focus();
    const clipboard = new DataTransfer(); clipboard.items.add(new File([new Uint8Array(bytes)], "editable.wav", { type: "audio/wav" }));
    editable.dispatchEvent(new ClipboardEvent("paste", { clipboardData: clipboard, bubbles: true })); editable.remove();
  }, Array.from(fixture()));
  await expect(page.getByRole("region", { name: "Bring in a track: drop audio or choose a file", exact: true })).toHaveAttribute("aria-busy", "false"); expect(imports).toBe(0);
  await page.getByLabel("Import audio file").setInputFiles(file("session-only.wav", 1000, 8));
  await expect(page).toHaveURL(/\/master\/track-/u); const masterURL = page.url();
  await expect(page.getByText(/Audio is available only in this tab/u)).toBeVisible(); await expect(page.getByRole("button", { name: "Play", exact: true })).toBeEnabled();
  await expect(page.getByRole("heading", { name: "session only", exact: true })).toBeFocused(); await expect(page).toHaveTitle("session only — Aurialis");
  await page.getByRole("slider", { name: "Input gain", exact: true }).fill("3"); await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect.poll(async () => (await outputLevel(page))?.rmsDbfs ?? -Infinity).toBeGreaterThan(-17);
  const firstGeneration = (await outputLevel(page))?.generation;
  await page.getByRole("link", { name: "Library", exact: true }).first().click(); await expect(page).toHaveURL(/\/library$/u);
  await expect(page.getByRole("heading", { name: "Library", exact: true })).toBeFocused(); await expect(page).toHaveTitle("Library — Aurialis"); expect(await page.evaluate(() => scrollY)).toBe(0);
  const stopped = (await outputLevel(page))?.frames; await page.waitForTimeout(200); expect((await outputLevel(page))?.frames).toBe(stopped);
  await page.getByRole("link", { name: /session only 0:/u }).click(); await expect(page).toHaveURL(masterURL); await expect(page.getByRole("button", { name: "Play", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Play", exact: true }).click(); await expect.poll(async () => (await outputLevel(page))?.generation).toBe((firstGeneration ?? 0) + 1);
  await page.goBack(); await expect(page).toHaveURL(/\/library$/u); await expect(page.getByRole("heading", { name: "Library", exact: true })).toBeFocused();
  await page.goForward(); await expect(page).toHaveURL(masterURL); await expect(page.getByRole("button", { name: "Play", exact: true })).toBeEnabled();
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(origin);
  await page.getByRole("button", { name: "Export", exact: true }).click(); const dialog = page.getByRole("dialog"); await dialog.getByRole("button", { name: "32-bit Float", exact: true }).click();
  const pending = page.waitForEvent("download"); await dialog.getByRole("button", { name: "Render & download WAV", exact: true }).click(); const download = await pending; expect(await download.failure()).toBeNull(); const path = await download.path(); if (!path) throw new Error("Missing session export");
  const gainDb = dbRatio(decode(await readFile(path)).left, decode(fixture(1000, 8)).left); expect(gainDb).toBeCloseTo(3, 4);
  await info.attach("session-native-history-export", { body: JSON.stringify({ origin, currentOrigin: await page.evaluate(() => performance.timeOrigin), gainDb }), contentType: "application/json" });
  await page.reload(); await expect(page).toHaveURL(masterURL); await expect(page.getByText(/The source audio is missing/u)).toBeVisible(); await expect(page.getByRole("button", { name: "Restore source", exact: true })).toBeVisible();
});

test("failed durable deletion keeps project metadata and source available for retry", async ({ page }) => {
  const id = await uploadProject(page, "delete-retry.wav"); const oldAudio = await audioInfo(page, id); await page.goto("/library");
  await page.evaluate(() => { const native = IDBObjectStore.prototype.delete; let fail = true; IDBObjectStore.prototype.delete = function (key) { if (fail) { fail = false; throw new DOMException("Deletion denied", "SecurityError"); } return native.call(this, key); }; });
  await openActions(page, "delete retry"); await page.getByRole("button", { name: "Delete delete retry", exact: true }).click(); await page.getByRole("button", { name: "Delete project", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toHaveText("Deletion denied"); expect((await projects(page))[0]?.id).toBe(id); expect(await audioInfo(page, id)).toEqual(oldAudio);
  await page.getByRole("button", { name: "Delete project", exact: true }).click(); await expect(page.getByRole("dialog")).toHaveCount(0); expect(await projects(page)).toEqual([]); expect(await audioInfo(page, id)).toBeNull();
});
