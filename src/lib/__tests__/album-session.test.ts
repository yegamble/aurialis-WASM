import { Blob as NativeBlob } from "node:buffer";
import { webcrypto } from "node:crypto";
import { IDBFactory, IDBObjectStore, IDBDatabase } from "fake-indexeddb";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { albumCleanupStatus, retryAlbumCleanup } from "../album-cleanup";
import { AlbumBatch, readAlbumReport, downloadAlbumReport } from "../album-batch";
import { AlbumSpool, maximumAlbumSpoolBytes } from "../album-spool";
import { renderAlbumTrack, measureAlbumTrack, verifyAlbumTrackSource } from "../album-render";
import { qualifyProcessingBuild } from "../processing-build";
import { inspectEncodedWAV } from "../encoded-inspection";
import { downloadLocalBlobAndWait } from "../download";
import type { OwnedAudioResult } from "../browser-jobs";
import type { Album, MeasuredAudioMetrics } from "../types";
import { testStore } from "./fixtures";
vi.mock("../album-render", async (original) => ({ ...await original<typeof import("../album-render")>(), renderAlbumTrack: vi.fn(), measureAlbumTrack: vi.fn(), verifyAlbumTrackSource: vi.fn() }));
vi.mock("../processing-build", () => ({ qualifyProcessingBuild: vi.fn() }));
vi.mock("../download", () => ({ downloadLocalBlobAndWait: vi.fn() }));
const build = "a".repeat(64), frames = 24000, sampleRate = 48000, encodedBytes = 44 + frames * 6;
const source = { frames, sampleRate, pcmHash: "b".repeat(64) };
const metrics: MeasuredAudioMetrics = { integratedLufs: -18, shortTermLufs: -18, truePeakDbtp: -6, samplePeakDbfs: -6, dynamicRangeDb: 12, correlation: 1, lowBassCorrelation: 1, dcLeftDbfs: -120, dcRightDbfs: -120, clippingSamples: 0, gainReductionDb: 0 };
const edges = [20, 120, 500, 2000, 6000, 20000], bands = edges.slice(0, -1).map((lowHz, index) => ({ lowHz, highHz: edges.at(index + 1) ?? 0, usableHighHz: edges.at(index + 1) ?? 0, powerDb: -20, valid: true }));
function wav24(value = 100) {
  const buffer = new ArrayBuffer(encodedBytes), view = new DataView(buffer), label = (offset: number, text: string) => { for (let index = 0; index < text.length; index++) view.setUint8(offset + index, text.charCodeAt(index)); };
  label(0, "RIFF"); view.setUint32(4, encodedBytes - 8, true); label(8, "WAVE"); label(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 2, true); view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 6, true); view.setUint16(32, 6, true); view.setUint16(34, 24, true); label(36, "data"); view.setUint32(40, encodedBytes - 44, true);
  for (let offset = 44; offset < encodedBytes; offset += 3) view.setUint8(offset, value);
  return new Blob([buffer]);
}
function memory() {
  let limit = 512 * 1024 * 1024;
  const owners: { bytes: number; disposed: boolean }[] = [], total = () => owners.reduce((sum, owner) => sum + owner.bytes, 0);
  return { owners, total, setLimit(bytes: number) { limit = bytes; }, reserve: (bytes: number) => {
    const owner = { bytes: 0, disposed: false }, update = (next: number) => { if (owner.disposed || next + total() - owner.bytes > limit) throw new Error("Controlled memory admission"); owner.bytes = next; };
    update(bytes); owners.push(owner); return { update, dispose: () => { owner.bytes = 0; owner.disposed = true; } };
  } };
}
function locks() { const held = new Set<string>(); return { request: async (name: string, _options: unknown, consume: (lock: { name: string } | null) => Promise<void>) => { if (held.has(name)) return consume(null); held.add(name); try { await consume({ name }); } finally { held.delete(name); } } }; }
function fixture() {
  const tracks = testStore.tracks.map((track, index) => ({ ...structuredClone(track), id: `song-${String(index)}`, sourceAudioId: `source-${String(index)}`, sourceIdentity: { ...source }, sampleRate, duration: frames / sampleRate, sourceRevision: 1 }));
  const album: Album = { id: "local-album", title: "Local sequence", artist: "Artist", target: "−14 LUFS", trackIds: tracks.map((track) => track.id), mastered: false, gainMode: "relationships", offsets: {} };
  return { album, tracks };
}
const batches: AlbumBatch[] = [], spools: AlbumSpool[] = [];
function create(owned = memory()) { const input = fixture(), batch = new AlbumBatch(input.album, input.tracks, owned.reserve); batches.push(batch); return { ...input, batch, owned }; }
function deferred<T>() { let resolve: ((value: T) => void) | undefined; const promise = new Promise<T>((finish) => { resolve = finish; }); return { promise, resolve(value: T) { if (!resolve) throw new Error("Missing resolver"); resolve(value); } }; }
beforeEach(() => {
  vi.stubGlobal("Blob", NativeBlob); vi.stubGlobal("crypto", webcrypto); vi.stubGlobal("indexedDB", new IDBFactory()); vi.stubGlobal("navigator", { locks: locks() });
  vi.mocked(qualifyProcessingBuild).mockResolvedValue(build); vi.mocked(verifyAlbumTrackSource).mockResolvedValue(undefined); vi.mocked(downloadLocalBlobAndWait).mockResolvedValue(undefined);
  vi.mocked(measureAlbumTrack).mockResolvedValue({ frames, sampleRate, duration: frames / sampleRate, beforeMetrics: metrics, afterMetrics: metrics });
  // Controller fixtures: actual WAV layout/hash inspection, with DSP measurements qualified separately.
  vi.mocked(renderAlbumTrack).mockImplementation(async (_recipe, _gain, ctx) => {
    const blob = wav24(), owner = ctx.reserve(blob.size), output = await inspectEncodedWAV(blob, 24, source, ctx.signal);
    return { master: { blob, owner, dispose: owner.dispose }, output, metrics, bands };
  });
});
afterEach(async () => { for (const batch of batches.splice(0)) await batch.dispose().catch(() => undefined); for (const spool of spools.splice(0)) await spool.close().catch(() => undefined); vi.restoreAllMocks(); vi.resetAllMocks(); vi.unstubAllGlobals(); });
describe("device-local Album batch delivery", () => {
  it("plans the whole cohort first and retains metadata descriptors rather than an aggregate Blob cache", async () => {
    const { batch, tracks, owned } = create(), input = structuredClone(tracks), render = vi.mocked(renderAlbumTrack).getMockImplementation();
    vi.mocked(renderAlbumTrack).mockImplementation((...args) => { expect(measureAlbumTrack).toHaveBeenCalledTimes(tracks.length); if (!render) throw new Error("Missing renderer"); return render(...args); });
    const report = await batch.run(() => true, () => undefined);
    expect(report.complete).toBe(true); expect(readAlbumReport(report)).toEqual(report); expect(batch.getFiles()).toHaveLength(tracks.length);
    expect(batch.getFiles().every((file) => !("wav" in file) && !("blob" in file))).toBe(true); expect(tracks).toEqual(input);
    expect(owned.owners.filter((owner) => !owner.disposed).every((owner) => owner.bytes !== encodedBytes)).toBe(true);
    await batch.dispose(); expect(owned.total()).toBe(0);
  });
  it("keeps the album lock through a canceled late phase even though that phase runs outside the storage queue", async () => {
    const { batch, owned } = create(), late = deferred<Awaited<ReturnType<typeof renderAlbumTrack>>>(), render = vi.mocked(renderAlbumTrack).getMockImplementation();
    vi.mocked(renderAlbumTrack).mockImplementationOnce((...args) => { if (!render) throw new Error("Missing renderer"); return render(...args); }).mockReturnValueOnce(late.promise);
    const pending = batch.run(() => true, () => undefined), rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => { expect(renderAlbumTrack).toHaveBeenCalledTimes(2); });
    const cleanup = vi.spyOn(AlbumSpool.prototype, "clear"), closing = batch.dispose(true), earlyCleanup = cleanup.mock.calls.length > 0; expect(batch.getFiles()).toEqual([]);
    let competed = true; await navigator.locks.request("aurialis-album:local-album", { ifAvailable: true }, (lock) => { competed = lock !== null; });
    const blob = wav24(), owner = owned.reserve(blob.size), master: OwnedAudioResult = { blob, owner, dispose: owner.dispose }, output = await inspectEncodedWAV(blob, 24, source, new AbortController().signal);
    late.resolve({ master, output, metrics, bands }); await rejected; await closing; expect(owned.total()).toBe(0); expect(competed).toBe(false); expect(earlyCleanup).toBe(false);
    const next = await AlbumSpool.claim("local-album"); spools.push(next); expect(next.prefix()).toEqual([]);
  });
  it("keeps a canceled verified prefix while releasing unused disk demand and re-admits the rest before retry", async () => {
    const { batch } = create();
    await expect(batch.run(() => true, (value) => { if (value.completed === 1) batch.cancel(); })).rejects.toMatchObject({ name: "AbortError" });
    expect(batch.getFiles()).toHaveLength(1); await expect(AlbumSpool.claim("local-album")).rejects.toThrow(/another tab/u);
    const other = await AlbumSpool.open({ albumId: "other", bindingHash: "c".repeat(64), processingBuild: build, planHash: "d".repeat(64), totalTracks: 64, expectedBytes: maximumAlbumSpoolBytes - encodedBytes }); spools.push(other);
    await expect(batch.run(() => true, () => undefined)).rejects.toThrow(/disk limit/u); expect(batch.getFiles()).toHaveLength(1); expect(renderAlbumTrack).toHaveBeenCalledTimes(1);
    await other.close(); const report = await batch.run(() => true, () => undefined); expect(report.complete).toBe(true); expect(renderAlbumTrack).toHaveBeenCalledTimes(2);
  });
  it("rerenders every reloaded prefix file before any persisted row becomes current output authority", async () => {
    const original = create(); await original.batch.run(() => true, () => undefined); await original.batch.dispose();
    const recovered = new AlbumBatch(original.album, original.tracks, original.owned.reserve); batches.push(recovered); expect(recovered.getReport()).toBeNull(); expect(recovered.getFiles()).toEqual([]);
    vi.mocked(renderAlbumTrack).mockClear(); const render = vi.mocked(renderAlbumTrack).getMockImplementation(), late = deferred<Awaited<ReturnType<typeof renderAlbumTrack>>>();
    vi.mocked(renderAlbumTrack).mockImplementationOnce((...args) => { if (!render) throw new Error("Missing renderer"); return render(...args); }).mockReturnValueOnce(late.promise);
    const pending = recovered.run(() => true, () => undefined); await vi.waitFor(() => { expect(renderAlbumTrack).toHaveBeenCalledTimes(2); });
    expect(recovered.getFiles()).toEqual([]); expect(recovered.getReport()).toBeNull();
    const ctx = vi.mocked(renderAlbumTrack).mock.calls[1]?.[2], recipe = vi.mocked(renderAlbumTrack).mock.calls[1]?.[0]; if (!ctx || !recipe || !render) throw new Error("Missing recovery context");
    late.resolve(await render(recipe, 0, ctx)); const report = await pending; expect(report.complete).toBe(true); expect(recovered.getFiles()).toHaveLength(2);
  });
  it("drops every recovered authority if the newly rendered bytes differ from the stored prefix", async () => {
    const original = create(); await original.batch.run(() => true, () => undefined); await original.batch.dispose();
    const recovered = new AlbumBatch(original.album, original.tracks, original.owned.reserve); batches.push(recovered);
    vi.mocked(renderAlbumTrack).mockImplementation(async (_recipe, _gain, ctx) => { const blob = wav24(101), owner = ctx.reserve(blob.size); return { master: { blob, owner, dispose: owner.dispose }, output: await inspectEncodedWAV(blob, 24, source, ctx.signal), metrics, bands }; });
    await expect(recovered.run(() => true, () => undefined)).rejects.toThrow(/stored|match/u); expect(recovered.getReport()).toBeNull(); expect(recovered.getFiles()).toEqual([]); expect(recovered.canResume()).toBe(false);
  });
  it("claims load/hash memory before storage reads and holds the album lock through download URL cleanup", async () => {
    const { batch, owned } = create(); await batch.run(() => true, () => undefined);
    const baseline = owned.total(), read = vi.spyOn(AlbumSpool.prototype, "withOutput"); const held = deferred<undefined>(); vi.mocked(downloadLocalBlobAndWait).mockReturnValue(held.promise);
    owned.setLimit(baseline + encodedBytes * 3 - 1); await expect(batch.download(0, () => true)).rejects.toThrow(/memory/u); expect(read).not.toHaveBeenCalled(); expect(batch.getFiles()).toHaveLength(2);
    expect(batch.canResume()).toBe(true);
    owned.setLimit(512 * 1024 * 1024); let verified = 0;
    vi.mocked(verifyAlbumTrackSource).mockImplementation(() => { verified++; if (verified === batch.getFiles().length) owned.setLimit(baseline + encodedBytes * 3 - 1); return Promise.resolve(undefined); });
    await expect(batch.download(0, () => true)).rejects.toThrow(/memory/u); expect(read).not.toHaveBeenCalled(); expect(batch.getFiles()).toHaveLength(2);
    vi.mocked(verifyAlbumTrackSource).mockResolvedValue(undefined); owned.setLimit(512 * 1024 * 1024); const pending = batch.download(0, () => true), rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => { expect(downloadLocalBlobAndWait).toHaveBeenCalledOnce(); }); expect(owned.total()).toBe(baseline + encodedBytes);
    const closing = batch.dispose(); await expect(AlbumSpool.claim("local-album")).rejects.toThrow(/another tab/u);
    held.resolve(undefined); await rejected; await closing; expect(owned.total()).toBe(0);
  });
  it("holds early ownership through a canceled first-pass phase before the spool is bound", async () => {
    const { batch, owned } = create(), held = deferred<Awaited<ReturnType<typeof measureAlbumTrack>>>(); vi.mocked(measureAlbumTrack).mockReturnValueOnce(held.promise);
    const pending = batch.run(() => true, () => undefined), rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => { expect(measureAlbumTrack).toHaveBeenCalledOnce(); }); const closing = batch.dispose();
    await expect(AlbumSpool.claim("local-album")).rejects.toThrow(/another tab/u); expect(owned.total()).toBeGreaterThan(32 * 1024 * 1024);
    held.resolve({ frames, sampleRate, duration: frames / sampleRate, beforeMetrics: metrics, afterMetrics: metrics }); await rejected; await closing; expect(owned.total()).toBe(0);
    const next = await AlbumSpool.claim("local-album"); spools.push(next);
  });
  it("restores no partial authority when persisted-prefix recovery is canceled halfway", async () => {
    const original = create(); await original.batch.run(() => true, () => undefined); await original.batch.dispose();
    const recovered = new AlbumBatch(original.album, original.tracks, original.owned.reserve); batches.push(recovered);
    const render = vi.mocked(renderAlbumTrack).getMockImplementation(), held = deferred<Awaited<ReturnType<typeof renderAlbumTrack>>>(); if (!render) throw new Error("Missing renderer");
    vi.mocked(renderAlbumTrack).mockClear().mockImplementationOnce(render).mockReturnValueOnce(held.promise);
    const pending = recovered.run(() => true, () => undefined), rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => { expect(renderAlbumTrack).toHaveBeenCalledTimes(2); }); recovered.cancel();
    const args = vi.mocked(renderAlbumTrack).mock.calls[1]; if (!args) throw new Error("Missing recovery phase");
    const owner = original.owned.reserve(encodedBytes), blob = wav24(), output = await inspectEncodedWAV(blob, 24, source, new AbortController().signal);
    held.resolve({ master: { blob, owner, dispose: owner.dispose }, output, metrics, bands }); await rejected;
    expect(recovered.getFiles()).toEqual([]); expect(recovered.getReport()).toBeNull(); await expect(recovered.download(0, () => true)).rejects.toThrow(/Render and verify/u);
    vi.mocked(renderAlbumTrack).mockImplementation(render); await recovered.run(() => true, () => undefined); expect(recovered.getFiles()).toHaveLength(2);
  });
  it("blocks new work after failed pending cleanup and retries that exact owner before resuming", async () => {
    const { batch, owned } = create(), read = Reflect.get(AlbumSpool.prototype, "withOutput"), loading = vi.spyOn(AlbumSpool.prototype, "withOutput");
    loading.mockImplementation(function (this: AlbumSpool, row, signal, consume) {
      if (row.index === 1) return Promise.reject(new Error("Controlled pending read back failure")); return read.call(this, row, signal, consume);
    });
    vi.spyOn(AlbumSpool.prototype, "pause").mockRejectedValueOnce(new Error("Controlled quota cleanup failure"));
    await expect(batch.run(() => true, () => undefined)).rejects.toThrow(/cleanup failed/u); expect(batch.getFiles()).toHaveLength(1);
    await expect(batch.download(0, () => true)).rejects.toThrow(/cleanup/u); expect(downloadLocalBlobAndWait).not.toHaveBeenCalled();
    await expect(AlbumSpool.open({ albumId: "other", bindingHash: "c".repeat(64), processingBuild: build, planHash: "d".repeat(64), totalTracks: 64, expectedBytes: maximumAlbumSpoolBytes - encodedBytes })).rejects.toThrow(/disk limit/u);
    loading.mockRestore(); const report = await batch.run(() => true, () => undefined); expect(report.complete).toBe(true); expect(renderAlbumTrack).toHaveBeenCalledTimes(3);
    await batch.dispose(); expect(owned.total()).toBe(0);
  });
  it("keeps a failed terminal clear registered with its charged owner until explicit retry really unlocks it", async () => {
    const { batch, owned } = create(); await batch.run(() => true, () => undefined);
    vi.spyOn(IDBObjectStore.prototype, "delete").mockImplementationOnce(() => { throw new DOMException("Terminal cleanup denied", "UnknownError"); });
    await expect(batch.dispose(true)).rejects.toThrow(/Terminal cleanup denied/u); expect(batch.canResume()).toBe(false); expect(batch.getFiles()).toEqual([]); expect(owned.total()).toBeGreaterThan(0);
    let available = true; await navigator.locks.request("aurialis-album:local-album", { ifAvailable: true }, (lock) => { available = lock !== null; }); expect(available).toBe(false);
    expect(albumCleanupStatus("local-album")?.pending).toBe(true); await retryAlbumCleanup("local-album"); expect(albumCleanupStatus("local-album")).toBeNull(); expect(owned.total()).toBe(0);
    const next = await AlbumSpool.claim("local-album"); spools.push(next);
  });
  it("escalates an in-flight prefix-preserving close to full discard before releasing its lock", async () => {
    const { batch } = create(); await batch.run(() => true, () => undefined);
    const completed = deferred<() => void>(), transaction = Reflect.get(IDBDatabase.prototype, "transaction"), spy = vi.spyOn(IDBDatabase.prototype, "transaction");
    spy.mockImplementation(function (this: IDBDatabase, ...args) {
      const current = transaction.apply(this, args);
      if (args[1] === "readwrite") Object.defineProperty(current, "oncomplete", { set(handler: (event: Event) => void) { current.addEventListener("complete", (event) => { completed.resolve(() => { handler.call(current, event); }); }, { once: true }); } });
      return current;
    });
    const closing = batch.dispose(), release = await completed.promise; vi.restoreAllMocks();
    const clearing = batch.dispose(true); expect(clearing).toBe(closing); release(); await closing;
    const database = await new Promise<IDBDatabase>((resolve, reject) => { const request = indexedDB.open("aurialis-album-spool-v1", 1); request.onsuccess = () => { resolve(request.result); }; request.onerror = () => { reject(request.error ?? new Error("Fixture open failed")); }; });
    try { const stored = await new Promise<unknown>((resolve, reject) => { const tx = database.transaction("runs", "readonly"), request = tx.objectStore("runs").get("album:local-album"); tx.oncomplete = () => { resolve(request.result as unknown); }; tx.onerror = () => { reject(tx.error ?? new Error("Fixture read failed")); }; }); expect(stored).toBeUndefined(); }
    finally { database.close(); }
  });
  it("claims metadata export memory before serialization and retains it through maximum-sized receipt URL cleanup", async () => {
    const { batch, owned } = create(), report = await batch.run(() => true, () => undefined), original = report.tracks[0]; if (!original) throw new Error("Missing row");
    const rows = Array.from({ length: 64 }, (_, index) => { const id = "é".repeat(250) + String(index); return { ...structuredClone(original), id, title: "", audioKey: "é".repeat(300), gain: { ...original.gain, id } }; });
    const maximum = { ...report, cohortIds: rows.map((row) => row.id), tracks: rows }; let low = 0, high = 1024;
    while (low < high) { const middle = Math.ceil((low + high) / 2); for (const row of rows) row.title = "é".repeat(middle); if (new TextEncoder().encode(JSON.stringify(maximum)).byteLength <= 262_144) low = middle; else high = middle - 1; }
    for (const row of rows) row.title = "é".repeat(low); const expectedBytes = new TextEncoder().encode(JSON.stringify(maximum)).byteLength;
    expect(expectedBytes).toBeGreaterThan(262_000); expect(readAlbumReport(maximum)).toEqual(maximum);
    const baseline = owned.total(), stringify = vi.spyOn(JSON, "stringify"); owned.setLimit(baseline + 2 * 1024 * 1024 - 1);
    await expect(downloadAlbumReport(maximum, owned.reserve)).rejects.toThrow(/memory/u); expect(stringify).not.toHaveBeenCalled(); stringify.mockRestore();
    owned.setLimit(512 * 1024 * 1024); const held = deferred<undefined>(); vi.mocked(downloadLocalBlobAndWait).mockReturnValueOnce(held.promise);
    const pending = downloadAlbumReport(maximum, owned.reserve); await vi.waitFor(() => { expect(downloadLocalBlobAndWait).toHaveBeenCalledOnce(); }); expect(owned.total()).toBe(baseline + 2 * 1024 * 1024);
    const blob = vi.mocked(downloadLocalBlobAndWait).mock.calls[0]?.[0]; if (!blob) throw new Error("Missing metadata export"); expect(blob.size).toBe(expectedBytes); expect(JSON.parse(await blob.text())).toEqual(maximum);
    held.resolve(undefined); await pending; expect(owned.total()).toBe(baseline);
  });
  it("admits 64 ordinary labels but rejects excessive receipt metadata before any audio or storage IO", async () => {
    const { album, tracks } = fixture(), base = tracks[0]; if (!base) throw new Error("Missing source");
    const many = Array.from({ length: 64 }, (_, index) => ({ ...base, id: `song-${String(index)}`, title: `Album song ${String(index)}` })), sequence = { ...album, trackIds: many.map((track) => track.id) }, owned = memory();
    const accepted = new AlbumBatch(sequence, many, owned.reserve); batches.push(accepted); await accepted.dispose(); expect(owned.total()).toBe(0);
    expect(JSON.stringify(-Number.MAX_VALUE)).toHaveLength(24); expect(JSON.stringify(-0.0000012345678901234567)).toHaveLength(25);
    // Fixed near-boundary counterexample: 191 escaped control characters fit the conservative template; 192 do not.
    const near = new AlbumBatch(sequence, many.map((track) => ({ ...track, title: "\u0001".repeat(191) })), owned.reserve); batches.push(near); await near.dispose();
    expect(() => new AlbumBatch(sequence, many.map((track) => ({ ...track, title: "\u0001".repeat(192) })), owned.reserve)).toThrow(/report metadata/u);
    const long = many.map((track) => ({ ...track, title: "\u0001".repeat(1024) })), opening = vi.spyOn(indexedDB, "open");
    expect(() => new AlbumBatch(sequence, long, owned.reserve)).toThrow(/report metadata/u); expect(owned.total()).toBe(0); expect(opening).not.toHaveBeenCalled(); expect(renderAlbumTrack).not.toHaveBeenCalled();
  });
  it("enforces the receipt limit in UTF-8 bytes while preserving the strict schema", async () => {
    const { batch } = create(), report = await batch.run(() => true, () => undefined), row = report.tracks[0]; if (!row) throw new Error("Missing measured row");
    const rows = Array.from({ length: 64 }, (_, index) => { const id = "é".repeat(250) + String(index); return { ...structuredClone(row), id, title: "é".repeat(500), audioKey: "é".repeat(500), gain: { ...row.gain, id } }; });
    const utf8 = { ...report, cohortIds: rows.map((track) => track.id), tracks: rows }, json = JSON.stringify(utf8);
    expect(json.length).toBeLessThan(262_144); expect(new TextEncoder().encode(json).byteLength).toBeGreaterThan(262_144); expect(readAlbumReport(utf8)).toBeUndefined();
  });
  it("invalidates the whole prefix when the processing producer changes before retry", async () => {
    const { batch, owned } = create(); await expect(batch.run(() => true, (value) => { if (value.completed === 1) batch.cancel(); })).rejects.toMatchObject({ name: "AbortError" });
    vi.mocked(qualifyProcessingBuild).mockResolvedValue("f".repeat(64));
    await expect(batch.run(() => true, () => undefined)).rejects.toMatchObject({ name: "ProcessingBuildMismatchError" }); expect(batch.getFiles()).toEqual([]); expect(batch.getReport()).toBeNull(); expect(owned.total()).toBe(0);
  });
});
