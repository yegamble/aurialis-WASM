// cspell:words networkidle
import { expect, test, type BrowserContext, type Page, type TestInfo } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { clampAdvancedToSampleRate, createDefaultAdvancedParams } from "../src/lib/audio-dsp";
import type { Track } from "../src/lib/types";
import { fixture } from "./audio-fixture";

type Execution = "native" | "browser";
type Source = { key: string; name: string; bytes: number[] };
type HeldWindow = Window & {
  legacyReads?: string[];
  observeLegacyReads?: boolean;
  legacyExecuted?: boolean;
  heldCanonicalWrite?: { key: string; release: () => void };
  heldLegacyFile?: { release: () => void };
};
const longName = `00-${"unbroken".repeat(21)}.wav`;
const plain = fixture(1000, 1 / 32);
const clean = Buffer.concat([plain.subarray(0, 36), Buffer.from("JUNK\x08\0\0\0METADATA", "binary"), plain.subarray(36)]);
clean.writeUInt32LE(clean.length - 8, 4);
const hostile = Buffer.concat([plain, Buffer.from("PK\x03\x04synthetic-hidden-payload", "binary")]);
function source(name: string, bytes: Buffer): Source {
  return { key: `${name}|${String(bytes.length)}|1700000000000`, name, bytes: Array.from(bytes) };
}
const selected = source(longName, clean);
const compressed = source("01-retained-compressed.mp3", Buffer.from("ID3synthetic-unsupported-original"));
const poisoned = source("02-hostile.wav", hostile);
function sources(paged = false): Source[] {
  return [selected, compressed, poisoned, ...(paged ? Array.from({ length: 30 }, (_, index) => source(`10-spare-${String(index).padStart(2, "0")}.wav`, plain)) : [])];
}
function canonical(): Buffer {
  const frames = plain.readUInt32LE(40) / 4;
  const wav = Buffer.alloc(44 + frames * 8);
  plain.copy(wav, 0, 0, 44);
  wav.writeUInt32LE(wav.length - 8, 4); wav.writeUInt16LE(3, 20);
  wav.writeUInt32LE(48000 * 8, 28); wav.writeUInt16LE(8, 32); wav.writeUInt16LE(32, 34); wav.writeUInt32LE(frames * 8, 40);
  for (let index = 0; index < frames * 2; index++) wav.writeFloatLE(plain.readInt16LE(44 + index * 2) / 32768, 44 + index * 4);
  return wav;
}
async function seed(page: Page, originals: Source[]) {
  await page.goto("/library");
  await expect(page.getByRole("button", { name: "Find old projects", exact: true })).toBeEnabled();
  await page.evaluate(async (items) => {
    const open = (name: string) => new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, 1);
      request.onupgradeneeded = () => { request.result.createObjectStore("kv"); };
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    for (const name of ["aurialis-library-entries-v1", "aurialis-library-prefs-v1"]) {
      const database = await open(name);
      try {
        await new Promise<void>((resolve, reject) => {
          const transaction = database.transaction("kv", "readwrite");
          for (const item of items) transaction.objectStore("kv").put({
            fileName: "metadata-must-not-name-the-project.wav", settings: { inputGainDb: 24 },
            script: "globalThis.legacyExecuted = true", html: '<img src="/old-metadata-must-not-run" onerror="globalThis.legacyExecuted=true">',
            fingerprint: item.key, corruptScript: "{unclosed", nested: { kept: [1, null, "original"] },
          }, item.key);
          transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error);
        });
      } finally { database.close(); }
    }
    localStorage.setItem("aurialis-settings-v1", '{"inputGainDb":24,"script":"globalThis.legacyExecuted=true"}');
    const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle("library", { create: true });
    for (const item of items) {
      const handle = await directory.getFileHandle(`${encodeURIComponent(item.key)}.bin`, { create: true });
      const writer = await handle.createWritable(); await writer.write(new Uint8Array(item.bytes)); await writer.close();
    }
    const state = window as HeldWindow;
    state.legacyReads = []; state.observeLegacyReads = true;
    const get = IDBObjectStore.prototype.get, getAll = IDBObjectStore.prototype.getAll, cursor = IDBObjectStore.prototype.openCursor;
    function record(store: IDBObjectStore, operation: string) {
      if (state.observeLegacyReads && store.transaction.db.name.startsWith("aurialis-library-")) state.legacyReads?.push(operation);
    }
    IDBObjectStore.prototype.get = function (...args) { record(this, "get"); return get.apply(this, args); };
    IDBObjectStore.prototype.getAll = function (...args) { record(this, "getAll"); return getAll.apply(this, args); };
    IDBObjectStore.prototype.openCursor = function (...args) { record(this, "openCursor"); return cursor.apply(this, args); };
  }, originals);
}
async function oldSnapshot(page: Page) {
  return page.evaluate(async () => {
    const state = window as HeldWindow, observing = state.observeLegacyReads;
    state.observeLegacyReads = false;
    try {
      const databases: { name: string; keys: IDBValidKey[]; values: unknown[] }[] = [];
      for (const name of ["aurialis-library-entries-v1", "aurialis-library-prefs-v1"]) {
        const database = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open(name); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
        try {
          const transaction = database.transaction("kv", "readonly"), store = transaction.objectStore("kv");
          const keys = store.getAllKeys(), values = store.getAll();
          databases.push(await new Promise((resolve, reject) => {
            transaction.oncomplete = () => resolve({ name, keys: keys.result, values: values.result as unknown[] }); transaction.onerror = () => reject(transaction.error);
          }));
        } finally { database.close(); }
      }
      const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle("library");
      const files: { name: string; bytes: number[]; modified: number }[] = [];
      const entries = directory as FileSystemDirectoryHandle & { entries(): AsyncIterableIterator<[string, FileSystemHandle]> };
      for await (const [name, handle] of entries.entries()) {
        if (handle.kind !== "file") throw new Error("Unexpected synthetic old-library subdirectory");
        const file = await (handle as FileSystemFileHandle).getFile();
        files.push({ name, bytes: Array.from(new Uint8Array(await file.arrayBuffer())), modified: file.lastModified });
      }
      files.sort((left, right) => left.name.localeCompare(right.name));
      return { databases, files, settings: localStorage.getItem("aurialis-settings-v1") };
    } finally { state.observeLegacyReads = observing ?? false; }
  });
}
async function current(page: Page) {
  return page.evaluate(async () => {
    const tracks = (JSON.parse(localStorage.getItem("aurialis-state-v1") ?? "{}") as { tracks?: Track[] }).tracks ?? [];
    if (!(await indexedDB.databases()).some((entry) => entry.name === "aurialis-local")) return { tracks, audio: [] };
    const database = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open("aurialis-local", 2); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    try {
      const transaction = database.transaction("audio", "readonly"), store = transaction.objectStore("audio");
      const keys = store.getAllKeys(), blobs = store.getAll();
      const saved = await new Promise<{ keys: IDBValidKey[]; blobs: Blob[] }>((resolve, reject) => {
        transaction.oncomplete = () => resolve({ keys: keys.result, blobs: blobs.result as Blob[] }); transaction.onerror = () => reject(transaction.error);
      });
      return { tracks, audio: await Promise.all(saved.blobs.map(async (blob, index) => ({ key: String(saved.keys[index]), bytes: Array.from(new Uint8Array(await blob.arrayBuffer())) }))) };
    } finally { database.close(); }
  });
}
async function assertNoOldExecution(page: Page) {
  expect(await page.evaluate(() => ({ reads: (window as HeldWindow).legacyReads ?? [], executed: (window as HeldWindow).legacyExecuted ?? false }))).toEqual({ reads: [], executed: false });
}
async function scan(page: Page) {
  await page.getByRole("button", { name: "Find old projects", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Recover old local sources", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: `Recover WAV: ${longName}`, exact: true })).toBeEnabled();
}
async function boundary(context: BrowserContext, page: Page, info: TestInfo, execution: Execution, action: () => Promise<void>) {
  const requests: { method: string; url: string; bodyBytes: number }[] = [];
  const downloads: string[] = [];
  const downloaded = (download: import("@playwright/test").Download) => { downloads.push(download.suggestedFilename()); };
  const record = (request: import("@playwright/test").Request) => { requests.push({ method: request.method(), url: request.url(), bodyBytes: request.postDataBuffer()?.length ?? 0 }); };
  context.on("request", record); page.on("download", downloaded);
  try { await action(); await page.waitForLoadState("networkidle"); }
  finally {
    context.off("request", record); page.off("download", downloaded);
    const origin = new URL(String(info.project.use.baseURL)).origin;
    const forbidden = requests.filter((request) => {
      const url = new URL(request.url);
      return !["GET", "HEAD"].includes(request.method) || request.bodyBytes !== 0 || url.origin !== origin || /^\/(?:api|jobs)(?:\/|$)/u.test(url.pathname) || url.pathname === "/health";
    });
    const path = info.outputPath("legacy-network-inventory.json");
    await writeFile(path, JSON.stringify({ execution, origin, requests, downloads, forbidden: execution === "browser" ? forbidden : [] }, null, 2));
    await info.attach("legacy-network-inventory", { path, contentType: "application/json" });
    expect(downloads).toEqual([]);
    if (execution === "browser") { expect(requests.length).toBeGreaterThan(0); expect(forbidden).toEqual([]); }
  }
}

export function registerLegacyRecoveryCases(execution: Execution) {
  test.describe("old local library recovery", () => {
    test("explicit key pages preserve every original and recover only selected clean PCM with default settings", async ({ page, context }, info) => {
      await boundary(context, page, info, execution, async () => {
        await seed(page, sources(true)); const before = await oldSnapshot(page);
        expect((await current(page)).tracks).toEqual([]); await assertNoOldExecution(page);
        for (const width of [320, 375, 390, 768, 1024, 1440]) {
          await page.setViewportSize({ width, height: 1000 });
          const trigger = page.getByRole("button", { name: "Find old projects", exact: true });
          await trigger.focus(); await page.keyboard.press("Enter");
          const dialog = page.getByRole("dialog", { name: "Recover old local sources", exact: true });
          await expect(dialog.getByRole("button", { name: `Recover WAV: ${longName}`, exact: true })).toBeEnabled();
          await expect(dialog.getByRole("list", { name: "Old source files", exact: true }).getByRole("listitem")).toHaveCount(32);
          for (const button of await dialog.getByRole("button").all()) { const box = await button.boundingBox(); expect(box?.width).toBeGreaterThanOrEqual(44); expect(box?.height).toBeGreaterThanOrEqual(44); }
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
          expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);
          await page.keyboard.press("Tab"); expect(await dialog.evaluate((element) => element.contains(document.activeElement))).toBe(true);
          if (width === 320 || width === 1440) await page.screenshot({ path: info.outputPath(`legacy-recovery-${String(width)}.png`), fullPage: true });
          await dialog.getByRole("button", { name: "Next source keys", exact: true }).focus(); await page.keyboard.press("Enter");
          await expect(dialog.getByRole("list", { name: "Old source files", exact: true }).getByRole("listitem")).toHaveCount(1);
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
          expect((await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze()).violations).toEqual([]);
          await page.keyboard.press("Escape"); await expect(dialog).toHaveCount(0); await expect(trigger).toBeFocused();
        }
        await scan(page); await page.getByRole("button", { name: `Recover WAV: ${longName}`, exact: true }).click();
        await expect(page.getByRole("button", { name: `Recover WAV: ${longName}`, exact: true })).toBeDisabled();
        await expect.poll(async () => (await current(page)).tracks.length).toBe(1);
        const after = await current(page), track = after.tracks[0]; if (!track) throw new Error("Missing reconstructed recovery project");
        const expected = canonical(), prefix = Buffer.alloc(16); prefix.writeUInt32LE(48000); prefix.writeUInt32LE(2, 4); prefix.writeBigUInt64LE(BigInt((expected.length - 44) / 8), 8);
        expect(after.audio).toEqual([{ key: track.id, bytes: Array.from(expected) }]);
        expect(track.advanced).toEqual(clampAdvancedToSampleRate(createDefaultAdvancedParams(), 48000));
        expect(track).toMatchObject({ source: "upload", sourceRevision: 0, mode: "advanced", profile: "modern_pop_polish", sampleRate: 48000, format: "WAV", filename: longName,
          sourceIdentity: { sampleRate: 48000, frames: (expected.length - 44) / 8, pcmHash: createHash("sha256").update(prefix).update(expected.subarray(44)).digest("hex") } });
        expect(track).not.toHaveProperty("deepMastering"); expect(track).not.toHaveProperty("script");
        expect(await oldSnapshot(page)).toEqual(before); await assertNoOldExecution(page);
        const wavPath = info.outputPath("recovered-canonical.wav"), evidencePath = info.outputPath("legacy-preservation.json");
        await writeFile(wavPath, Buffer.from(after.audio[0]?.bytes ?? []));
        await writeFile(evidencePath, JSON.stringify({ track, oldRecordCount: before.databases.map((database) => ({ database: database.name, records: database.keys.length })),
          originalFilesRetained: before.files.length, canonicalSha256: createHash("sha256").update(expected).digest("hex"), exactOldValuesAndOriginalBytes: true }, null, 2));
        await info.attach("recovered-canonical", { path: wavPath, contentType: "audio/wav" });
        await info.attach("legacy-preservation", { path: evidencePath, contentType: "application/json" });
        await page.keyboard.press("Escape"); await page.reload();
        expect((await current(page)).audio).toEqual(after.audio); expect(await oldSnapshot(page)).toEqual(before);
        await expect(page.getByRole("dialog")).toHaveCount(0);
      });
    });

    test("unsupported compressed and hostile RIFF originals stay unchanged across rejection and reload", async ({ page, context }, info) => {
      await boundary(context, page, info, execution, async () => {
        await seed(page, sources()); const before = await oldSnapshot(page); await scan(page);
        await page.getByRole("button", { name: `Recover WAV: ${compressed.name}`, exact: true }).click();
        await expect(page.getByRole("alert")).toContainText("Codec recovery is unavailable");
        expect(await current(page)).toEqual({ tracks: [], audio: [] }); expect(await oldSnapshot(page)).toEqual(before);
        await page.getByRole("button", { name: `Recover WAV: ${poisoned.name}`, exact: true }).click();
        await expect(page.getByRole("alert")).toContainText(/polyglot|payload|container|trailing/iu);
        expect(await current(page)).toEqual({ tracks: [], audio: [] }); expect(await oldSnapshot(page)).toEqual(before); await assertNoOldExecution(page);
        await page.reload(); await scan(page);
        await expect(page.getByRole("button", { name: `Recover WAV: ${compressed.name}`, exact: true })).toBeEnabled();
        expect(await current(page)).toEqual({ tracks: [], audio: [] }); expect(await oldSnapshot(page)).toEqual(before);
      });
    });

    test("cancel after real reconstructed audio staging removes only the new canonical asset", async ({ page, context }, info) => {
      await boundary(context, page, info, execution, async () => {
        await seed(page, sources()); const before = await oldSnapshot(page); await scan(page);
        await page.evaluate(() => {
          const nativeTransaction = IDBDatabase.prototype.transaction, nativeAdd = IDBObjectStore.prototype.add;
          let armed = true, key = "";
          IDBObjectStore.prototype.add = function (value, id) { if (this.transaction.db.name === "aurialis-local" && this.name === "audio") key = String(id); return nativeAdd.call(this, value, id); };
          IDBDatabase.prototype.transaction = function (...args) {
            const transaction = nativeTransaction.apply(this, args);
            if (this.name === "aurialis-local" && args[1] === "readwrite" && armed) {
              armed = false;
              Object.defineProperty(transaction, "oncomplete", { set(handler: (event: Event) => void) { transaction.addEventListener("complete", (event) => {
                (window as HeldWindow).heldCanonicalWrite = { key, release: () => { handler.call(transaction, event); } };
              }, { once: true }); } });
            }
            return transaction;
          };
        });
        await page.getByRole("button", { name: `Recover WAV: ${longName}`, exact: true }).click();
        await expect.poll(() => page.evaluate(() => (window as HeldWindow).heldCanonicalWrite?.key ?? "")).toMatch(/^track-/u);
        const pending = await current(page); expect(pending.tracks).toEqual([]); expect(pending.audio.map((audio) => audio.bytes)).toEqual([Array.from(canonical())]);
        await page.getByRole("button", { name: "Cancel recovery", exact: true }).click();
        await page.evaluate(() => { (window as HeldWindow).heldCanonicalWrite?.release(); });
        await expect.poll(() => current(page)).toEqual({ tracks: [], audio: [] });
        await expect(page.getByRole("button", { name: "Close", exact: true })).toBeEnabled();
        expect(await oldSnapshot(page)).toEqual(before); await assertNoOldExecution(page);
        await page.reload(); expect(await oldSnapshot(page)).toEqual(before); expect(await current(page)).toEqual({ tracks: [], audio: [] });
      });
    });

    test("an external old-file change during verification cannot publish a stale recovery project", async ({ page, context }, info) => {
      await boundary(context, page, info, execution, async () => {
        await seed(page, sources()); const before = await oldSnapshot(page); await scan(page);
        await page.evaluate((filename) => {
          const native = FileSystemFileHandle.prototype.getFile; let reads = 0;
          FileSystemFileHandle.prototype.getFile = async function () {
            if (this.name === filename && ++reads === 2) await new Promise<void>((resolve) => { (window as HeldWindow).heldLegacyFile = { release: resolve }; });
            return native.call(this);
          };
        }, `${encodeURIComponent(selected.key)}.bin`);
        await page.getByRole("button", { name: `Recover WAV: ${longName}`, exact: true }).click();
        await expect.poll(() => page.evaluate(() => !!(window as HeldWindow).heldLegacyFile)).toBe(true);
        await page.evaluate(async ({ key, bytes }) => {
          const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle("library");
          const handle = await directory.getFileHandle(`${encodeURIComponent(key)}.bin`), writer = await handle.createWritable();
          await writer.write(new Uint8Array([...bytes, 0])); await writer.close();
        }, selected);
        const externallyChanged = await oldSnapshot(page);
        expect(externallyChanged.databases).toEqual(before.databases); expect(externallyChanged.settings).toBe(before.settings);
        const changedName = `${encodeURIComponent(selected.key)}.bin`;
        expect(externallyChanged.files.filter((file) => file.name !== changedName)).toEqual(before.files.filter((file) => file.name !== changedName));
        expect(externallyChanged.files.find((file) => file.name === changedName)?.bytes).toEqual([...selected.bytes, 0]);
        await page.evaluate(() => { (window as HeldWindow).heldLegacyFile?.release(); });
        await expect(page.getByRole("alert")).toContainText("changed during recovery");
        expect(await current(page)).toEqual({ tracks: [], audio: [] }); expect(await oldSnapshot(page)).toEqual(externallyChanged); await assertNoOldExecution(page);
        await page.reload(); expect(await current(page)).toEqual({ tracks: [], audio: [] }); expect(await oldSnapshot(page)).toEqual(externallyChanged);
      });
    });
  });
}
