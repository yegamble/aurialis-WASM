import { Blob as NativeBlob } from "node:buffer";
import { webcrypto } from "node:crypto";
import { IDBFactory, IDBDatabase, IDBObjectStore } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AlbumSpool, maximumAlbumSpoolBytes } from "../album-spool";
import { albumCleanupStatus, retryAlbumCleanup } from "../album-cleanup";

const hash = "a".repeat(64), expectedBytes = 644;
const recipe = (albumId = "album-one", bytes = expectedBytes) => ({ albumId, bindingHash: hash, processingBuild: "b".repeat(64), planHash: "c".repeat(64), expectedBytes: bytes, totalTracks: bytes === maximumAlbumSpoolBytes ? 64 : 2 });
const layout = (index: number) => ({ index, sha256: "d".repeat(64), sampleRate: 48000, frames: 100 });
const signal = () => new AbortController().signal;
const sessions: AlbumSpool[] = [];
async function open(albumId = "album-one", bytes = expectedBytes) { const spool = await AlbumSpool.open(recipe(albumId, bytes)); sessions.push(spool); return spool; }
function deferred<T>() { let complete: ((value: T) => void) | undefined; const promise = new Promise<T>((resolve) => { complete = resolve; }); return { promise, resolve(value: T) { if (!complete) throw new Error("Missing resolver"); complete(value); } }; }
function lockManager() {
  const locks = new Set<string>();
  return { request: async (name: string, _options: { ifAvailable: true }, action: (lock: { name: string; mode: "exclusive" } | null) => Promise<void>) => {
    if (locks.has(name)) return action(null);
    locks.add(name); try { await action({ name, mode: "exclusive" }); } finally { locks.delete(name); }
  } };
}
beforeEach(() => { vi.stubGlobal("indexedDB", new IDBFactory()); vi.stubGlobal("navigator", { locks: lockManager() }); vi.stubGlobal("crypto", webcrypto); vi.stubGlobal("Blob", NativeBlob); });
afterEach(async () => { for (const session of sessions.splice(0)) await session.close().catch(() => undefined); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("bounded durable album spool", () => {
  it("pauses by deleting pending bytes and releasing unused disk demand while keeping its prefix and lock", async () => {
    const spool = await open("paused", expectedBytes * 2), first = await spool.stage(new Blob([new Uint8Array(expectedBytes)]), layout(0), signal());
    await spool.promote(first.assetId, signal()); await spool.stage(new Blob([new Uint8Array(expectedBytes)]), layout(1), signal());
    await spool.pause(); expect(spool.prefix()).toEqual([first]);
    await expect(AlbumSpool.claim("paused")).rejects.toThrow(/another tab/u);
    await expect(spool.withOutput({ ...first, index: 1 }, signal(), () => Promise.resolve(undefined))).rejects.toThrow(/owned/u);
    const other = await open("competing", maximumAlbumSpoolBytes - expectedBytes);
    await expect(spool.resume()).rejects.toThrow(/disk limit/u); expect(spool.prefix()).toEqual([first]);
    await other.close(); await spool.resume();
    const next = await spool.stage(new Blob([new Uint8Array(expectedBytes)]), layout(1), signal()); await spool.promote(next.assetId, signal()); expect(spool.prefix()).toHaveLength(2);
  });
  it("does not admit another render while paused until the remaining whole-plan demand is reserved again", async () => {
    const spool = await open("paused-empty"); await spool.pause();
    await expect(spool.stage(new Blob([new Uint8Array(expectedBytes)]), layout(0), signal())).rejects.toThrow(/reserved/u);
    const other = await open("all-capacity", maximumAlbumSpoolBytes);
    await expect(spool.resume()).rejects.toThrow(/disk limit/u); await other.close(); await spool.resume();
    await spool.stage(new Blob([new Uint8Array(expectedBytes)]), layout(0), signal());
  });
  it("retains the owner and pending demand after failed pause cleanup until an explicit retry settles", async () => {
    const spool = await open("pause-failure"); await spool.stage(new Blob([new Uint8Array(expectedBytes)]), layout(0), signal());
    vi.spyOn(IDBObjectStore.prototype, "delete").mockImplementationOnce(() => { throw new DOMException("Cleanup denied", "QuotaExceededError"); });
    await expect(spool.pause()).rejects.toThrow(/Cleanup denied/u); await expect(AlbumSpool.claim("pause-failure")).rejects.toThrow(/another tab/u);
    await expect(open("other", maximumAlbumSpoolBytes)).rejects.toThrow(/disk limit/u);
    await spool.pause(); const next = await open("other", maximumAlbumSpoolBytes); expect(next.prefix()).toEqual([]);
  });
  it("claims album ownership before plan or storage IO and binds whole demand only after planning", async () => {
    const opening = vi.spyOn(indexedDB, "open"), spool = await AlbumSpool.claim("early"); sessions.push(spool);
    expect(opening).not.toHaveBeenCalled(); expect(spool.prefix()).toEqual([]);
    await expect(AlbumSpool.claim("early")).rejects.toThrow(/another tab/u);
    await expect(AlbumSpool.clearStored("early")).rejects.toThrow(/another tab/u);
    await expect(spool.stage(new Blob([new Uint8Array(expectedBytes)]), layout(0), signal())).rejects.toThrow(/sequence/u);
    await spool.bind(recipe("early")); expect(opening).toHaveBeenCalled();
    const pending = await spool.stage(new Blob([new Uint8Array(expectedBytes)]), layout(0), signal()); await spool.promote(pending.assetId, signal());
    expect(spool.prefix()).toEqual([pending]); await expect(spool.bind(recipe("early"))).rejects.toThrow(/bound/u);
  });
  it("keeps an early claim through pending admission settlement and removes its empty reservation on close", async () => {
    const spool = await AlbumSpool.claim("pending-plan"); sessions.push(spool);
    const held = deferred<() => void>(), transaction = Reflect.get(IDBDatabase.prototype, "transaction");
    vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (this: IDBDatabase, ...args) {
      const value = transaction.apply(this, args);
      if (args[1] === "readwrite") Object.defineProperty(value, "oncomplete", { set(handler: (event: Event) => void) { value.addEventListener("complete", (event) => { held.resolve(() => { handler.call(value, event); }); }, { once: true }); } });
      return value;
    });
    const binding = spool.bind(recipe("pending-plan")), release = await held.promise; vi.restoreAllMocks();
    const closing = spool.close(); await expect(AlbumSpool.claim("pending-plan")).rejects.toThrow(/another tab/u);
    release(); await binding; await closing;
    const next = await open("pending-plan", maximumAlbumSpoolBytes); expect(next.prefix()).toEqual([]);
  });
  it("rejects a different album binding before DB IO while retaining explicit ownership until close", async () => {
    const spool = await AlbumSpool.claim("owner"); sessions.push(spool); const opening = vi.spyOn(indexedDB, "open");
    await expect(spool.bind(recipe("different"))).rejects.toThrow(/another album/u); expect(opening).not.toHaveBeenCalled();
    await expect(AlbumSpool.claim("owner")).rejects.toThrow(/another tab/u);
    await spool.close(); const next = await AlbumSpool.claim("owner"); sessions.push(next);
  });
  it("captures the complete primitive binding before queued admission can observe caller mutation", async () => {
    const spool = await AlbumSpool.claim("captured"); sessions.push(spool);
    const mutable = recipe("captured"), binding = spool.bind(mutable); mutable.bindingHash = "f".repeat(64); mutable.processingBuild = "e".repeat(64);
    await binding; const pending = await spool.stage(new Blob([new Uint8Array(expectedBytes)]), layout(0), signal()); await spool.promote(pending.assetId, signal()); await spool.close();
    const restored = await AlbumSpool.open(recipe("captured")); sessions.push(restored); expect(restored.prefix()).toHaveLength(1);
  });
  it.each(["revision", "owner", "processingBuild"] as const)("checks persisted %s in the same transaction that loads output bytes", async (field) => {
    const spool = await open(), pending = await spool.stage(new Blob([new Uint8Array(expectedBytes)]), layout(0), signal()); await spool.promote(pending.assetId, signal());
    let originalManifest: unknown;
    const database = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open("aurialis-album-spool-v1", 1); request.onsuccess = () => { resolve(request.result); }; request.onerror = () => { reject(request.error ?? new Error("Fixture open failed")); }; });
    try { await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("runs", "readwrite"), store = transaction.objectStore("runs"), request = store.get("album:album-one");
      request.onsuccess = () => { const manifest = request.result as Record<string, unknown>; originalManifest = manifest; store.put({ ...manifest, [field]: field === "revision" ? Number(manifest.revision) + 1 : field === "owner" ? crypto.randomUUID() : "f".repeat(64) }, "album:album-one"); };
      transaction.oncomplete = () => { resolve(); }; transaction.onerror = () => { reject(transaction.error ?? new Error("Fixture mutation failed")); };
    }); } finally { database.close(); }
    const consume = vi.fn<(blob: Blob) => Promise<void>>();
    await expect(spool.withOutput(pending, signal(), consume)).rejects.toThrow(/ownership/u); expect(consume).not.toHaveBeenCalled();
    const restored = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open("aurialis-album-spool-v1", 1); request.onsuccess = () => { resolve(request.result); }; request.onerror = () => { reject(request.error ?? new Error("Fixture reopen failed")); }; });
    try { await new Promise<void>((resolve, reject) => { const transaction = restored.transaction("runs", "readwrite"); transaction.objectStore("runs").put(originalManifest, "album:album-one"); transaction.oncomplete = () => { resolve(); }; transaction.onerror = () => { reject(transaction.error ?? new Error("Fixture restore failed")); }; }); } finally { restored.close(); }
  });
  it("stores immutable staged bytes separately from the metadata-only verified prefix", async () => {
    const spool = await open(), wav = new Blob([new Uint8Array(expectedBytes)]);
    const pending = await spool.stage(wav, layout(0), signal());
    expect(spool.prefix()).toEqual([]);
    await spool.promote(pending.assetId, signal());
    expect(spool.prefix()).toEqual([pending]); expect(JSON.stringify(spool.prefix())).not.toContain("Blob");
    const actual = await spool.withOutput(pending, signal(), async (stored) => new Uint8Array(await stored.arrayBuffer()));
    expect(actual).toEqual(new Uint8Array(expectedBytes));
    await expect(spool.promote(pending.assetId, signal())).rejects.toThrow(/pending/u);
  });
  it("requires exclusive album ownership across creation, resume and deletion", async () => {
    const first = await open();
    await expect(AlbumSpool.open(recipe())).rejects.toThrow(/another tab/u);
    await first.close(); const second = await open(); await second.clear();
    await expect(first.stage(new Blob([new Uint8Array(expectedBytes)]), layout(0), signal())).rejects.toThrow(/closed/u);
  });
  it("accounts whole-run disk demand in transactions across different albums and releases unused reservations", async () => {
    const large = await open("large", maximumAlbumSpoolBytes);
    await expect(open("second")).rejects.toThrow(/disk limit/u);
    await large.close(); const second = await open("second"); expect(second.prefix()).toEqual([]);
  });
  it("does not promote bytes or consume demand when quota rejects an output transaction", async () => {
    const spool = await open();
    vi.spyOn(IDBObjectStore.prototype, "add").mockImplementationOnce(() => { throw new DOMException("Full", "QuotaExceededError"); });
    await expect(spool.stage(new Blob([new Uint8Array(expectedBytes)]), layout(0), signal())).rejects.toThrow("Full");
    expect(spool.prefix()).toEqual([]);
    const pending = await spool.stage(new Blob([new Uint8Array(expectedBytes)]), layout(0), signal()); await spool.promote(pending.assetId, signal());
    expect(spool.prefix()).toHaveLength(1);
  });
  it("retains committed bytes after close and resumes only a matching full recipe", async () => {
    const first = await open(), pending = await first.stage(new Blob([new Uint8Array(expectedBytes)]), layout(0), signal());
    await first.promote(pending.assetId, signal()); await first.close();
    await expect(AlbumSpool.open({ ...recipe(), bindingHash: "f".repeat(64) })).rejects.toThrow(/different/u);
    const second = await open(); expect(second.prefix()).toEqual([pending]);
    await second.withOutput(pending, signal(), (stored) => { expect(stored.size).toBe(expectedBytes); return Promise.resolve(); });
  });
  it("rejects changed processing builds or plans without restoring prefix authority", async () => {
    const first = await open(), pending = await first.stage(new Blob([new Uint8Array(expectedBytes)]), layout(0), signal()); await first.promote(pending.assetId, signal()); await first.close();
    for (const field of ["processingBuild", "planHash"] as const) await expect(AlbumSpool.open({ ...recipe(), [field]: "e".repeat(64) })).rejects.toThrow(/different/u);
    await expect(AlbumSpool.open({ ...recipe(), processingBuild: "development" })).rejects.toThrow(/qualified/u);
  });
  it("keeps its lock until a pending real transaction and rollback settle on close", async () => {
    const spool = await open(), held = deferred<() => void>();
    const transaction = Reflect.get(IDBDatabase.prototype, "transaction");
    vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (this: IDBDatabase, ...args) {
      const value = transaction.apply(this, args);
      if (args[1] === "readwrite") Object.defineProperty(value, "oncomplete", { set(handler: (event: Event) => void) { value.addEventListener("complete", (event) => { held.resolve(() => { handler.call(value, event); }); }, { once: true }); } });
      return value;
    });
    const writing = spool.stage(new Blob([new Uint8Array(expectedBytes)]), layout(0), signal()); const release = await held.promise;
    vi.restoreAllMocks(); const closing = spool.close();
    await expect(AlbumSpool.open(recipe())).rejects.toThrow(/another tab/u);
    release(); await writing; await closing;
    const resumed = await open(); expect(resumed.prefix()).toEqual([]);
  });
  it("holds album ownership through the output consumer, including URL lifetime", async () => {
    const spool = await open(), pending = await spool.stage(new Blob([new Uint8Array(expectedBytes)]), layout(0), signal()); await spool.promote(pending.assetId, signal());
    const held = deferred<undefined>(), entered = deferred<undefined>();
    const downloading = spool.withOutput(pending, signal(), async () => { entered.resolve(undefined); await held.promise; }); await entered.promise;
    const closing = spool.close(); await expect(AlbumSpool.open(recipe())).rejects.toThrow(/another tab/u);
    held.resolve(undefined); await downloading; await closing; const resumed = await open(); expect(resumed.prefix()).toHaveLength(1);
  });
  it("refuses a full cleanup capability registry before another WebLock or storage IO", async () => {
    for (let index = 0; index < 64; index++) { const owner = await AlbumSpool.claim(`early-${String(index)}`); sessions.push(owner); }
    const lock = vi.spyOn(navigator.locks, "request"), opening = vi.spyOn(indexedDB, "open");
    await expect(AlbumSpool.claim("overflow")).rejects.toThrow(/64 active/u); expect(lock).not.toHaveBeenCalled(); expect(opening).not.toHaveBeenCalled();
  });
  it("limits stored run count and validates byte/layout demand before any database write", async () => {
    await expect(AlbumSpool.open({ ...recipe(), totalTracks: 65 })).rejects.toThrow(/64/u);
    await expect(AlbumSpool.open({ ...recipe(), expectedBytes: maximumAlbumSpoolBytes + 1 })).rejects.toThrow(/disk limit/u);
    const spool = await open(); await expect(spool.stage(new Blob([new Uint8Array(expectedBytes + 1)]), layout(0), signal())).rejects.toThrow(/length/u);
    for (const [index, owner] of [spool, ...await Promise.all(Array.from({ length: 63 }, (_, item) => open(`album-${String(item + 1)}`)))].entries()) {
      const pending = await owner.stage(new Blob([new Uint8Array(expectedBytes)]), layout(0), signal()); await owner.promote(pending.assetId, signal()); await owner.close(); expect(index).toBeLessThan(64);
    }
    await expect(open("overflow")).rejects.toThrow(/64 stored/u);
  });
  it("clears only its own run while preserving another album's exact staged output", async () => {
    const first = await open("first"), second = await open("second"), wav = new Blob([new Uint8Array(expectedBytes)]);
    const left = await first.stage(wav, layout(0), signal()), right = await second.stage(wav, layout(0), signal());
    await first.promote(left.assetId, signal()); await second.promote(right.assetId, signal()); await first.clear();
    await second.withOutput(right, signal(), (stored) => { expect(stored.size).toBe(expectedBytes); return Promise.resolve(); });
    await expect(second.withOutput(left, signal(), () => Promise.resolve(undefined))).rejects.toThrow(/owned/u);
  });
  it.each(["close", "clear"] as const)("keeps failed terminal %s ownership until the same owner retries its actual transaction", async (method) => {
    const spool = await open(`terminal-${method}`, expectedBytes * 2), first = await spool.stage(new Blob([new Uint8Array(expectedBytes)]), layout(0), signal()); await spool.promote(first.assetId, signal());
    await spool.stage(new Blob([new Uint8Array(expectedBytes)]), layout(1), signal());
    vi.spyOn(IDBObjectStore.prototype, "delete").mockImplementationOnce(() => { throw new DOMException("Terminal delete failed", "UnknownError"); });
    await expect(method === "close" ? spool.close() : spool.clear()).rejects.toThrow(/Terminal delete failed/u);
    const competed = await AlbumSpool.claim(`terminal-${method}`).then((owner) => { sessions.push(owner); return true; }, () => false);
    expect(competed).toBe(false); await expect(spool.resume()).rejects.toThrow(/closed/u);
    await (method === "close" ? spool.close() : spool.clear()); const next = await open(`terminal-${method}`, expectedBytes * 2); expect(next.prefix()).toHaveLength(method === "clear" ? 0 : 1);
  });
  it("does not repeat deletion after an empty close transaction already removed its manifest", async () => {
    const spool = await open("empty-late-discard"), completed = deferred<() => void>(), transaction = Reflect.get(IDBDatabase.prototype, "transaction");
    vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementation(function (this: IDBDatabase, ...args) {
      const current = transaction.apply(this, args);
      if (args[1] === "readwrite") Object.defineProperty(current, "oncomplete", { set(handler: (event: Event) => void) { current.addEventListener("complete", (event) => { completed.resolve(() => { handler.call(current, event); }); }, { once: true }); } }); return current;
    });
    const closing = spool.close(), release = await completed.promise; vi.restoreAllMocks(); expect(spool.clear()).toBe(closing); release(); await expect(closing).resolves.toBeUndefined();
    expect(albumCleanupStatus("empty-late-discard")).toBeNull(); const next = await open("empty-late-discard"); expect(next.prefix()).toEqual([]);
  });
  it.each([false, true])("finishes late discard after actual lock release settlement, with competing ownership %s", async (competes) => {
    const releasing = deferred<undefined>(), gate = deferred<undefined>(), foreignReady = deferred<undefined>(), foreignEnd = deferred<undefined>();
    let held = false, initial = true;
    vi.stubGlobal("navigator", { locks: { request: async (name: string, _options: unknown, consume: (lock: { name: string } | null) => Promise<void>) => {
      if (held) return consume(null); held = true; try { await consume({ name }); } finally { held = false; }
      if (initial) { initial = false; releasing.resolve(undefined); await gate.promise; }
    } } });
    const spool = await open("late-discard"), row = await spool.stage(new Blob([new Uint8Array(expectedBytes)]), layout(0), signal()); await spool.promote(row.assetId, signal());
    const closing = spool.close(); await releasing.promise; const clearing = spool.clear(); expect(clearing).toBe(closing); expect(spool.clear()).toBe(closing);
    const foreign = competes ? navigator.locks.request("aurialis-album:late-discard", { ifAvailable: true }, async (lock) => { expect(lock).not.toBeNull(); foreignReady.resolve(undefined); await foreignEnd.promise; }) : Promise.resolve();
    if (competes) await foreignReady.promise;
    const observed = competes ? expect(closing).rejects.toThrow(/another tab/u) : expect(closing).resolves.toBeUndefined(); gate.resolve(undefined); await observed;
    if (competes) {
      expect(albumCleanupStatus("late-discard")?.pending).toBe(true); await expect(AlbumSpool.claim("late-discard")).rejects.toThrow(/already owned/u);
      foreignEnd.resolve(undefined); await foreign;
      const first = retryAlbumCleanup("late-discard"), second = retryAlbumCleanup("late-discard"); expect(first).toBe(second); await first;
    }
    expect(albumCleanupStatus("late-discard")).toBeNull(); const next = await open("late-discard"); expect(next.prefix()).toEqual([]);
  });
  it("retires a superseded late cleanup owner visibly without deleting a newer foreign generation", async () => {
    const releasing = deferred<undefined>(), gate = deferred<undefined>(); let initial = true;
    vi.stubGlobal("navigator", { locks: { request: async (name: string, _options: unknown, consume: (lock: { name: string }) => Promise<void>) => {
      await consume({ name }); if (initial) { initial = false; releasing.resolve(undefined); await gate.promise; }
    } } });
    const spool = await open("superseded"), row = await spool.stage(new Blob([new Uint8Array(expectedBytes)]), layout(0), signal()); await spool.promote(row.assetId, signal());
    const closing = spool.close(); await releasing.promise; const clearing = spool.clear(); expect(clearing).toBe(closing);
    const database = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open("aurialis-album-spool-v1", 1); request.onsuccess = () => { resolve(request.result); }; request.onerror = () => { reject(request.error ?? new Error("Fixture open failed")); }; });
    let newer: unknown;
    try {
      await navigator.locks.request("aurialis-album:superseded", { ifAvailable: true }, async () => {
        await new Promise<void>((resolve, reject) => { const transaction = database.transaction("runs", "readwrite"), store = transaction.objectStore("runs"), request = store.get("album:superseded"); request.onsuccess = () => { const current = request.result as { revision: number }; newer = { ...current, owner: crypto.randomUUID(), revision: current.revision + 1 }; store.put(newer, "album:superseded"); }; transaction.oncomplete = () => { resolve(); }; transaction.onerror = () => { reject(transaction.error ?? new Error("Fixture update failed")); }; });
      });
      const failed = expect(closing).rejects.toThrow(/retired; the current stored run was not modified/u); gate.resolve(undefined); await failed;
      expect(spool.isClosed()).toBe(true); expect(albumCleanupStatus("superseded")).toBeNull();
      const actual = await new Promise<unknown>((resolve, reject) => { const transaction = database.transaction("runs", "readonly"), request = transaction.objectStore("runs").get("album:superseded"); transaction.oncomplete = () => { resolve(request.result as unknown); }; transaction.onerror = () => { reject(transaction.error ?? new Error("Fixture read failed")); }; }); expect(actual).toEqual(newer);
    } finally { database.close(); }
    const next = await open("superseded"); expect(next.prefix()).toEqual([row]);
  });
  it("leaves failed pending cleanup recoverable and preserves the verified prefix", async () => {
    const first = await open("cleanup", expectedBytes * 2);
    const prefix = await first.stage(new Blob([new Uint8Array(expectedBytes)]), layout(0), signal()); await first.promote(prefix.assetId, signal());
    await first.stage(new Blob([new Uint8Array(expectedBytes)]), layout(1), signal());
    vi.spyOn(IDBObjectStore.prototype, "delete").mockImplementationOnce(() => { throw new DOMException("Delete denied", "UnknownError"); });
    await expect(first.close()).rejects.toThrow("Delete denied");
    await expect(AlbumSpool.claim("cleanup")).rejects.toThrow(/another tab/u); await first.close();
    const resumed = await open("cleanup", expectedBytes * 2); expect(resumed.prefix()).toEqual([prefix]);
    const next = await resumed.stage(new Blob([new Uint8Array(expectedBytes)]), layout(1), signal()); await resumed.promote(next.assetId, signal());
    expect(resumed.prefix()).toHaveLength(2);
  });
  it("rejects missing lock capability before opening browser storage", async () => {
    vi.stubGlobal("navigator", {}); const opening = vi.spyOn(indexedDB, "open");
    await expect(AlbumSpool.open(recipe())).rejects.toThrow(/cannot own/u); expect(opening).not.toHaveBeenCalled();
  });
  it("rejects an oversized stored Blob before handing it to inspection or download", async () => {
    const spool = await open(), pending = await spool.stage(new Blob([new Uint8Array(expectedBytes)]), layout(0), signal()); await spool.promote(pending.assetId, signal());
    const database = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open("aurialis-album-spool-v1", 1); request.onsuccess = () => { resolve(request.result); }; request.onerror = () => { reject(request.error ?? new Error("Fixture database open failed")); }; });
    try { await new Promise<void>((resolve, reject) => { const transaction = database.transaction("outputs", "readwrite"); transaction.objectStore("outputs").put(new Blob([new Uint8Array(expectedBytes + 1)]), ["album-one", pending.assetId]); transaction.oncomplete = () => { resolve(); }; transaction.onerror = () => { reject(transaction.error ?? new Error("Fixture mutation failed")); }; }); }
    finally { database.close(); }
    const consume = vi.fn<(blob: Blob) => Promise<void>>();
    await expect(spool.withOutput(pending, signal(), consume)).rejects.toThrow(/unexpected length/u); expect(consume).not.toHaveBeenCalled();
  });
  it("does not stage or load after cancellation and never publishes a prefix from a stage alone", async () => {
    const spool = await open(), canceled = new AbortController(); canceled.abort();
    await expect(spool.stage(new Blob([new Uint8Array(expectedBytes)]), layout(0), canceled.signal)).rejects.toThrow();
    const pending = await spool.stage(new Blob([new Uint8Array(expectedBytes)]), layout(0), signal());
    const consume = vi.fn<(blob: Blob) => Promise<void>>();
    await expect(spool.withOutput(pending, canceled.signal, consume)).rejects.toThrow();
    expect(consume).not.toHaveBeenCalled(); expect(spool.prefix()).toEqual([]);
  });

  it("explicitly clears an obsolete recipe under fresh ownership without accepting it for rendering", async () => {
    const first = await open(), pending = await first.stage(new Blob([new Uint8Array(expectedBytes)]), layout(0), signal()); await first.promote(pending.assetId, signal()); await first.close();
    const changed = { ...recipe(), bindingHash: "e".repeat(64) };
    await expect(AlbumSpool.open(changed)).rejects.toThrow(/different/u);
    await AlbumSpool.clearStored("album-one");
    const next = await AlbumSpool.open(changed); sessions.push(next); expect(next.prefix()).toEqual([]);
    await expect(AlbumSpool.clearStored("album-one")).rejects.toThrow(/another tab/u);
  });

});
