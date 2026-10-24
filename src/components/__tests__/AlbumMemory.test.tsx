import { Blob as NativeBlob } from "node:buffer";
import { IDBFactory, IDBObjectStore } from "fake-indexeddb";
import { webcrypto } from "node:crypto";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as engine from "@/lib/browser-engine";
import * as memory from "@/lib/browser-jobs";
import * as encoded from "@/lib/encoded-inspection";
import * as sourceReceipts from "@/lib/project-import";
import * as processing from "@/lib/processing-build";
import * as features from "@/lib/feature-analysis";
import { StoreProvider } from "@/lib/store";
import { albumCleanupStatus, retryAlbumCleanup } from "@/lib/album-cleanup";
import { testStore } from "@/lib/__tests__/fixtures";
import { AurialisWorkstation } from "../AurialisWorkstation";

const mocks = vi.hoisted(() => ({ getAudio: vi.fn() }));
vi.mock("@/lib/db", () => ({ getAudio: mocks.getAudio, saveAudio: vi.fn(), deleteAudio: vi.fn(), discardStagedAudio: vi.fn(), newAudioAssetId: vi.fn() }));
vi.mock("next/navigation", () => ({ usePathname: () => null }));
const reserve = memory.reserveBrowserAudioMemory;
const owners: { initial: number; current: number; released: boolean; update: ReturnType<typeof vi.fn<(bytes: number) => void>>; dispose: ReturnType<typeof vi.fn<() => void>> }[] = [];
const metrics = { integratedLufs: -14, shortTermLufs: -14, truePeakDbtp: -6, samplePeakDbfs: -6, dynamicRangeDb: 8, correlation: 1, lowBassCorrelation: 1, dcLeftDbfs: -120, dcRightDbfs: -120, clippingSamples: 0, gainReductionDb: 0 };
const identity = { pcmHash: "a".repeat(64), sampleRate: 48000, frames: 48000 };
const canonicalBytes = 44 + identity.frames * 8, encodedBytes = 44 + identity.frames * 6;
const packetBytes = 32 * 1024 * 1024;
function locks() { const held = new Set<string>(); return { request: async (name: string, _options: unknown, action: (lock: { name: string } | null) => Promise<void>) => { if (held.has(name)) return action(null); held.add(name); try { await action({ name }); } finally { held.delete(name); } } }; }
const total = () => owners.reduce((sum, owner) => sum + owner.current, 0);
const active = () => owners.filter((owner) => !owner.released);
let wav: Blob, canonical: Blob;
function mount() { return render(<StoreProvider><AurialisWorkstation route="album" paramId="memory-album" /></StoreProvider>); }
async function start() { fireEvent.click(await screen.findByRole("button", { name: "Render album masters" })); }

beforeEach(() => {
  owners.length = 0;
  vi.stubGlobal("Blob", NativeBlob); vi.stubGlobal("crypto", webcrypto); vi.stubGlobal("indexedDB", new IDBFactory()); vi.stubGlobal("navigator", { locks: locks() });
  vi.spyOn(processing, "qualifyProcessingBuild").mockResolvedValue("a".repeat(64));
  // Opaque controller artifacts only: core/native/browser tests verify actual WAV and source hashes.
  wav = new Blob([new Uint8Array(encodedBytes)]); canonical = new Blob([new Uint8Array(canonicalBytes)]);
  const tracks = testStore.tracks.map((track, index) => ({ ...track, sourceIdentity: identity, title: "Album source " + String(index + 1) }));
  const storage = new Map([["aurialis-state-v1", JSON.stringify({ tracks, albums: [{ id: "memory-album", title: "Memory album", artist: "", target: "−14 LUFS", trackIds: tracks.map((track) => track.id), mastered: false }], stems: [] })]]);
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value); } });
  window.history.replaceState(null, "", "/albums/memory-album");
  mocks.getAudio.mockReset().mockResolvedValue(canonical);
  vi.spyOn(memory, "reserveBrowserAudioMemory").mockImplementation((bytes = 0) => {
    const owned = reserve(bytes), observed = { initial: bytes, current: bytes, released: false, update: vi.fn((next: number) => { owned.update(next); observed.current = next; }), dispose: vi.fn(() => { owned.dispose(); observed.current = 0; observed.released = true; }) };
    owners.push(observed); return observed;
  });
  vi.spyOn(sourceReceipts, "verifyCanonicalSource").mockImplementation((_blob, expected) => Promise.resolve(expected));
  vi.spyOn(encoded, "inspectEncodedWAV").mockImplementation((_blob, bits, source) => {
    if (bits !== 16 && bits !== 24 && bits !== 32) throw new Error("Invalid output depth");
    return Promise.resolve({ sha256: "b".repeat(64), encoding: { sampleRate: source.sampleRate, frames: source.frames, bitDepth: bits, channels: 2, fullScaleFrames: 0, leadingSilenceFrames: 0, trailingSilenceFrames: 0, silenceThresholdDbfs: -60 } });
  });
  const edges = [20, 120, 500, 2000, 6000, 20000];
  vi.spyOn(features, "analyzeSourceFeatures").mockResolvedValue({ source: identity, bands: edges.slice(0, -1).map((lowHz, index) => ({ lowHz, highHz: edges.at(index + 1) ?? 0, usableHighHz: edges.at(index + 1) ?? 0, powerDb: -20, valid: true })), sections: [{ id: "all", name: "All", startFrame: 0, endFrame: 48000, confidence: 0 }], warnings: [] });
  vi.spyOn(engine, "measureAudio").mockResolvedValue({ sampleRate: 48000, frames: 48000, duration: 1, beforeMetrics: metrics, afterMetrics: metrics });
  vi.spyOn(engine, "serverRenderOwned").mockImplementation((_source, _processing, layout) => { const blob = layout.bitDepth === 24 ? wav : canonical, owner = memory.reserveBrowserAudioMemory(blob.size); return Promise.resolve({ blob, owner, dispose: owner.dispose }); });
});
afterEach(async () => { cleanup(); await retryAlbumCleanup("memory-album").catch(() => undefined); await waitFor(() => { expect(total()).toBe(0); }); for (const owner of owners) owner.dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("charges actual phases while retaining only bounded metadata between tracks and releases ownership when order changes", async () => {
  mount(); await start(); await screen.findByRole("button", { name: "Download Album source 2" });
  expect(active()).toHaveLength(2); expect(active().every((owner) => owner.current !== encodedBytes && owner.current !== 2 * encodedBytes)).toBe(true);
  expect(owners.some((owner) => owner.initial === canonicalBytes * 3 && owner.update.mock.calls.some((call) => call[0] === canonicalBytes))).toBe(true);
  expect(owners.some((owner) => owner.initial === encodedBytes && owner.update.mock.calls.some((call) => call[0] === encodedBytes * 3))).toBe(true);
  await waitFor(() => { expect(screen.getByRole<HTMLButtonElement>("button", { name: "Move Album source 1 down" }).disabled).toBe(false); });
  fireEvent.click(screen.getByRole("button", { name: "Move Album source 1 down" })); await waitFor(() => { expect(total()).toBe(0); });
  expect(screen.queryByRole("region", { name: "Rendered album downloads" })).toBeNull();
});

it("releases failed phase audio while preserving only metadata and its verified stored prefix for retry", async () => {
  mount(); let renders = 0;
  vi.mocked(engine.serverRenderOwned).mockImplementation((_source, _processing, layout) => {
    renders++; if (renders === 4) return Promise.reject(new Error("Controlled second-track failure"));
    const blob = layout.bitDepth === 24 ? wav : canonical, owner = memory.reserveBrowserAudioMemory(blob.size); return Promise.resolve({ blob, owner, dispose: owner.dispose });
  });
  await start(); await screen.findByText("Controlled second-track failure"); expect(active()).toHaveLength(2);
  expect(screen.getByRole("button", { name: "Download Album source 1" })).toBeDefined(); expect(screen.queryByRole("button", { name: "Download Album source 2" })).toBeNull();
  await start(); await screen.findByRole("button", { name: "Download Album source 2" }); expect(active()).toHaveLength(2);
  expect(vi.mocked(engine.serverRenderOwned).mock.calls.filter((call) => call[2].bitDepth === 24)).toHaveLength(2);
});

it("keeps source, packet and metadata charged after unmount until a late owned render and cleanup actually settle", async () => {
  const mounted = mount(); let finish: ((value: Awaited<ReturnType<typeof engine.serverRenderOwned>>) => void) | undefined;
  vi.mocked(engine.serverRenderOwned).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
  await start(); await waitFor(() => { expect(engine.serverRenderOwned).toHaveBeenCalledOnce(); });
  const before = total(); expect(before).toBeGreaterThan(packetBytes + canonicalBytes); mounted.unmount(); expect(total()).toBe(before);
  await act(async () => { const owner = memory.reserveBrowserAudioMemory(canonical.size); finish?.({ blob: canonical, owner, dispose: owner.dispose }); await Promise.resolve(); });
  await waitFor(() => { expect(total()).toBe(0); });
});

it("surfaces download memory denial while preserving the already verified stored descriptors", async () => {
  mount(); await start(); const download = await screen.findByRole("button", { name: "Download Album source 2" });
  await waitFor(() => { expect((download as HTMLButtonElement).disabled).toBe(false); });
  vi.mocked(memory.reserveBrowserAudioMemory).mockImplementationOnce(() => { throw new Error("Controlled download memory budget"); });
  fireEvent.click(download); expect(await screen.findByText("Controlled download memory budget")).toBeDefined();
  expect(screen.getByRole("region", { name: "Rendered album downloads" })).toBeDefined(); expect(active()).toHaveLength(2);
});


it("keeps failed unmount cleanup discoverable after navigation and retries the exact charged owner", async () => {
  const mounted = mount(); await start(); const download = await screen.findByRole("button", { name: "Download Album source 2" });
  await waitFor(() => { expect((download as HTMLButtonElement).disabled).toBe(false); });
  const storage = localStorage.getItem("aurialis-state-v1");
  vi.spyOn(IDBObjectStore.prototype, "put").mockImplementationOnce(() => { throw new Error("Unmount cleanup denied"); });
  mounted.unmount(); await waitFor(() => { expect(albumCleanupStatus("memory-album")?.message).toBe("Unmount cleanup denied"); });
  expect(total()).toBeGreaterThan(0);
  let acquired = true; await navigator.locks.request("aurialis-album:memory-album", { ifAvailable: true }, (lock) => { acquired = lock !== null; }); expect(acquired).toBe(false);
  mount(); await screen.findByText(/Previous album cleanup needs attention/u);
  expect(screen.queryByRole("button", { name: "Download Album source 1" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Clear stored album masters" })); fireEvent.click(screen.getByRole("button", { name: "Clear stored masters" }));
  await screen.findByText("Stored album masters removed. Your library tracks and saved metadata report remain available.");
  expect(albumCleanupStatus("memory-album")).toBeNull(); expect(total()).toBe(0); expect(localStorage.getItem("aurialis-state-v1")).toBe(storage);
  await navigator.locks.request("aurialis-album:memory-album", { ifAvailable: true }, (lock) => { acquired = lock !== null; }); expect(acquired).toBe(true);
});
