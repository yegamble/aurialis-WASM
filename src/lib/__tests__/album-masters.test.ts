import { afterEach, describe, expect, it, vi } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { Blob as NativeBlob } from "node:buffer";

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

describe("saved album masters", () => {
  it("replaces an album's masters, deleting only the audio it no longer references", async () => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    vi.stubGlobal("Blob", NativeBlob);
    const db = await import("../db");
    const first = db.newAudioAssetId("master"), second = db.newAudioAssetId("master");
    await db.saveAudio(first, new Blob(["first render"]), false);
    await db.saveAudio(second, new Blob(["second render"]), false);
    await db.saveAlbumMasters("album-1", { key: "k1", createdAt: "2026-10-26T00:00:00Z", files: [{ trackId: "t", title: "Song", audioId: first, bytes: 12 }] });
    expect((await db.loadAlbumMasters("album-1"))?.files[0]?.audioId).toBe(first);
    await db.saveAlbumMasters("album-1", { key: "k2", createdAt: "2026-10-26T00:01:00Z", files: [{ trackId: "t", title: "Song", audioId: second, bytes: 13 }] });
    expect(await db.getAudio(first)).toBeUndefined();
    expect(await (await db.getAudio(second))?.text()).toBe("second render");
    expect((await db.loadAlbumMasters("album-1"))?.key).toBe("k2");
    await db.deleteAlbumMasters("album-1");
    expect(await db.loadAlbumMasters("album-1")).toBeUndefined();
    expect(await db.getAudio(second)).toBeUndefined();
  });

  it("ignores malformed records instead of offering arbitrary audio keys", async () => {
    vi.stubGlobal("indexedDB", new IDBFactory());
    const db = await import("../db");
    const source = db.newAudioAssetId("source");
    await expect(db.saveAlbumMasters("album-2", { key: "k", createdAt: "now", files: [{ trackId: "t", title: "Song", audioId: source, bytes: 1 }] })).resolves.toBeUndefined();
    expect(await db.loadAlbumMasters("album-2")).toBeUndefined();
  });

  it("refuses to render when the browser reports too little free storage", async () => {
    vi.stubGlobal("navigator", { storage: { estimate: () => Promise.resolve({ usage: 900 * 1048576, quota: 1000 * 1048576 }), persisted: () => Promise.resolve(false) } });
    const db = await import("../db");
    await expect(db.ensureStorageFor(200 * 1048576)).rejects.toThrow("needs about 236 MiB of browser storage, but only 100 MiB is free");
    await expect(db.ensureStorageFor(50 * 1048576)).resolves.toBeUndefined();
  });

  it("does not block rendering when storage estimates are unavailable", async () => {
    vi.stubGlobal("navigator", {});
    const db = await import("../db");
    await expect(db.ensureStorageFor(1 << 30)).resolves.toBeUndefined();
  });
});
