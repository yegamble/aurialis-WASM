import { afterEach, describe, expect, it, vi } from "vitest";
import { albumCleanupStatus, completeAlbumCleanup, markAlbumCleanup, registerAlbumCleanup, retryAlbumCleanup, type AlbumCleanupCapability } from "../album-cleanup";
const registered: { id: string; owner: AlbumCleanupCapability }[] = [];
function add(id: string, retry = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)) { const owner = { retry }; registerAlbumCleanup(id, owner); registered.push({ id, owner }); return owner; }
function deferred() { let resolve: () => void = () => undefined; const promise = new Promise<void>((finish) => { resolve = finish; }); return { promise, resolve: () => { resolve(); } }; }
afterEach(() => { for (const { id, owner } of registered.splice(0)) completeAlbumCleanup(id, owner); });
describe("bounded process-local album cleanup capabilities", () => {
  it("reserves at most 64 slots synchronously and refuses duplicate owners", () => {
    for (let index = 0; index < 64; index++) add(`owner-${String(index)}`);
    expect(() => add("extra")).toThrow(/64/u); expect(() => add("owner-0")).toThrow(/already owned/u);
  });
  it("deduplicates concurrent retries and keeps failed cleanup discoverable until that same owner succeeds", async () => {
    const held = deferred(), retry = vi.fn<() => Promise<void>>().mockReturnValueOnce(held.promise).mockRejectedValueOnce(new Error("Retry storage failure")).mockResolvedValue(undefined), owner = add("retry", retry);
    markAlbumCleanup("retry", owner, new Error("Initial failed unmount")); const first = retryAlbumCleanup("retry"), second = retryAlbumCleanup("retry");
    expect(first).toBe(second); expect(albumCleanupStatus("retry")?.pending).toBe(true); await Promise.resolve(); expect(retry).toHaveBeenCalledOnce();
    held.resolve(); await first; expect(albumCleanupStatus("retry")).toBeNull();
    registerAlbumCleanup("retry", owner); await expect(retryAlbumCleanup("retry")).rejects.toThrow(/storage failure/u); expect(albumCleanupStatus("retry")).toEqual({ pending: true, message: "Retry storage failure" });
    await retryAlbumCleanup("retry"); expect(albumCleanupStatus("retry")).toBeNull();
  });
  it("does not let stale success or failure callbacks remove or relabel a newer owner", async () => {
    const held = deferred(), old = add("cas", vi.fn().mockReturnValue(held.promise)), pending = retryAlbumCleanup("cas");
    await Promise.resolve(); completeAlbumCleanup("cas", old); const current = add("cas");
    markAlbumCleanup("cas", old, new Error("Stale failure")); held.resolve(); await pending;
    expect(albumCleanupStatus("cas")).toEqual({ pending: false, message: "" }); completeAlbumCleanup("cas", old); expect(albumCleanupStatus("cas")).not.toBeNull();
    completeAlbumCleanup("cas", current); expect(albumCleanupStatus("cas")).toBeNull();
  });
});
