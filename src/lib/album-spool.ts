/** Device-local encoded masters. This store never contains original uploads or settings. */
export const maximumAlbumSpoolBytes = 64 * (44 + 16_777_216 * 6);
const databaseName = "aurialis-album-spool-v1", runsStore = "runs", outputStore = "outputs", budgetKey = "budget";
const maximumMetadataBytes = 256 * 1024;
export interface AlbumSpoolRecipe {
  albumId: string; bindingHash: string; processingBuild: string; planHash: string; expectedBytes: number; totalTracks: number;
}
export interface AlbumSpoolOutput { index: number; assetId: string; sha256: string; sampleRate: number; frames: number; bytes: number }
interface Manifest extends AlbumSpoolRecipe {
  version: 1; runId: string; owner: string; revision: number; reserved: number;
  prefix: AlbumSpoolOutput[]; pending: AlbumSpoolOutput | null;
}
interface Budget { version: 1; bytes: number; reserved: number; runs: number }
const emptyBudget = (): Budget => ({ version: 1, bytes: 0, reserved: 0, runs: 0 });
function whole(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function hash(value: unknown): value is string { return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value); }
function object(value: unknown): Record<string, unknown> | null { return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function recipeValid(value: AlbumSpoolRecipe) {
  if (typeof value.albumId !== "string" || !value.albumId || value.albumId.length > 1024 || !hash(value.bindingHash) || !hash(value.planHash)) throw new Error("The album spool recipe is invalid.");
  if (!hash(value.processingBuild)) throw new Error("A qualified processing build is required for stored album continuation.");
  if (!whole(value.totalTracks) || value.totalTracks < 1 || value.totalTracks > 64) throw new Error("Choose between one and 64 album tracks.");
  if (!whole(value.expectedBytes) || value.expectedBytes < value.totalTracks * 50 || value.expectedBytes > maximumAlbumSpoolBytes) throw new Error("This album exceeds the encoded disk limit.");
}
function outputValid(value: unknown, runId: string, index: number): value is AlbumSpoolOutput {
  const row = object(value);
  return !!row && Object.keys(row).length === 6 && row.index === index && typeof row.assetId === "string"
    && row.assetId.startsWith(`${runId}:`) && /^[a-f0-9-]{36}$/u.test(row.assetId.slice(runId.length + 1)) && hash(row.sha256)
    && whole(row.sampleRate) && row.sampleRate >= 8000 && row.sampleRate <= 192000
    && whole(row.frames) && row.frames >= 1 && row.frames <= 16_777_216 && row.bytes === 44 + row.frames * 6;
}
function checkedManifest(value: unknown): Manifest {
  const row = object(value);
  if (!row || Object.keys(row).length !== 13 || row.version !== 1 || typeof row.runId !== "string" || !/^[a-f0-9-]{36}$/u.test(row.runId)
    || typeof row.owner !== "string" || !/^[a-f0-9-]{36}$/u.test(row.owner) || !whole(row.revision) || !whole(row.reserved)
    || !Array.isArray(row.prefix) || row.prefix.length > 64 || !row.prefix.every((entry: unknown, index) => outputValid(entry, row.runId as string, index))
    || !(row.pending === null || outputValid(row.pending, row.runId, row.prefix.length))) throw new Error("Stored album metadata is invalid. No stored output was authorized.");
  const manifest = row as unknown as Manifest; recipeValid(manifest);
  const ids = [...manifest.prefix, ...(manifest.pending ? [manifest.pending] : [])].map((entry) => entry.assetId);
  if (new Set(ids).size !== ids.length || manifest.prefix.length + (manifest.pending ? 1 : 0) > manifest.totalTracks
    || committedBytes(manifest) + manifest.reserved > manifest.expectedBytes || new TextEncoder().encode(JSON.stringify(manifest)).byteLength > maximumMetadataBytes)
    throw new Error("Stored album metadata exceeds its bounds.");
  return manifest;
}
function checkedBudget(value: unknown): Budget {
  if (value === undefined) return emptyBudget();
  const row = object(value);
  if (!row || Object.keys(row).length !== 4 || row.version !== 1 || !whole(row.bytes) || !whole(row.reserved) || !whole(row.runs)
    || row.runs > 64 || row.bytes + row.reserved > maximumAlbumSpoolBytes) throw new Error("Stored album disk accounting is invalid.");
  return row as unknown as Budget;
}
function committedBytes(manifest: Manifest): number { return manifest.prefix.reduce((total, row) => total + row.bytes, manifest.pending?.bytes ?? 0); }
function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") { reject(new Error("Browser storage is required for album masters.")); return; }
    const request = indexedDB.open(databaseName, 1);
    let settled = false;
    request.onupgradeneeded = () => { request.result.createObjectStore(runsStore); request.result.createObjectStore(outputStore); };
    request.onerror = () => { settled = true; reject(request.error ?? new Error("Album storage could not be opened.")); };
    request.onblocked = () => { settled = true; reject(new Error("Album storage is blocked by another tab.")); };
    request.onsuccess = () => { if (settled) { request.result.close(); return; } settled = true; request.result.onversionchange = () => { request.result.close(); }; resolve(request.result); };
  });
}
/** Lock ownership outlives the view while its queued native browser operations settle. */
async function albumLock(albumId: string): Promise<() => Promise<void>> {
  if (typeof navigator === "undefined" || !("locks" in navigator)) throw new Error("This browser cannot own stored album jobs. Export tracks individually.");
  let release = () => { /* Assigned synchronously by the promise executor. */ };
  const held = new Promise<void>((complete) => { release = complete; });
  return new Promise((resolve, reject) => {
    const settled = navigator.locks.request(`aurialis-album:${albumId}`, { ifAvailable: true }, async (lock) => {
      if (!lock) { reject(new Error("This album is owned by another tab. Close its album workspace and retry.")); return; }
      resolve(async () => { release(); await settled; }); await held;
    });
    void settled.catch(reject);
  });
}
type Change = (manifest: Manifest | null, budget: Budget, outputs: IDBObjectStore) => { manifest: Manifest | null; budget: Budget };

/** Metadata-only session; callers must verify PCM/recipe authority before using a recovered prefix. */
export class AlbumSpool {
  private manifest: Manifest | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private closing = false;
  private closePromise: Promise<void> | null = null;
  private constructor(private readonly albumId: string, private readonly releaseLock: () => Promise<void>) {}
  static async open(recipe: AlbumSpoolRecipe): Promise<AlbumSpool> {
    recipeValid(recipe);
    const release = await albumLock(recipe.albumId), spool = new AlbumSpool(recipe.albumId, release);
    try {
      await spool.change((previous, budget, outputs) => {
        if (previous && ["bindingHash", "processingBuild", "planHash", "expectedBytes", "totalTracks"].some((key) => previous[key as keyof AlbumSpoolRecipe] !== recipe[key as keyof AlbumSpoolRecipe])) throw new Error("Stored masters belong to a different sequence, plan or processing build. Clear that stored run before rendering again.");
        let manifest = previous;
        if (!manifest) {
          if (budget.runs >= 64) throw new Error("The 64 stored album run limit is reached. Clear an older run first.");
          manifest = { ...recipe, version: 1, runId: crypto.randomUUID(), owner: crypto.randomUUID(), revision: 0, reserved: 0, prefix: [], pending: null };
          budget.runs++;
        }
        if (manifest.pending) { outputs.delete([manifest.albumId, manifest.pending.assetId]); budget.bytes -= manifest.pending.bytes; manifest = { ...manifest, pending: null }; }
        const reserved = recipe.expectedBytes - committedBytes(manifest), extra = reserved - manifest.reserved;
        if (budget.bytes + budget.reserved + extra > maximumAlbumSpoolBytes) throw new Error("Stored album demand exceeds the encoded disk limit. Clear an older run first.");
        budget.reserved += extra;
        return { manifest: { ...manifest, owner: crypto.randomUUID(), revision: manifest.revision + 1, reserved }, budget };
      }, false);
      return spool;
    } catch (cause) { await release(); throw cause; }
  }
  /** Explicit cleanup can own an obsolete recipe, but only within this album's namespace. */
  static async clearStored(albumId: string): Promise<void> {
    if (typeof albumId !== "string" || !albumId || albumId.length > 1024) throw new Error("The album identifier is invalid.");
    const release = await albumLock(albumId), spool = new AlbumSpool(albumId, release);
    try {
      await spool.change((manifest, budget) => ({ manifest: manifest ? { ...manifest, owner: crypto.randomUUID(), revision: manifest.revision + 1 } : null, budget }), false);
      if (spool.manifest) await spool.clear(); else await release();
    } catch (cause) { await release(); throw cause; }
  }
  prefix(): readonly AlbumSpoolOutput[] { return this.manifest?.prefix.map((row) => ({ ...row })) ?? []; }
  private schedule<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new Error("The album spool owner is closed."));
    const result = this.queue.then(operation); this.queue = result.catch(() => undefined); return result;
  }
  private async change(transform: Change, requireOwner = true): Promise<void> {
    const database = await openDatabase();
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction([runsStore, outputStore], "readwrite"), runs = transaction.objectStore(runsStore);
        const selected = runs.get(`album:${this.albumId}`), accounting = runs.get(budgetKey);
        let selectedReady = false, budgetReady = false, next: Manifest | null = null, failure: unknown;
        const apply = () => {
          if (!selectedReady || !budgetReady) return;
          try {
            const previous = selected.result === undefined ? null : checkedManifest(selected.result), budget = checkedBudget(accounting.result);
            if (previous && previous.albumId !== this.albumId) throw new Error("Stored album ownership belongs to another album.");
            if (requireOwner && (!previous || !this.manifest || previous.runId !== this.manifest.runId || previous.owner !== this.manifest.owner || previous.revision !== this.manifest.revision)) throw new Error("The album spool ownership changed. No stored output was modified.");
            const result = transform(previous, { ...budget }, transaction.objectStore(outputStore));
            next = result.manifest ? checkedManifest(result.manifest) : null; checkedBudget(result.budget);
            if (next) runs.put(next, `album:${this.albumId}`); else runs.delete(`album:${this.albumId}`);
            runs.put(result.budget, budgetKey);
          } catch (cause) { failure = cause; transaction.abort(); }
        };
        selected.onsuccess = () => { selectedReady = true; apply(); }; accounting.onsuccess = () => { budgetReady = true; apply(); };
        transaction.oncomplete = () => { this.manifest = next; resolve(); };
        transaction.onerror = transaction.onabort = () => { reject(failure instanceof Error || failure instanceof DOMException ? failure : transaction.error ?? new Error("Album storage did not commit.")); };
      });
    } finally { database.close(); }
  }
  stage(wav: Blob, layout: Omit<AlbumSpoolOutput, "assetId" | "bytes">, signal: AbortSignal): Promise<AlbumSpoolOutput> {
    return this.schedule(async () => {
      signal.throwIfAborted(); const current = this.manifest;
      if (!current || current.pending || layout.index !== current.prefix.length || layout.index >= current.totalTracks) throw new Error("The pending album output is out of sequence.");
      const row = { ...layout, assetId: `${current.runId}:${crypto.randomUUID()}`, bytes: wav.size };
      if (!outputValid(row, current.runId, layout.index)) throw new Error("The stored master has an unexpected length or layout.");
      await this.change((manifest, budget, outputs) => {
        if (!manifest || manifest.reserved < wav.size) throw new Error("The album output exceeds its reserved disk demand.");
        outputs.add(wav, [manifest.albumId, row.assetId]); budget.bytes += wav.size; budget.reserved -= wav.size;
        return { manifest: { ...manifest, pending: row, reserved: manifest.reserved - wav.size, revision: manifest.revision + 1 }, budget };
      });
      return { ...row };
    });
  }
  promote(assetId: string, signal: AbortSignal): Promise<void> {
    return this.schedule(async () => {
      signal.throwIfAborted();
      await this.change((manifest, budget) => {
        if (!manifest?.pending || manifest.pending.assetId !== assetId) throw new Error("The pending stored master is unavailable.");
        const prefix = [...manifest.prefix, manifest.pending];
        if (prefix.length === manifest.totalTracks && prefix.reduce((sum, row) => sum + row.bytes, 0) !== manifest.expectedBytes) throw new Error("The completed album length differs from its plan.");
        return { manifest: { ...manifest, prefix, pending: null, revision: manifest.revision + 1 }, budget };
      });
    });
  }
  /** Caller admits load/hash bytes first and keeps consume pending through object-URL revocation. */
  withOutput<T>(row: AlbumSpoolOutput, signal: AbortSignal, consume: (blob: Blob) => Promise<T>): Promise<T> {
    return this.schedule(async () => {
      signal.throwIfAborted();
      if (!this.manifest || ![...this.manifest.prefix, ...(this.manifest.pending ? [this.manifest.pending] : [])].some((entry) => JSON.stringify(entry) === JSON.stringify(row))) throw new Error("This stored output is not owned by the album run.");
      const database = await openDatabase();
      try {
        const blob = await new Promise<unknown>((resolve, reject) => {
          const transaction = database.transaction(outputStore, "readonly"), request = transaction.objectStore(outputStore).get([this.albumId, row.assetId]);
          transaction.oncomplete = () => { resolve(request.result as unknown); };
          transaction.onerror = transaction.onabort = () => { reject(transaction.error ?? new Error("Stored album output could not be loaded.")); };
        });
        signal.throwIfAborted();
        if (!(blob instanceof Blob) || blob.size !== row.bytes) throw new Error("The stored master is missing or has an unexpected length. Verify and render this sequence again.");
        return await consume(blob);
      } finally { database.close(); }
    });
  }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.closePromise = this.queue.then(async () => {
      if (!this.manifest) return;
      await this.change((manifest, budget, outputs) => {
        if (!manifest) throw new Error("The stored album is unavailable.");
        if (manifest.pending) { outputs.delete([manifest.albumId, manifest.pending.assetId]); budget.bytes -= manifest.pending.bytes; }
        budget.reserved -= manifest.reserved;
        if (!manifest.prefix.length) { budget.runs--; return { manifest: null, budget }; }
        return { manifest: { ...manifest, pending: null, reserved: 0, revision: manifest.revision + 1 }, budget };
      });
    }).finally(this.releaseLock);
    return this.closePromise;
  }
  clear(): Promise<void> {
    if (this.closing) return Promise.reject(new Error("The album spool owner is closed."));
    this.closing = true;
    this.closePromise = this.queue.then(async () => {
      await this.change((manifest, budget, outputs) => {
        if (!manifest) throw new Error("The stored album is unavailable.");
        for (const row of [...manifest.prefix, ...(manifest.pending ? [manifest.pending] : [])]) outputs.delete([manifest.albumId, row.assetId]);
        budget.bytes -= committedBytes(manifest); budget.reserved -= manifest.reserved; budget.runs--;
        return { manifest: null, budget };
      });
    }).finally(this.releaseLock);
    return this.closePromise;
  }
}
