import "@testing-library/jest-dom/vitest";
import { Blob as NativeBlob } from "node:buffer";
import { webcrypto } from "node:crypto";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AlbumBatch, AlbumProgress, AlbumReport } from "@/lib/album-batch";
import { albumCohortKey } from "@/lib/album-batch";
import { StoreProvider, useStore } from "@/lib/store";
import { testStore } from "@/lib/__tests__/fixtures";
import type { Album } from "@/lib/types";
import { AlbumView } from "../AlbumsView";

const controlled = vi.hoisted(() => ({
  instances: [] as AlbumBatch[], disposed: new Set<AlbumBatch>(), canceled: new Set<AlbumBatch>(),
  results: new Map<AlbumBatch, { report: AlbumReport; files: ReturnType<AlbumBatch["getFiles"]> }>(),
  run: vi.fn<(batch: AlbumBatch, current: () => boolean, progress: (value: AlbumProgress) => void) => Promise<AlbumReport>>(),
  download: vi.fn<(blob: Blob, filename: string) => void>(),
}));
vi.mock("@/lib/download", () => ({ downloadLocalBlob: controlled.download }));
vi.mock("@/lib/browser-jobs", () => ({ reserveBrowserAudioMemory: () => Object.freeze({ update: vi.fn(), dispose: vi.fn() }) }));
vi.mock("@/lib/album-batch", async (original) => {
  const actual = await original<typeof import("@/lib/album-batch")>();
  return { ...actual, AlbumBatch: class extends actual.AlbumBatch {
    constructor(...args: ConstructorParameters<typeof actual.AlbumBatch>) { super(...args); controlled.instances.push(this); }
    override run(current: () => boolean, progress: (value: AlbumProgress) => void) { return controlled.run(this, current, progress); }
    override getReport() { return controlled.results.get(this)?.report ?? null; }
    override getFiles() { return controlled.results.get(this)?.files ?? []; }
    override cancel() { controlled.canceled.add(this); super.cancel(); }
    override dispose() { controlled.disposed.add(this); super.dispose(); }
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
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(batch.key));
  const report: AlbumReport = { version: 1, createdAt: "2026-10-23T00:00:00Z", albumId: album.id, title: album.title, artist: album.artist,
    bindingHash: Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join(""), target: -14, mode: "relationships", cohortIds: album.trackIds,
    medianTrackLufs: -20, commonGainDb: 2, complete: count === tracks.length, tracks: tracks.slice(0, count).map((track) => {
      if (!track?.sourceIdentity) throw new Error("Missing source identity");
      return { id: track.id, title: track.title, duration: 1, source: track.sourceIdentity, sourceRevision: 0, audioKey: track.id, metrics, beforeMetrics: metrics,
        bands: edges.slice(0, -1).map((lowHz, index) => ({ lowHz, highHz: edges.at(index + 1) ?? 0, usableHighHz: edges.at(index + 1) ?? 0, powerDb: -20, valid: true })),
        processingHash: "b".repeat(64), scriptRevision: null, gain: { id: track.id, gainDb: 2, requestedLufs: null, limitedBy: null, measurable: true },
        output: { sha256: "c".repeat(64), bytes: 288044, encoding: { frames: 48000, sampleRate: 48000, channels: 2, bitDepth: 24, fullScaleFrames: 0, leadingSilenceFrames: 0, trailingSilenceFrames: 0, silenceThresholdDbfs: -60 } } };
    }) };
  // Controller fixture only; native E2E/core inspection tests establish WAV correctness.
  const files = report.tracks.map((row) => ({ id: row.id, title: row.title, wav: new Blob([new Uint8Array(row.output.bytes)]) }));
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
async function run() { fireEvent.click(screen.getByRole("button", { name: "Render album masters" })); await screen.findByRole("button", { name: "Download Song 1" }); }
beforeEach(() => {
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value); } });
  vi.stubGlobal("crypto", webcrypto); vi.stubGlobal("Blob", NativeBlob);
  localStorage.setItem("aurialis-state-v1", JSON.stringify(initial()));
  controlled.run.mockImplementation((batch) => fixtureResult(batch));
});
afterEach(() => { cleanup(); store = undefined; controlled.instances.length = 0; controlled.disposed.clear(); controlled.canceled.clear(); controlled.results.clear(); vi.resetAllMocks(); vi.unstubAllGlobals(); });

describe("album workspace controller", () => {
  it("saves metadata by full-record CAS without discarding current exact-Blob downloads or mutating any track", async () => {
    await open(); const before = structuredClone(state().state.tracks); await run(); const owner = controlled.instances[0]; if (!owner) throw new Error("Missing job");
    const file = controlled.results.get(owner)?.files[0]; if (!file) throw new Error("Missing file");
    fireEvent.click(screen.getByRole("button", { name: "Save album report" })); await waitFor(() => { expect(activeAlbum().report?.complete).toBe(true); });
    fireEvent.click(screen.getByRole("button", { name: "Download Song 1" })); fireEvent.click(screen.getByRole("button", { name: "Download Song 1" }));
    expect(controlled.download).toHaveBeenNthCalledWith(1, file.wav, "Song-1-album-master.wav"); expect(controlled.download).toHaveBeenNthCalledWith(2, file.wav, "Song-1-album-master.wav");
    expect(controlled.disposed.has(owner)).toBe(false); expect(state().state.tracks).toEqual(before);
  });
  it("disposes the old owner on source, order or settings changes and rejects its late result", async () => {
    await open(); const pending = deferred<AlbumReport>(); controlled.run.mockReturnValueOnce(pending.promise);
    fireEvent.click(screen.getByRole("button", { name: "Render album masters" }));
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
  it("binds the complete track/source snapshot and keeps download allocation errors visible", async () => {
    await open(); await run(); controlled.download.mockImplementationOnce(() => { throw new Error("Device memory budget exceeded."); });
    fireEvent.click(screen.getByRole("button", { name: "Download Song 1" })); expect(screen.getByRole("alert")).toHaveTextContent("Device memory budget exceeded.");
    const before = activeAlbum(), tracks = state().state.tracks, key = albumCohortKey(before, tracks);
    const first = tracks[0]; if (!first) throw new Error("Missing track");
    act(() => { state().dispatch({ type: "UPDATE_TRACK", id: first.id, patch: { sourceRevision: 1 } }); });
    expect(albumCohortKey(activeAlbum(), state().state.tracks)).not.toBe(key); expect(screen.queryByRole("button", { name: "Download Song 1" })).not.toBeInTheDocument();
  });
});
