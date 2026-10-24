/** Process-local owner capabilities; stored reports never enter this registry. */
export interface AlbumCleanupCapability { readonly retry: () => Promise<void> }
type Entry = { capability: AlbumCleanupCapability; status: "active" | "closing" | "required"; message: string; pending: Promise<void> | null };
const entries = new Map<string, Entry>();
export function registerAlbumCleanup(albumId: string, capability: AlbumCleanupCapability): void {
  if (!albumId || albumId.length > 1024) throw new Error("The album cleanup identifier is invalid.");
  if (entries.has(albumId)) throw new Error("This album is already owned by another tab or workspace. Finish its cleanup before starting new work.");
  if (entries.size >= 64) throw new Error("The 64 active album owner limit is reached. Finish an existing album cleanup before opening another.");
  entries.set(albumId, { capability, status: "active", message: "", pending: null });
}
export function markAlbumCleanup(albumId: string, capability: AlbumCleanupCapability, failure?: unknown): void {
  const entry = entries.get(albumId); if (entry?.capability !== capability) return;
  entry.status = failure === undefined ? "closing" : "required";
  entry.message = failure instanceof Error ? failure.message.slice(0, 512) : "Finish the previous album cleanup before rendering or downloading.";
}
export function completeAlbumCleanup(albumId: string, capability: AlbumCleanupCapability): void {
  if (entries.get(albumId)?.capability === capability) entries.delete(albumId);
}
export function albumCleanupStatus(albumId: string): Readonly<{ pending: boolean; message: string }> | null {
  const entry = entries.get(albumId); return entry ? { pending: entry.status !== "active", message: entry.message } : null;
}
/** Explicit Clear/Delete retries the exact old owner; concurrent requests share actual settlement. */
export function retryAlbumCleanup(albumId: string): Promise<void> {
  const entry = entries.get(albumId); if (!entry) return Promise.resolve();
  if (entry.pending) return entry.pending;
  entry.status = "closing";
  entry.pending = Promise.resolve().then(entry.capability.retry).then(() => {
    completeAlbumCleanup(albumId, entry.capability);
  }, (cause: unknown) => {
    markAlbumCleanup(albumId, entry.capability, cause); entry.pending = null; throw cause;
  });
  return entry.pending;
}
