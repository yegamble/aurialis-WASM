const memoryAudio = new Map<string, Blob>();
// Fits one maximum canonical source; denied storage cannot retain an unbounded queue.
const MAX_SESSION_BYTES = 128 * 1024 * 1024 + 44;
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
  try {
    const db = await openDb();
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(AUDIO_STORE, "readwrite");
        transaction.objectStore(AUDIO_STORE).put(file, id);
        transaction.oncomplete = () => { resolve(); };
        transaction.onerror = transaction.onabort = () => { reject(transaction.error ?? new Error("Audio storage failed.")); };
      });
      memoryAudio.delete(id);
      return { durable: true };
    } finally { db.close(); }
  } catch (cause) {
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
