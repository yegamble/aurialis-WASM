// cspell:words spinbutton
import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import type { Track } from "../src/lib/types";
import { fixture } from "./audio-fixture";
import { meanOutputLevel, observeOutput, outputLevel } from "./live-output";
import { uploadProject } from "./workflow-fixture";
async function project(page: Page): Promise<Track> { const track = await page.evaluate(() => (JSON.parse(localStorage.getItem("aurialis-state-v1") ?? "{}") as { tracks: Track[] }).tracks[0]); if (!track) throw new Error("Missing project"); return track; }
async function propose(page: Page, seconds = 6) { await uploadProject(page, "deep-recovery.wav", seconds); await page.getByRole("tab", { name: "deep", exact: true }).click(); await page.getByRole("button", { name: "Analyze Deep proposal", exact: true }).click(); await expect(page.getByText("Measured proposal ready. Your applied processing has not changed.", { exact: true })).toBeVisible({ timeout: 30000 }); }
async function apply(page: Page) { const before = (await project(page)).deepMastering?.applied?.revision ?? 0; await page.getByRole("button", { name: "Apply Deep proposal", exact: true }).click(); await expect.poll(async () => (await project(page)).deepMastering?.applied?.revision ?? 0).toBeGreaterThan(before); }

test("a late commit ACK after a newer baseline edit pauses the uncertain graph and cannot install a stale script", async ({ page }) => {
  await observeOutput(page);
  await page.addInitScript(() => {
    type HeldWindow = Window & { deepAckHeld?: boolean; releaseDeepAck?: () => void };
    const Native = AudioWorkletNode, descriptor = Object.getOwnPropertyDescriptor(MessagePort.prototype, "onmessage");
    window.AudioWorkletNode = class extends Native { constructor(context: BaseAudioContext, name: string, options?: AudioWorkletNodeOptions) { super(context, name, options); const port = this.port; let listener: ((event: MessageEvent<unknown>) => void) | null = null; const held: MessageEvent<unknown>[] = [];
      Object.defineProperty(port, "onmessage", { configurable: true, get: () => listener, set: (value: ((event: MessageEvent<unknown>) => void) | null) => { listener = value; descriptor?.set?.call(port, (event: MessageEvent<unknown>) => { const data = event.data; if (typeof data === "object" && data !== null && "type" in data && data.type === "automation-ack" && "revision" in data && typeof data.revision === "number" && data.revision > 0) { held.push(event); (window as HeldWindow).deepAckHeld = true; } else listener?.(event); }); } });
      (window as HeldWindow).releaseDeepAck = () => { for (const event of held.splice(0)) listener?.(event); };
    } };
  });
  await propose(page, 8); await page.getByRole("button", { name: "Apply Deep proposal", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as Window & { deepAckHeld?: boolean }).deepAckHeld)).toBe(true);
  await page.getByRole("tab", { name: "advanced", exact: true }).click(); await page.getByRole("slider", { name: "Input gain", exact: true }).fill("3");
  await expect(page.getByText(/Processing changed during commit acknowledgment/u)).toBeVisible();
  expect((await project(page)).deepMastering?.applied).toBeUndefined(); expect((await project(page)).advanced.input).toBe(3);
  await page.evaluate(() => { (window as Window & { releaseDeepAck?: () => void }).releaseDeepAck?.(); });
  await page.waitForTimeout(50); expect((await project(page)).deepMastering?.applied).toBeUndefined();
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect.poll(async () => (await outputLevel(page))?.rmsDbfs ?? -Infinity).toBeGreaterThan(-30);
  expect(await meanOutputLevel(page)).toBeCloseTo(-16.03, 1);
});

test("rejected numeric staging keeps the prior live revision and can be retried without compounding", async ({ page }) => {
  test.setTimeout(60000); await observeOutput(page); await propose(page, 20); await apply(page); const previous = (await project(page)).deepMastering?.applied;
  await page.getByRole("button", { name: "Repeat track", exact: true }).click(); await page.getByRole("button", { name: "Play", exact: true }).click(); await expect.poll(async () => (await outputLevel(page))?.rmsDbfs ?? -Infinity).toBeGreaterThan(-40); const before = await meanOutputLevel(page);
  await page.getByRole("combobox", { name: "New move target", exact: true }).selectOption("inputGainDb"); await page.getByRole("button", { name: "Add baseline move", exact: true }).click();
  await page.getByRole("spinbutton", { name: "Point 1 value", exact: true }).fill("2"); await page.getByRole("spinbutton", { name: "Point 1 value", exact: true }).blur();
  await page.getByRole("button", { name: "Close move editor", exact: true }).click();
  await page.route("**/api/automation/compile?*", async (route) => { const response = await route.fetch(); const packet = await response.json() as { moves: { points: { value: number }[] }[] }; const point = packet.moves[0]?.points[0]; if (!point) throw new Error("Missing staged move"); point.value = 10000; await route.fulfill({ response, json: packet }); });
  await page.getByRole("button", { name: "Apply Deep proposal", exact: true }).click(); await expect(page.getByRole("alert").filter({ hasText: "rejected an automation move" }).first()).toBeVisible();
  expect((await project(page)).deepMastering?.applied).toEqual(previous); await expect(page.getByLabel("Playback transport")).toHaveAttribute("data-playing", "true"); const after = await meanOutputLevel(page); expect(Math.abs(after - before)).toBeLessThan(.01);
  await page.unroute("**/api/automation/compile?*"); await apply(page); expect((await project(page)).deepMastering?.before).toBeDefined();
});

test("a replaced IDB blob cannot bind a saved script and exact source restore recovers playback", async ({ page }) => {
  await observeOutput(page); await propose(page, 6); await apply(page); const track = await project(page);
  await page.evaluate(async (key) => {
    const db = await new Promise<IDBDatabase>((resolve) => { const request = indexedDB.open("aurialis-local", 2); request.onsuccess = () => resolve(request.result); });
    const blob = await new Promise<Blob>((resolve) => { const request = db.transaction("audio").objectStore("audio").get(key); request.onsuccess = () => resolve(request.result as Blob); });
    const bytes = await blob.arrayBuffer(), view = new DataView(bytes); view.setFloat32(44, .1234, true);
    await new Promise<void>((resolve, reject) => { const transaction = db.transaction("audio", "readwrite"); transaction.objectStore("audio").put(new Blob([bytes], { type: "audio/wav" }), key); transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error); }); db.close();
  }, track.sourceAudioId ?? track.id);
  await page.reload(); await expect(page.getByRole("button", { name: "Play", exact: true })).toBeEnabled(); await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(page.getByText(/stored PCM differs from this script's source/u)).toBeVisible(); await expect(page.getByLabel("Playback transport")).toHaveAttribute("data-playing", "false");
  await page.getByRole("button", { name: "Restore source", exact: true }).click(); await page.getByLabel("Restore audio file").setInputFiles({ name: "deep-recovery.wav", mimeType: "audio/wav", buffer: fixture(1000, 6) });
  await expect.poll(async () => (await project(page)).sourceRevision ?? 0).toBeGreaterThan(track.sourceRevision ?? 0);
  await page.getByRole("button", { name: "Play", exact: true }).click(); await expect.poll(async () => (await outputLevel(page))?.rmsDbfs ?? -Infinity).toBeGreaterThan(-40); expect((await project(page)).deepMastering?.applied).toEqual(track.deepMastering?.applied);
});

test("draft persistence failure retains the saved applied record and downloads both complete recovery scripts", async ({ page }) => {
  await propose(page, 3); await apply(page); const old = await project(page), saved = await page.evaluate(() => localStorage.getItem("aurialis-state-v1"));
  await page.evaluate(() => { const native = Storage.prototype.setItem; Storage.prototype.setItem = function (key: string, value: string) { if (key === "aurialis-state-v1") throw new DOMException("Quota exceeded", "QuotaExceededError"); native.call(this, key, value); }; });
  await page.getByRole("combobox", { name: "New move target", exact: true }).selectOption("stereo.widthPct"); await page.getByRole("button", { name: "Add baseline move", exact: true }).click();
  await expect(page.getByText("Settings could not be saved by your browser. Keep this tab open and export before leaving.", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("aurialis-state-v1"))).toBe(saved);
  const draftEvent = page.waitForEvent("download"); await page.getByRole("button", { name: "Download draft Script JSON", exact: true }).click(); const draftPath = await (await draftEvent).path(); if (!draftPath) throw new Error("Missing draft recovery"); const draft = JSON.parse(await readFile(draftPath, "utf8")) as { revision: number; moves: unknown[] }; expect(draft.revision).toBe((old.deepMastering?.proposal.revision ?? 0) + 1); expect(draft.moves.length).toBe((old.deepMastering?.proposal.moves.length ?? 0) + 1);
  const appliedEvent = page.waitForEvent("download"); await page.getByRole("button", { name: "Download applied Script JSON", exact: true }).click(); const appliedPath = await (await appliedEvent).path(); if (!appliedPath) throw new Error("Missing applied recovery"); expect(JSON.parse(await readFile(appliedPath, "utf8"))).toEqual(old.deepMastering?.applied);
  await page.reload(); await expect(page.getByRole("button", { name: "Apply Deep proposal", exact: true })).toBeEnabled(); expect((await project(page)).deepMastering).toEqual(old.deepMastering);
});
