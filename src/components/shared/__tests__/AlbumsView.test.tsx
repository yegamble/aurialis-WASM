import "@testing-library/jest-dom/vitest";
import { Blob as NativeBlob } from "node:buffer";
import { webcrypto } from "node:crypto";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AlbumBatch, AlbumProgress, AlbumReport } from "@/lib/album-batch";
import { AlbumRecipeBinding } from "@/lib/album-binding";
import { albumCohortKey } from "@/lib/album-batch";
import { StoreProvider, useStore } from "@/lib/store";
import { testStore } from "@/lib/__tests__/fixtures";
import type { Album } from "@/lib/types";
import { AlbumView, AlbumsView } from "../AlbumsView";
import { AlbumSpool } from "@/lib/album-spool";

const controlled = vi.hoisted(() => ({
  instances: [] as AlbumBatch[], disposed: new Set<AlbumBatch>(), canceled: new Set<AlbumBatch>(),
  results: new Map<AlbumBatch, { report: AlbumReport; files: ReturnType<AlbumBatch["getFiles"]> }>(),
  run: vi.fn<(batch: AlbumBatch, current: () => boolean, progress: (value: AlbumProgress) => void) => Promise<AlbumReport>>(),
  download: vi.fn<(blob: Blob, filename: string) => void>(),
  masterDownload: vi.fn<(batch: AlbumBatch, index: number, current: () => boolean) => Promise<void>>(),
}));
vi.mock("@/lib/download", () => ({ downloadLocalBlob: controlled.download, downloadLocalBlobAndWait: vi.fn() }));
vi.mock("@/lib/processing-identity", async (original) => ({ ...await original<typeof import("@/lib/processing-identity")>(), injectedProcessingIdentity: () => ({ fingerprint: "a".repeat(64) }) }));
vi.mock("@/lib/browser-jobs", () => ({ reserveBrowserAudioMemory: () => Object.freeze({ update: vi.fn(), dispose: vi.fn() }) }));
vi.mock("@/lib/album-batch", async (original) => {
  const actual = await original<typeof import("@/lib/album-batch")>();
  return { ...actual, AlbumBatch: class extends actual.AlbumBatch {
    constructor(...args: ConstructorParameters<typeof actual.AlbumBatch>) { super(...args); controlled.instances.push(this); }
    override run(current: () => boolean, progress: (value: AlbumProgress) => void) { return controlled.run(this, current, progress); }
    override getReport() { return controlled.results.get(this)?.report ?? null; }
    override getFiles() { return controlled.results.get(this)?.files ?? []; }
    override cancel() { controlled.canceled.add(this); super.cancel(); }
    override dispose(discard = false) { controlled.disposed.add(this); return super.dispose(discard); }
    override download(index: number, current: () => boolean) { return controlled.masterDownload(this, index, current); }
  } };
});
let store: ReturnType<typeof useStore> | undefined;
function Probe() { store = useStore(); return null; }
function state() { if (!store) throw new Error("Missing store"); return store; }
function activeAlbum() { const album = state().state.albums[0]; if (!album) throw new Error("Missing album"); return album; }
function deferred<T>() {
  let resolve: ((value: T) => void) | undefined, reject: ((cause: unknown) => void) | undefined;
  const promise = new Promise<T>((complete, fail) => { resolve = complete; reject = fail; });
  return { promise, complete(value: T) { if (!resolve) throw new Error("Missing completion"); resolve(value); }, fail(cause: unknown) { if (!reject) throw new Error("Missing rejection"); reject(cause); } };
}
const metrics = { integratedLufs: -18, shortTermLufs: -18, truePeakDbtp: -3, samplePeakDbfs: -3, dynamicRangeDb: 8,
  correlation: 1, lowBassCorrelation: 1, dcLeftDbfs: -120, dcRightDbfs: -120, clippingSamples: 0, gainReductionDb: 0 };
const edges = [20, 120, 500, 2000, 6000, 20000];
async function fixtureResult(batch: AlbumBatch, count = 2) {
  const album = activeAlbum(), tracks = album.trackIds.map((id) => state().state.tracks.find((track) => track.id === id));
  const binding = new AlbumRecipeBinding(album, tracks.filter((track) => track !== undefined), () => ({ update: () => undefined, dispose: () => undefined }));
  const hash = await binding.digest("a".repeat(64), new AbortController().signal, () => true); binding.dispose();
  const report: AlbumReport = { version: 1, createdAt: "2026-10-23T00:00:00Z", albumId: album.id, title: album.title, artist: album.artist,
    bindingHash: hash, target: -14, mode: "relationships", cohortIds: album.trackIds,
    medianTrackLufs: -20, commonGainDb: 2, complete: count === tracks.length, tracks: tracks.slice(0, count).map((track) => {
      if (!track?.sourceIdentity) throw new Error("Missing source identity");
      return { id: track.id, title: track.title, duration: 1, source: track.sourceIdentity, sourceRevision: 0, audioKey: track.id, metrics, beforeMetrics: metrics,
        bands: edges.slice(0, -1).map((lowHz, index) => ({ lowHz, highHz: edges.at(index + 1) ?? 0, usableHighHz: edges.at(index + 1) ?? 0, powerDb: -20, valid: true })),
        processingHash: "b".repeat(64), scriptRevision: null, gain: { id: track.id, gainDb: 2, requestedLufs: null, limitedBy: null, measurable: true },
        output: { sha256: "c".repeat(64), bytes: 288044, encoding: { frames: 48000, sampleRate: 48000, channels: 2, bitDepth: 24, fullScaleFrames: 0, leadingSilenceFrames: 0, trailingSilenceFrames: 0, silenceThresholdDbfs: -60 } } };
    }) };
  // Controller fixture only; native E2E/core inspection tests establish WAV correctness.
  const files = report.tracks.map((row, index) => ({ id: row.id, title: row.title, index, bytes: row.output.bytes }));
  controlled.results.set(batch, { report, files }); return report;
}
function initial() {
  const tracks = structuredClone(testStore.tracks).map((track, index) => ({ ...track, title: `Song ${String(index + 1)}`, sourceIdentity: { pcmHash: "a".repeat(64), sampleRate: 48000, frames: 48000 } }));
  const album: Album = { id: "album-test", title: "Sequence", artist: "Artist", target: "−14 LUFS", trackIds: tracks.map((track) => track.id), mastered: false };
  return { tracks, albums: [album], stems: [] };
}
async function open() {
  const view = render(<StoreProvider><Probe /><AlbumView albumId="album-test" /></StoreProvider>);
  await screen.findByRole("button", { name: "Render album masters" }); return view;
}
async function run() { fireEvent.click(screen.getByRole("button", { name: "Render album masters" })); await screen.findByRole("button", { name: "Download Song 1" }); await waitFor(() => { expect(screen.getByRole("button", { name: "Render album masters" })).toBeEnabled(); }); }
beforeEach(() => {
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value); } });
  vi.stubGlobal("crypto", webcrypto); vi.stubGlobal("Blob", NativeBlob);
  localStorage.setItem("aurialis-state-v1", JSON.stringify(initial()));
  controlled.run.mockImplementation((batch) => fixtureResult(batch)); controlled.masterDownload.mockResolvedValue(undefined);
});
afterEach(() => { cleanup(); store = undefined; controlled.instances.length = 0; controlled.disposed.clear(); controlled.canceled.clear(); controlled.results.clear(); vi.resetAllMocks(); vi.unstubAllGlobals(); });

describe("album workspace controller", () => {
  it("saves metadata by full-record CAS without discarding current verified download descriptors or mutating any track", async () => {
    await open(); const before = structuredClone(state().state.tracks); await run(); const owner = controlled.instances[0]; if (!owner) throw new Error("Missing job");
    const file = controlled.results.get(owner)?.files[0]; if (!file) throw new Error("Missing file");
    fireEvent.click(screen.getByRole("button", { name: "Save album report" })); await waitFor(() => { expect(activeAlbum().report?.complete).toBe(true); });
    fireEvent.click(screen.getByRole("button", { name: "Download Song 1" })); await waitFor(() => { expect(screen.getByRole("button", { name: "Download Song 1" })).toBeEnabled(); });
    fireEvent.click(screen.getByRole("button", { name: "Download Song 1" })); await waitFor(() => { expect(controlled.masterDownload).toHaveBeenCalledTimes(2); });
    expect(controlled.masterDownload).toHaveBeenNthCalledWith(1, owner, file.index, expect.any(Function)); expect(controlled.masterDownload).toHaveBeenNthCalledWith(2, owner, file.index, expect.any(Function));
    expect(controlled.disposed.has(owner)).toBe(false); expect(state().state.tracks).toEqual(before);
  });
  it("disposes the old owner on source, order or settings changes and rejects its late result", async () => {
    await open(); const pending = deferred<AlbumReport>(); controlled.run.mockReturnValueOnce(pending.promise);
    fireEvent.click(screen.getByRole("button", { name: "Render album masters" }));
    await waitFor(() => { expect(controlled.instances).toHaveLength(1); });
    const owner = controlled.instances[0]; if (!owner) throw new Error("Missing job"); const old = await fixtureResult(owner);
    fireEvent.change(screen.getByRole("combobox", { name: "Album target" }), { target: { value: "-18" } });
    expect(controlled.disposed.has(owner)).toBe(true); await act(async () => { pending.complete(old); await pending.promise; });
    expect(screen.queryByRole("button", { name: "Download Song 1" })).not.toBeInTheDocument(); expect(activeAlbum().report).toBeUndefined();
  });
  it("retains a canceled verified prefix for retry and clears it when a manual offset changes", async () => {
    await open(); const pending = deferred<AlbumReport>();
    controlled.run.mockImplementationOnce(async (batch, _current, progress) => { const report = await fixtureResult(batch, 1); progress({ stage: "One verified", completed: 1, total: 2, report }); return pending.promise; });
    fireEvent.click(screen.getByRole("button", { name: "Render album masters" })); await screen.findByRole("button", { name: "Download Song 1" });
    const owner = controlled.instances[0]; if (!owner) throw new Error("Missing job"); fireEvent.click(screen.getByRole("button", { name: "Cancel album render" })); expect(controlled.canceled.has(owner)).toBe(true);
    await act(async () => { pending.fail(new DOMException("Canceled", "AbortError")); await pending.promise.catch(() => undefined); });
    expect(screen.getByRole("button", { name: "Download Song 1" })).toBeEnabled(); expect(controlled.disposed.has(owner)).toBe(false);
    await run(); expect(controlled.instances).toHaveLength(1);
    fireEvent.change(screen.getByRole("slider", { name: "Manual gain for Song 1" }), { target: { value: "1" } });
    expect(controlled.disposed.has(owner)).toBe(true); expect(screen.queryByRole("button", { name: "Download Song 1" })).not.toBeInTheDocument();
  });
  it("disposes on unmount and restores saved report-only state with no downloadable WAV ownership", async () => {
    const view = await open(); await run(); fireEvent.click(screen.getByRole("button", { name: "Save album report" })); const owner = controlled.instances[0]; if (!owner) throw new Error("Missing job");
    const saved = JSON.stringify(state().state); view.unmount(); expect(controlled.disposed.has(owner)).toBe(true);
    localStorage.setItem("aurialis-state-v1", saved); await open();
    await screen.findByText("Saved measurements restored. Render again to restore WAV downloads; a saved report contains metadata only.", { exact: true });
    expect(screen.queryByRole("button", { name: "Download Song 1" })).not.toBeInTheDocument(); expect(screen.getByRole("button", { name: "Download album JSON report" })).toBeEnabled();
  });
  it("prevents an older render intent from installing an owner after delayed previous cleanup", async () => {
    await open(); await run(); await waitFor(() => { expect(screen.getByRole("button", { name: "Render album masters" })).toBeEnabled(); });
    const old = controlled.instances[0]; if (!old) throw new Error("Missing owner"); const cleanup = deferred<undefined>();
    vi.spyOn(old, "dispose").mockReturnValueOnce(cleanup.promise);
    fireEvent.change(screen.getByRole("combobox", { name: "Album target" }), { target: { value: "-18" } });
    fireEvent.click(screen.getByRole("button", { name: "Render album masters" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Album target" }), { target: { value: "-16" } });
    fireEvent.click(screen.getByRole("button", { name: "Render album masters" }));
    await act(async () => { cleanup.complete(undefined); await cleanup.promise; });
    await waitFor(() => { expect(controlled.instances).toHaveLength(2); }); expect(controlled.run).toHaveBeenCalledTimes(2);
    expect(activeAlbum().target).toBe("−16 LUFS");
  });
  it("ignores a stale Clear failure after settings change while the next intent still owns its busy state", async () => {
    await open(); await run(); await waitFor(() => { expect(screen.getByRole("button", { name: "Render album masters" })).toBeEnabled(); });
    const owner = controlled.instances[0]; if (!owner) throw new Error("Missing owner"); const held = deferred<undefined>(), next = deferred<AlbumReport>();
    vi.spyOn(owner, "dispose").mockReturnValueOnce(held.promise);
    fireEvent.click(screen.getByRole("button", { name: "Clear stored album masters" })); fireEvent.click(screen.getByRole("button", { name: "Clear stored masters" }));
    act(() => { state().dispatch({ type: "UPDATE_ALBUM", id: activeAlbum().id, patch: { target: "−18 LUFS" } }); });
    controlled.run.mockReturnValueOnce(next.promise); fireEvent.click(screen.getByRole("button", { name: "Render album masters" }));
    await waitFor(() => { expect(controlled.instances).toHaveLength(2); });
    await act(async () => { held.fail(new Error("Stale clear failure")); await held.promise.catch(() => undefined); });
    expect(screen.queryByText("Stale clear failure")).not.toBeInTheDocument(); expect(screen.getByRole("button", { name: "Cancel album render" })).toBeEnabled();
    const latest = controlled.instances[1]; if (!latest) throw new Error("Missing next owner");
    await act(async () => { next.complete(await fixtureResult(latest)); await next.promise; });
  });
  it("keeps the delete dialog bound to its album while actual stored cleanup is pending", async () => {
    render(<StoreProvider><Probe /><AlbumsView /></StoreProvider>); await screen.findByRole("button", { name: "Delete Sequence" });
    act(() => { state().dispatch({ type: "ADD_ALBUM", album: { ...activeAlbum(), id: "second", title: "Second sequence" } }); });
    const held = deferred<undefined>(), removal = vi.spyOn(AlbumSpool, "clearStored").mockReturnValueOnce(held.promise);
    try {
      fireEvent.click(screen.getByRole("button", { name: "Delete Sequence" })); fireEvent.click(screen.getByRole("button", { name: "Delete album" })); await waitFor(() => { expect(removal).toHaveBeenCalledWith("album-test"); });
      expect(screen.getByRole("button", { name: "Keep album" })).toBeDisabled();
      fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" }); fireEvent.click(screen.getByRole("button", { name: "Delete Second sequence" }));
      expect(screen.getByRole("dialog")).toHaveTextContent('Remove “Sequence”');
      await act(async () => { held.fail(new Error("First album cleanup denied")); await held.promise.catch(() => undefined); });
      expect(screen.getByRole("dialog")).toHaveTextContent("First album cleanup denied"); expect(state().state.albums).toHaveLength(2);
      fireEvent.click(screen.getByRole("button", { name: "Keep album" })); fireEvent.click(screen.getByRole("button", { name: "Delete Second sequence" }));
      expect(screen.getByRole("dialog")).toHaveTextContent('Remove “Second sequence”'); expect(screen.queryByText("First album cleanup denied")).not.toBeInTheDocument();
    } finally { removal.mockRestore(); }
  });
  it("binds the complete track/source snapshot and keeps download allocation errors visible", async () => {
    await open(); await run(); controlled.masterDownload.mockRejectedValueOnce(new Error("Device memory budget exceeded."));
    fireEvent.click(screen.getByRole("button", { name: "Download Song 1" })); expect(await screen.findByRole("alert")).toHaveTextContent("Device memory budget exceeded.");
    const before = activeAlbum(), tracks = state().state.tracks, key = albumCohortKey(before, tracks);
    const first = tracks[0]; if (!first) throw new Error("Missing track");
    act(() => { state().dispatch({ type: "UPDATE_TRACK", id: first.id, patch: { sourceRevision: 1 } }); });
    expect(albumCohortKey(activeAlbum(), state().state.tracks)).not.toBe(key); expect(screen.queryByRole("button", { name: "Download Song 1" })).not.toBeInTheDocument();
  });
});
