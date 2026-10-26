import { MAX_SOURCE_BYTES } from "./audio-limits";
const memoryAudio = new Map<string, Blob>();
const freshAssets = new Set<string>();
/** Audio assets are immutable: only this factory can issue a writable new ID. */
export function newAudioAssetId(prefix: "track" | "source" | "master"): string {
  const id = `${prefix}-${crypto.randomUUID()}`;
  freshAssets.add(id);
  return id;
}
// Fits one maximum canonical source; denied storage cannot retain an unbounded queue.
const MAX_SESSION_BYTES = MAX_SOURCE_BYTES;
type AudioSaveResult = { durable: true } | { durable: false; warning: string };


const DB_NAME = "aurialis-local";
const DB_VERSION = 2;
const AUDIO_STORE = "audio";
const PROJECTS_STORE = "projects";
const ALBUMS_STORE = "albums";
const STEMS_STORE = "stemProjects";

function hasIndexedDb(): boolean {
  return typeof globalThis !== "undefined" && "indexedDB" in globalThis;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!hasIndexedDb()) {
      reject(new Error("IndexedDB is unavailable in this environment"));
      return;
    }
    const request = globalThis.indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const storeName of [
        AUDIO_STORE,
        PROJECTS_STORE,
        ALBUMS_STORE,
        STEMS_STORE,
      ]) {
        if (!db.objectStoreNames.contains(storeName)) {
          db.createObjectStore(storeName);
        }
      }
    };
    request.onsuccess = () => {
      resolve(request.result);
    };
    request.onblocked = () => {
      reject(new Error("Browser storage is blocked by another Aurialis tab."));
    };
    request.onerror = () => {
      reject(request.error ?? new Error("Failed to open IndexedDB"));
    };
  });
}

export async function saveAudio(id: string, file: Blob, allowSession = true): Promise<AudioSaveResult> {
  if (!freshAssets.delete(id)) throw new Error("Audio assets are immutable. Create a fresh asset ID before saving.");
  try {
    const db = await openDb();
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(AUDIO_STORE, "readwrite");
        const request = transaction.objectStore(AUDIO_STORE).add(file, id);
        transaction.oncomplete = () => { resolve(); };
        transaction.onerror = transaction.onabort = () => { reject(request.error ?? transaction.error ?? new Error("Audio storage failed.")); };
      });
      memoryAudio.delete(id);
      return { durable: true };
    } finally { db.close(); }
  } catch (cause) {
    if (typeof cause === "object" && cause !== null && "name" in cause && cause.name === "ConstraintError") throw new Error("This audio asset already exists. Create a fresh asset ID.", { cause });
    const retained = Array.from(memoryAudio.entries()).reduce((total, [key, blob]) => key === id ? total : total + blob.size, 0);
    if (!allowSession || retained + file.size > MAX_SESSION_BYTES)
      throw new Error(allowSession ? "Browser storage is unavailable and the bounded session audio cache is full. Free storage or export and remove a session project before importing more audio." : "Source replacement requires browser storage. Free storage or allow access, then retry.", { cause });
    memoryAudio.set(id, file);
    return { durable: false, warning: "Audio is available only in this tab. Browser storage could not save it; export before closing or reloading." };
  }
}

export async function getAudio(id: string): Promise<Blob | undefined> {
  if (memoryAudio.has(id)) return memoryAudio.get(id);
  if (!hasIndexedDb()) return undefined;
  try {
    const db = await openDb();
    try {
      return await new Promise<Blob | undefined>((resolve, reject) => {
        const request = db
          .transaction(AUDIO_STORE, "readonly")
          .objectStore(AUDIO_STORE)
          .get(id);
        request.onsuccess = () => {
          const result: unknown = request.result;
          resolve(result instanceof Blob ? result : undefined);
        };
        request.onerror = () => {
          reject(request.error ?? new Error("Failed to read audio blob"));
        };
      });
    } finally {
      db.close();
    }
  } catch {
    return undefined;
  }
}

export async function deleteAudio(id: string): Promise<void> {
  // Assets use fresh immutable IDs; session fallback IDs were never durable.
  if (memoryAudio.has(id)) { memoryAudio.delete(id); return; }
  if (!hasIndexedDb()) {
    throw new Error("Browser storage is unavailable. The project was kept so deletion can be retried.");
  }
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(AUDIO_STORE, "readwrite");
      transaction.objectStore(AUDIO_STORE).delete(id);
      transaction.oncomplete = () => { resolve(); };
      transaction.onerror = transaction.onabort = () => { reject(transaction.error ?? new Error("Audio deletion failed. Retry before removing the project.")); };
    });
    memoryAudio.delete(id);
  } finally { db.close(); }
}

export async function storageSummary(): Promise<{ usage?: number; quota?: number; persistent: boolean | null }> {
  const manager = (globalThis.navigator as { storage?: Partial<StorageManager> }).storage;
  if (!manager) return { persistent: null };
  const estimate = await manager.estimate?.().catch(() => undefined);
  const persistent = await manager.persisted?.().catch(() => null) ?? null;
  return { ...(typeof estimate?.usage === "number" && Number.isFinite(estimate.usage) ? { usage: estimate.usage } : {}), ...(typeof estimate?.quota === "number" && Number.isFinite(estimate.quota) ? { quota: estimate.quota } : {}), persistent };
}

/** Roll back a newly staged source that has no project metadata yet. */
export async function discardStagedAudio(id: string, durable: boolean): Promise<void> {
  if (!durable) { memoryAudio.delete(id); return; }
  await deleteAudio(id);
}

/** Rendered album masters saved for one album. Audio lives in the immutable audio store. */
export type SavedAlbumMasters = { key: string; createdAt: string; files: { trackId: string; title: string; audioId: string; bytes: number }[] };

function readAlbumMasters(value: unknown): SavedAlbumMasters | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Partial<SavedAlbumMasters>;
  if (typeof record.key !== "string" || record.key.length > 65_536 || typeof record.createdAt !== "string" || !Array.isArray(record.files) || record.files.length === 0 || record.files.length > 512) return undefined;
  const files = (record.files as unknown[]).filter((file): file is SavedAlbumMasters["files"][number] => typeof file === "object" && file !== null && "trackId" in file && typeof file.trackId === "string" && "title" in file && typeof file.title === "string" && "audioId" in file && typeof file.audioId === "string" && /^master-[a-zA-Z0-9-]{1,96}$/u.test(file.audioId) && "bytes" in file && Number.isSafeInteger(file.bytes) && typeof file.bytes === "number" && file.bytes > 0);
  return files.length === record.files.length ? { key: record.key, createdAt: record.createdAt, files } : undefined;
}

async function albumRequest<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest | undefined): Promise<T | undefined> {
  const db = await openDb();
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const transaction = db.transaction(ALBUMS_STORE, mode);
      const request = run(transaction.objectStore(ALBUMS_STORE));
      transaction.oncomplete = () => { resolve(request?.result as T | undefined); };
      transaction.onerror = transaction.onabort = () => { reject(request?.error ?? transaction.error ?? new Error("Album storage failed.")); };
    });
  } finally { db.close(); }
}

/** The saved masters for an album, or undefined when none (or storage is unavailable). */
export async function loadAlbumMasters(albumId: string): Promise<SavedAlbumMasters | undefined> {
  if (!hasIndexedDb()) return undefined;
  try { return readAlbumMasters(await albumRequest<unknown>("readonly", (store) => store.get(albumId))); }
  catch { return undefined; }
}

/** Replace an album's saved masters, then delete the audio of the record it replaced. */
export async function saveAlbumMasters(albumId: string, record: SavedAlbumMasters): Promise<void> {
  const previous = await loadAlbumMasters(albumId);
  await albumRequest("readwrite", (store) => store.put(record, albumId));
  const kept = new Set(record.files.map((file) => file.audioId));
  for (const file of previous?.files ?? []) if (!kept.has(file.audioId)) await deleteAudio(file.audioId).catch(() => undefined);
}

/** Delete an album's saved masters and their audio. */
export async function deleteAlbumMasters(albumId: string): Promise<void> {
  const previous = await loadAlbumMasters(albumId);
  for (const file of previous?.files ?? []) await deleteAudio(file.audioId);
  if (hasIndexedDb()) await albumRequest("readwrite", (store) => store.delete(albumId));
}

/** Fail early, before rendering, when the browser reports too little free storage. */
export async function ensureStorageFor(bytes: number): Promise<void> {
  const { usage, quota } = await storageSummary();
  if (usage === undefined || quota === undefined) return;
  // Leave headroom for IndexedDB overhead and other writes.
  const needed = Math.ceil(bytes * 1.1) + 16 * 1024 * 1024;
  if (quota - usage < needed) {
    const mib = (value: number) => (value / 1048576).toFixed(0);
    throw new Error(`Saving these album masters needs about ${mib(needed)} MiB of browser storage, but only ${mib(Math.max(0, quota - usage))} MiB is free. Delete unused projects in the Library to free space, then render again.`);
  }
}
