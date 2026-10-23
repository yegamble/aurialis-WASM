import { afterEach, describe, expect, it, vi } from "vitest";
import { indexedDB as testIndexedDB } from "fake-indexeddb";
import { Blob as NativeBlob } from "node:buffer";
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });
describe("bounded audio persistence", () => {
  it("retains readable session audio when durable storage is denied and explicitly deletes it", async () => {
    vi.stubGlobal("indexedDB", { open: () => { throw new DOMException("Denied", "SecurityError"); } });
    const db = await import("../db"); const blob = new Blob(["source"]); const id = db.newAudioAssetId("source");
    expect(await db.saveAudio(id, blob)).toMatchObject({ durable: false });
    expect(await db.getAudio(id)).toBe(blob);
    await db.deleteAudio(id); expect(await db.getAudio(id)).toBeUndefined();
  });
  it("rejects a source without storage when the aggregate session budget is exhausted", async () => {
    vi.stubGlobal("indexedDB", { open: () => { throw new DOMException("Full", "QuotaExceededError"); } });
    const db = await import("../db"); const first = db.newAudioAssetId("source"); const second = db.newAudioAssetId("source"); const full = new Blob(["bounded source"]); Object.defineProperty(full, "size", { value: 128 * 1024 * 1024 + 44 });
    await db.saveAudio(first, full); await expect(db.saveAudio(second, new Blob(["x"]))).rejects.toThrow("cache is full");
    expect(await db.getAudio(second)).toBeUndefined(); await db.discardStagedAudio(first, false);
    expect(await db.saveAudio(db.newAudioAssetId("source"), new Blob(["x"]))).toMatchObject({ durable: false });
  });
  it("rejects overwriting an existing or arbitrary asset before storage or fallback", async () => {
    vi.stubGlobal("indexedDB", { open: () => { throw new DOMException("Denied", "SecurityError"); } });
    const db = await import("../db"); const id = db.newAudioAssetId("source"); const original = new Blob(["original"]);
    await db.saveAudio(id, original);
    await expect(db.saveAudio(id, new Blob(["changed"]))).rejects.toThrow("immutable");
    await expect(db.saveAudio("known-existing", new Blob(["changed"]))).rejects.toThrow("immutable");
    expect(await db.getAudio(id)).toBe(original);
  });
  it("never shadows a colliding durable asset in memory and confirms deletion before resolving", async () => {
    vi.stubGlobal("indexedDB", testIndexedDB);
    vi.stubGlobal("Blob", NativeBlob);
    vi.stubGlobal("crypto", { randomUUID: () => "immutable-asset" });
    const db = await import("../db"); const id = db.newAudioAssetId("source"); const original = new Blob(["original"]);
    expect(await db.saveAudio(id, original)).toEqual({ durable: true });
    const collision = db.newAudioAssetId("source"); expect(collision).toBe(id);
    await expect(db.saveAudio(collision, new Blob(["changed"]))).rejects.toThrow("already exists");
    expect(await (await db.getAudio(id))?.text()).toBe("original");
    await db.deleteAudio(id); expect(await db.getAudio(id)).toBeUndefined();
  });
  it("reports failed durable deletion so callers can retain the project and retry", async () => {
    vi.stubGlobal("indexedDB", { open: () => { throw new DOMException("Denied", "SecurityError"); } });
    const db = await import("../db"); await expect(db.deleteAudio("durable-unknown")).rejects.toThrow("Denied");
  });
  it("does not invent storage usage or persistence when APIs are unavailable", async () => {
    vi.stubGlobal("navigator", {}); const db = await import("../db"); expect(await db.storageSummary()).toEqual({ persistent: null });
  });
});
