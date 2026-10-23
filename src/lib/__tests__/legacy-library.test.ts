import { File as NativeFile } from "node:buffer";
import { IDBDatabase, IDBFactory, IDBKeyRange, IDBObjectStore } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readLegacyWav, scanLegacySources } from "../legacy-library";

const DATABASE = "aurialis-library-entries-v1";
let factory: IDBFactory;
beforeEach(() => {
  factory = new IDBFactory();
  vi.stubGlobal("indexedDB", factory);
  vi.stubGlobal("IDBKeyRange", IDBKeyRange);
  vi.stubGlobal("File", NativeFile);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

async function seed(keys: readonly string[]): Promise<void> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(DATABASE);
    request.onupgradeneeded = () => { request.result.createObjectStore("kv"); };
    request.onsuccess = () => { resolve(request.result); };
    request.onerror = () => { reject(request.error ?? new Error("Fixture database failed")); };
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("kv", "readwrite");
      for (const key of keys) transaction.objectStore("kv").put({ settings: "ignored".repeat(1024), script: { untrusted: true } }, key);
      transaction.oncomplete = () => { resolve(); };
      transaction.onerror = () => { reject(transaction.error ?? new Error("Fixture write failed")); };
    });
  } finally { database.close(); }
}

function opfs(file: File) {
  const getFile = vi.fn().mockResolvedValue(file);
  const getFileHandle = vi.fn().mockResolvedValue({ getFile });
  const getDirectoryHandle = vi.fn().mockResolvedValue({ getFileHandle });
  vi.stubGlobal("navigator", { storage: { getDirectory: vi.fn().mockResolvedValue({ getDirectoryHandle }) } });
  return { getFile, getFileHandle, getDirectoryHandle };
}
function wav(): File { return new File(["RIFF0000WAVEpayload"], "irrelevant.bin", { lastModified: 123 }); }
const signal = () => new AbortController().signal;

describe("read-only legacy library recovery", () => {
  it("does not create an absent database", async () => {
    expect(await scanLegacySources(signal())).toEqual({ sources: [], skipped: 0, next: null, stopped: false });
    expect(await factory.databases()).toEqual([]);
  });
  it("reads only keys in pages and never clones old scripts or settings", async () => {
    const keys = Array.from({ length: 35 }, (_, index) => `track-${String(index).padStart(2, "0")}.wav|18|123`);
    await seed(keys);
    const get = vi.spyOn(IDBObjectStore.prototype, "get");
    const getAll = vi.spyOn(IDBObjectStore.prototype, "getAll");
    const cursor = vi.spyOn(IDBObjectStore.prototype, "openCursor");
    const put = vi.spyOn(IDBObjectStore.prototype, "put");
    const first = await scanLegacySources(signal());
    expect(first.sources).toHaveLength(32);
    expect(first.next).toBe(keys[31]);
    const second = await scanLegacySources(signal(), first.next);
    expect(second.sources.map((entry) => entry.key)).toEqual(keys.slice(32));
    expect(second.next).toBeNull();
    expect(get).not.toHaveBeenCalled(); expect(getAll).not.toHaveBeenCalled(); expect(cursor).not.toHaveBeenCalled(); expect(put).not.toHaveBeenCalled();
  });
  it("continues past a bounded page of invalid keys without loading their values", async () => {
    const invalid = Array.from({ length: 65 }, (_, index) => `bad-${String(index).padStart(2, "0")}`);
    await seed([...invalid, "track.wav|18|123"]);
    const first = await scanLegacySources(signal());
    expect(first.sources).toHaveLength(0); expect(first.skipped).toBe(64); expect(first.next).toBe(invalid[63]);
    const second = await scanLegacySources(signal(), first.next);
    expect(second.sources).toHaveLength(1); expect(second.skipped).toBe(1);
  });
  it("parses filename separators and collision suffixes, rejecting unsafe or malformed geometry", async () => {
    await seed(["a|b.wav|18|123|abcdef0123456789", "bad.wav|0|123", "bad.wav|9007199254740992|123", `bad\u0000.wav|18|123`, `${"x".repeat(256)}|18|123`]);
    const page = await scanLegacySources(signal());
    expect(page.sources).toEqual([{ key: "a|b.wav|18|123|abcdef0123456789", name: "a|b.wav", size: 18, modified: 123 }]);
    expect(page.skipped).toBe(4);
  });
  it("reads a selected fixed OPFS snapshot without writes and detects later replacement", async () => {
    const file = wav(), key = `a|b.wav|${String(file.size)}|456`;
    await seed([key]); const handles = opfs(file);
    const source = (await scanLegacySources(signal())).sources[0]; if (!source) throw new Error("Missing fixture");
    const selected = await readLegacyWav(source, signal());
    expect(handles.getDirectoryHandle).toHaveBeenCalledWith("library", { create: false });
    expect(handles.getFileHandle).toHaveBeenCalledWith(`${encodeURIComponent(key)}.bin`, { create: false });
    expect(selected.file.name).toBe("a|b.wav"); expect(await selected.file.text()).toBe(await file.text());
    await selected.verify();
    handles.getFile.mockResolvedValue(new File([await file.arrayBuffer()], "changed.bin", { lastModified: 124 }));
    await expect(selected.verify()).rejects.toThrow("changed during recovery");
  });
  it("rejects compressed originals after only twelve header bytes and retains their records", async () => {
    const file = new File(["ID3compressed-original"], "track.bin", { lastModified: 123 });
    const key = `track.mp3|${String(file.size)}|123`; await seed([key]); opfs(file);
    const source = (await scanLegacySources(signal())).sources[0]; if (!source) throw new Error("Missing fixture");
    const fullRead = vi.spyOn(file, "arrayBuffer");
    await expect(readLegacyWav(source, signal())).rejects.toThrow("Codec recovery is unavailable");
    expect(fullRead).not.toHaveBeenCalled(); expect((await scanLegacySources(signal())).sources).toHaveLength(1);
  });
  it("rejects oversize and changed sources before reading full audio", async () => {
    const oversize = `huge.wav|${String(128 * 1024 * 1024 + 45)}|123`;
    await seed([oversize, "small.wav|20|123"]); const handles = opfs(wav());
    const page = await scanLegacySources(signal()); const huge = page.sources.find((item) => item.key === oversize), small = page.sources.find((item) => item.name === "small.wav");
    if (!huge || !small) throw new Error("Missing fixture");
    await expect(readLegacyWav(huge, signal())).rejects.toThrow("128 MiB"); expect(handles.getFile).not.toHaveBeenCalled();
    await expect(readLegacyWav(small, signal())).rejects.toThrow("missing, changed");
  });
  it("does not continue a canceled scan or source read", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(scanLegacySources(controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    const file = wav(), key = `track.wav|${String(file.size)}|123`; await seed([key]); const handles = opfs(file);
    const source = (await scanLegacySources(signal())).sources[0]; if (!source) throw new Error("Missing fixture");
    await expect(readLegacyWav(source, controller.signal)).rejects.toMatchObject({ name: "AbortError" }); expect(handles.getFile).not.toHaveBeenCalled();
  });
  it("cancels a pending OPFS read promptly and prevents overlapping browser reads", async () => {
    const file = wav(), key = `track.wav|${String(file.size)}|123`; await seed([key]);
    const source = (await scanLegacySources(signal())).sources[0]; if (!source) throw new Error("Missing fixture");
    let release: (() => void) | undefined, started: (() => void) | undefined;
    const observed = new Promise<void>((resolve) => { started = resolve; });
    const pending = new Promise<FileSystemDirectoryHandle>((resolve) => { release = () => { resolve({} as FileSystemDirectoryHandle); }; });
    const getDirectory = vi.fn(() => { started?.(); return pending; });
    vi.stubGlobal("navigator", { storage: { getDirectory } });
    const controller = new AbortController(), reading = readLegacyWav(source, controller.signal);
    const rejected = expect(reading).rejects.toMatchObject({ name: "AbortError" });
    await observed; controller.abort(); await rejected;
    await expect(readLegacyWav(source, signal())).rejects.toThrow("still settling"); expect(getDirectory).toHaveBeenCalledTimes(1);
    release?.(); await pending; await Promise.resolve();
    opfs(file); await expect(readLegacyWav(source, signal())).resolves.toHaveProperty("file");
  });
  it("times out an unresponsive OPFS read without deleting or starting a second read", async () => {
    const file = wav(), key = `track.wav|${String(file.size)}|123`; await seed([key]);
    const source = (await scanLegacySources(signal())).sources[0]; if (!source) throw new Error("Missing fixture");
    let release: (() => void) | undefined, started: (() => void) | undefined;
    const observed = new Promise<void>((resolve) => { started = resolve; });
    const pending = new Promise<FileSystemDirectoryHandle>((resolve) => { release = () => { resolve({} as FileSystemDirectoryHandle); }; });
    const getDirectory = vi.fn(() => { started?.(); return pending; });
    vi.stubGlobal("navigator", { storage: { getDirectory } });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const reading = readLegacyWav(source, signal()), rejected = expect(reading).rejects.toThrow("did not respond");
    await observed; await vi.advanceTimersByTimeAsync(5000); await rejected;
    expect(getDirectory).toHaveBeenCalledTimes(1);
    release?.(); await pending; await Promise.resolve();
    vi.useRealTimers(); expect((await scanLegacySources(signal())).sources).toHaveLength(1);
  });
  it("settles the transaction deadline even when abort throws and completion arrives late", async () => {
    await seed(["track.wav|19|123"]);
    let started: (() => void) | undefined;
    const observed = new Promise<void>((resolve) => { started = resolve; });
    const abort = vi.fn(() => { throw new DOMException("Already complete", "InvalidStateError"); });
    const transaction = { abort, objectStore: () => ({ openKeyCursor: () => { started?.(); return {}; } }) } as unknown as IDBTransaction;
    vi.spyOn(IDBDatabase.prototype, "transaction").mockImplementationOnce(() => transaction);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const scanning = scanLegacySources(signal()), rejected = expect(scanning).rejects.toThrow("did not respond");
    await observed; await vi.advanceTimersByTimeAsync(5000); await rejected;
    expect(abort).toHaveBeenCalledOnce();
    expect(() => { transaction.oncomplete?.call(transaction, new Event("complete")); }).not.toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("reports an incomplete scan when an oversized key prevents bounded continuation", async () => {
    const keys = Array.from({ length: 64 }, (_, index) => `${String(index).padStart(2, "0")}-${"x".repeat(1025)}`);
    await seed([...keys, "z.wav|19|123"]);
    expect(await scanLegacySources(signal())).toEqual({ sources: [], skipped: 64, next: null, stopped: true });
  });
});
