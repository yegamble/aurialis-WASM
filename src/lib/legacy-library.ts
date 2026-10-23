/** Read only the old library's keys; never deserialize its saved scripts or settings. */
const LEGACY_DATABASE = "aurialis-library-entries-v1";
const LEGACY_STORE = "kv";
const MAX_FILE_BYTES = 128 * 1024 * 1024 + 44;
const PAGE_SIZE = 32;
const SCAN_LIMIT = 64;
let pendingStorageRead = false;

// OPFS has no abort API. Stop waiting promptly and admit no second call until
// the previous browser operation actually settles; cancellation is not preemption.
function storageRead<T>(read: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  if (pendingStorageRead) return Promise.reject(new Error("An old storage read is still settling. Retry later or reload this tab."));
  pendingStorageRead = true;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (result: T | undefined, cause?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      if (cause !== undefined) reject(cause); else resolve(result as T);
    };
    const abort = () => { finish(undefined, new DOMException("Recovery canceled.", "AbortError")); };
    const timeout = setTimeout(() => { finish(undefined, new Error("Old audio storage did not respond. Its records are retained; retry later or reload this tab.")); }, 5000);
    signal.addEventListener("abort", abort, { once: true });
    void Promise.resolve().then(() => { signal.throwIfAborted(); return read(); }).then(
      (result) => { pendingStorageRead = false; finish(result); },
      (cause: unknown) => { pendingStorageRead = false; finish(undefined, cause instanceof Error ? cause : new Error("Old audio storage could not be read.")); },
    );
  });
}

export interface LegacySource {
  readonly key: string;
  readonly name: string;
  readonly size: number;
  readonly modified: number;
}
export interface LegacyPage {
  readonly sources: readonly LegacySource[];
  readonly next: string | null;
  readonly skipped: number;
  readonly stopped: boolean;
}

function sourceFromKey(value: unknown): LegacySource | null {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024) return null;
  const parts = value.split("|");
  if (/^[a-f\d]{16}$/u.test(parts.at(-1) ?? "")) parts.pop();
  const modifiedText = parts.pop(), sizeText = parts.pop(), name = parts.join("|");
  if (!name || name.length > 255 || Array.from(name).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) || !/^\d{1,16}$/u.test(sizeText ?? "") || !/^\d{1,16}$/u.test(modifiedText ?? "")) return null;
  const size = Number(sizeText), modified = Number(modifiedText);
  if (!Number.isSafeInteger(size) || size < 1 || !Number.isSafeInteger(modified) || modified < 0) return null;
  try { if (encodeURIComponent(value).length + 4 > 255) return null; } catch { return null; }
  return Object.freeze({ key: value, name, size, modified });
}

function oldDatabase(signal: AbortSignal): Promise<IDBDatabase | null> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") { reject(new Error("Browser library storage is unavailable.")); return; }
    let settled = false, absent = false;
    const request = indexedDB.open(LEGACY_DATABASE);
    const finish = (database: IDBDatabase | null, cause?: Error) => {
      if (settled) { database?.close(); return; }
      settled = true;
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      if (cause) { database?.close(); reject(cause); } else resolve(database);
    };
    const abort = () => { finish(null, new DOMException("Recovery canceled.", "AbortError")); };
    const timeout = setTimeout(() => { finish(null, new Error("Old library storage is busy. Close other Aurialis tabs and retry.")); }, 5000);
    signal.addEventListener("abort", abort, { once: true });
    request.onupgradeneeded = () => { absent = true; request.transaction?.abort(); };
    request.onblocked = () => { finish(null, new Error("Old library storage is blocked. Close other Aurialis tabs and retry.")); };
    request.onerror = () => { if (absent) finish(null); else finish(null, request.error ?? new Error("Old library storage could not be opened.")); };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => { database.close(); };
      if (!database.objectStoreNames.contains(LEGACY_STORE)) { database.close(); finish(null); return; }
      finish(database);
    };
  });
}

export async function scanLegacySources(signal: AbortSignal, after: string | null = null): Promise<LegacyPage> {
  if (after !== null && (after.length === 0 || after.length > 1024)) throw new Error("Invalid old library page. Scan again from the beginning.");
  const database = await oldDatabase(signal);
  if (!database) return { sources: [], next: null, skipped: 0, stopped: false };
  try {
    signal.throwIfAborted();
    return await new Promise<LegacyPage>((resolve, reject) => {
      const transaction = database.transaction(LEGACY_STORE, "readonly");
      const request = transaction.objectStore(LEGACY_STORE).openKeyCursor(IDBKeyRange.lowerBound(after ?? "", after !== null));
      const sources: LegacySource[] = [];
      let scanned = 0, skipped = 0, stopped = false, settled = false, next: string | null = null;
      const finish = (cause?: Error) => {
        if (settled) return;
        settled = true; clearTimeout(timeout); signal.removeEventListener("abort", abort);
        if (cause) reject(cause); else resolve({ sources, next, skipped, stopped });
      };
      const stop = (cause: Error) => {
        finish(cause);
        try { transaction.abort(); } catch { /* A completed transaction has no remaining read to abort. */ }
      };
      const abort = () => { stop(new DOMException("Recovery canceled.", "AbortError")); };
      const timeout = setTimeout(() => { stop(new Error("Old library keys did not respond. Close other tabs and retry.")); }, 5000);
      signal.addEventListener("abort", abort, { once: true });
      transaction.oncomplete = () => { finish(); };
      transaction.onerror = transaction.onabort = () => { finish(transaction.error ?? new Error("Old library keys could not be read. Close other tabs and retry.")); };
      request.onsuccess = () => {
        if (settled) return;
        const cursor = request.result;
        if (!cursor || typeof cursor.key !== "string") return;
        const source = sourceFromKey(cursor.key);
        scanned++;
        if (source) sources.push(source); else skipped++;
        if (sources.length >= PAGE_SIZE || scanned >= SCAN_LIMIT) {
          next = cursor.key.length > 0 && cursor.key.length <= 1024 ? cursor.key : null;
          stopped = next === null;
          return;
        }
        cursor.continue();
      };
    });
  } finally { database.close(); }
}

async function hasSource(key: string, signal: AbortSignal): Promise<boolean> {
  const database = await oldDatabase(signal);
  if (!database) return false;
  try {
    signal.throwIfAborted();
    return await new Promise<boolean>((resolve, reject) => {
      const transaction = database.transaction(LEGACY_STORE, "readonly");
      const request = transaction.objectStore(LEGACY_STORE).getKey(key);
      let present = false, settled = false;
      const finish = (cause?: Error) => {
        if (settled) return;
        settled = true; clearTimeout(timeout); signal.removeEventListener("abort", abort);
        if (cause) reject(cause); else resolve(present);
      };
      const stop = (cause: Error) => {
        finish(cause);
        try { transaction.abort(); } catch { /* A completed transaction has no remaining read to abort. */ }
      };
      const abort = () => { stop(new DOMException("Recovery canceled.", "AbortError")); };
      const timeout = setTimeout(() => { stop(new Error("The old library entry did not respond. Close other tabs and retry.")); }, 5000);
      signal.addEventListener("abort", abort, { once: true });
      request.onsuccess = () => { present = request.result === key; };
      transaction.oncomplete = () => { finish(); };
      transaction.onerror = transaction.onabort = () => { finish(transaction.error ?? new Error("The old library entry could not be checked.")); };
    });
  } finally { database.close(); }
}

/** The returned snapshot must still pass the current Go CDR import path. */
export async function readLegacyWav(source: LegacySource, signal: AbortSignal): Promise<{ file: File; verify: () => Promise<void> }> {
  const validated = sourceFromKey(source.key);
  if (!validated || validated.name !== source.name || validated.size !== source.size || validated.modified !== source.modified) throw new Error("The old library selection is invalid. Scan again.");
  source = validated;
  if (source.size > MAX_FILE_BYTES) throw new Error("This original exceeds the 128 MiB WAV recovery limit. Its old copy is retained.");
  if (!await hasSource(source.key, signal)) throw new Error("The old library entry changed. Scan again.");
  signal.throwIfAborted();
  const storage = (navigator as { storage?: Partial<StorageManager> }).storage;
  const getDirectory = storage?.getDirectory;
  if (typeof getDirectory !== "function") throw new Error("This browser cannot access old audio storage. Its old records are retained.");
  const root = await storageRead(() => getDirectory.call(storage), signal);
  const directory = await storageRead(() => root.getDirectoryHandle("library", { create: false }), signal);
  const handle = await storageRead(() => directory.getFileHandle(`${encodeURIComponent(source.key)}.bin`, { create: false }), signal);
  const original = await storageRead(() => handle.getFile(), signal);
  signal.throwIfAborted();
  if (original.size !== source.size || original.size < 12 || original.size > MAX_FILE_BYTES) throw new Error("The old original is missing, changed or outside the WAV recovery limit. Its records are retained.");
  const header = new Uint8Array(await storageRead(() => original.slice(0, 12).arrayBuffer(), signal));
  signal.throwIfAborted();
  if (String.fromCharCode(...header.slice(0, 4)) !== "RIFF" || String.fromCharCode(...header.slice(8, 12)) !== "WAVE") throw new Error("Codec recovery is unavailable for this original. Its old audio and settings are retained; WAV recovery does not convert compressed formats.");
  const name = `${source.name.replace(/\.[^.]+$/u, "").replace(/[/\\]/gu, "_").slice(0, 180)}.wav`;
  return {
    file: new File([original], name, { type: "audio/wav", lastModified: source.modified }),
    verify: async () => {
      signal.throwIfAborted();
      const current = await storageRead(() => handle.getFile(), signal);
      signal.throwIfAborted();
      if (current.size !== original.size || current.lastModified !== original.lastModified || !await hasSource(source.key, signal)) throw new Error("The old source changed during recovery. Scan again; its records have been retained.");
      signal.throwIfAborted();
    },
  };
}
