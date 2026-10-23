import { afterEach, describe, expect, it, vi } from "vitest";
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });
describe("bounded audio persistence", () => {
  it("retains readable session audio when durable storage is denied and explicitly deletes it", async () => {
    vi.stubGlobal("indexedDB", { open: () => { throw new DOMException("Denied", "SecurityError"); } });
    const db = await import("../db"); const blob = new Blob(["source"]);
    expect(await db.saveAudio("fresh-source", blob)).toMatchObject({ durable: false });
    expect(await db.getAudio("fresh-source")).toBe(blob);
    await db.deleteAudio("fresh-source"); expect(await db.getAudio("fresh-source")).toBeUndefined();
  });
  it("rejects an unretained source when the aggregate session budget is exhausted", async () => {
    vi.stubGlobal("indexedDB", { open: () => { throw new DOMException("Full", "QuotaExceededError"); } });
    const db = await import("../db"); const full = new Blob(["bounded source"]); Object.defineProperty(full, "size", { value: 128 * 1024 * 1024 + 44 });
    await db.saveAudio("first", full); await expect(db.saveAudio("second", new Blob(["x"]))).rejects.toThrow("cache is full");
    expect(await db.getAudio("second")).toBeUndefined(); await db.discardStagedAudio("first", false);
    expect(await db.saveAudio("retry", new Blob(["x"]))).toMatchObject({ durable: false });
  });
  it("reports failed durable deletion so callers can retain the project and retry", async () => {
    vi.stubGlobal("indexedDB", { open: () => { throw new DOMException("Denied", "SecurityError"); } });
    const db = await import("../db"); await expect(db.deleteAudio("durable-unknown")).rejects.toThrow("Denied");
  });
  it("does not invent storage usage or persistence when APIs are unavailable", async () => {
    vi.stubGlobal("navigator", {}); const db = await import("../db"); expect(await db.storageSummary()).toEqual({ persistent: null });
  });
});
