const DB_NAME = "aurialis-local"
const DB_VERSION = 2
const AUDIO_STORE = "audio"
const PROJECTS_STORE = "projects"
const ALBUMS_STORE = "albums"
const STEMS_STORE = "stemProjects"

function hasIndexedDb(): boolean {
  return typeof globalThis !== "undefined" && "indexedDB" in globalThis
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!hasIndexedDb()) {
      reject(new Error("IndexedDB is unavailable in this environment"))
      return
    }
    const request = globalThis.indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      const db = request.result
      for (const storeName of [
        AUDIO_STORE,
        PROJECTS_STORE,
        ALBUMS_STORE,
        STEMS_STORE,
      ]) {
        if (!db.objectStoreNames.contains(storeName)) {
          db.createObjectStore(storeName)
        }
      }
    }
    request.onsuccess = () => {
      resolve(request.result)
    }
    request.onerror = () => {
      reject(request.error ?? new Error("Failed to open IndexedDB"))
    }
  })
}

export async function saveAudio(id: string, file: Blob): Promise<void> {
  if (!hasIndexedDb()) return
  const db = await openDb()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(AUDIO_STORE, "readwrite")
      transaction.objectStore(AUDIO_STORE).put(file, id)
      transaction.oncomplete = () => {
        resolve()
      }
      transaction.onerror = () => {
        reject(transaction.error ?? new Error("Failed to store audio blob"))
      }
    })
  } finally {
    db.close()
  }
}

export async function getAudio(id: string): Promise<Blob | undefined> {
  if (!hasIndexedDb()) return undefined
  try {
    const db = await openDb()
    try {
      return await new Promise<Blob | undefined>((resolve, reject) => {
        const request = db
          .transaction(AUDIO_STORE, "readonly")
          .objectStore(AUDIO_STORE)
          .get(id)
        request.onsuccess = () => {
          const result: unknown = request.result
          resolve(result instanceof Blob ? result : undefined)
        }
        request.onerror = () => {
          reject(request.error ?? new Error("Failed to read audio blob"))
        }
      })
    } finally {
      db.close()
    }
  } catch {
    return undefined
  }
}

export async function deleteAudio(id: string): Promise<void> {
  if (!hasIndexedDb()) return
  try {
    const db = await openDb()
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction(AUDIO_STORE, "readwrite")
        transaction.objectStore(AUDIO_STORE).delete(id)
        transaction.oncomplete = () => {
          resolve()
        }
        transaction.onerror = () => {
          reject(transaction.error ?? new Error("Failed to delete audio blob"))
        }
      })
    } finally {
      db.close()
    }
  } catch {
    // Ignore cleanup errors if IndexedDB is blocked
  }
}
