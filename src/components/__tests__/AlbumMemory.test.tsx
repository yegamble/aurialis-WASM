import { Blob as NativeBlob } from "node:buffer";
import { webcrypto } from "node:crypto";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as engine from "@/lib/browser-engine";
import * as memory from "@/lib/browser-jobs";
import * as encoded from "@/lib/encoded-inspection";
import * as sourceReceipts from "@/lib/project-import";
import * as features from "@/lib/feature-analysis";
import { StoreProvider } from "@/lib/store";
import { testStore } from "@/lib/__tests__/fixtures";
import { AurialisWorkstation } from "../AurialisWorkstation";

const mocks = vi.hoisted(() => ({ getAudio: vi.fn() }));
vi.mock("@/lib/db", () => ({ getAudio: mocks.getAudio, saveAudio: vi.fn(), deleteAudio: vi.fn(), discardStagedAudio: vi.fn(), newAudioAssetId: vi.fn() }));
vi.mock("next/navigation", () => ({ usePathname: () => null }));
const reserve = memory.reserveBrowserAudioMemory;
const owners: { update: ReturnType<typeof vi.fn<(bytes: number) => void>>; dispose: ReturnType<typeof vi.fn<() => void>> }[] = [];
const metrics = { integratedLufs: -14, shortTermLufs: -14, truePeakDbtp: -6, samplePeakDbfs: -6, dynamicRangeDb: 8, correlation: 1, lowBassCorrelation: 1, dcLeftDbfs: -120, dcRightDbfs: -120, clippingSamples: 0, gainReductionDb: 0 };
const identity = { pcmHash: "a".repeat(64), sampleRate: 48000, frames: 48000 };
const canonicalBytes = 44 + identity.frames * 8, encodedBytes = 44 + identity.frames * 6;
const workBytes = 5 * canonicalBytes + 3 * encodedBytes;
let wav: Blob, canonical: Blob;
function mount() { return render(<StoreProvider><AurialisWorkstation route="album" paramId="memory-album" /></StoreProvider>); }
async function start() { fireEvent.click(await screen.findByRole("button", { name: "Render album masters" })); }

beforeEach(() => {
  owners.length = 0;
  vi.stubGlobal("Blob", NativeBlob); vi.stubGlobal("crypto", webcrypto);
  // Opaque controller artifacts only: core/native/browser tests verify actual WAV and source hashes.
  wav = new Blob([new Uint8Array(encodedBytes)]); canonical = new Blob([new Uint8Array(canonicalBytes)]);
  const tracks = testStore.tracks.map((track, index) => ({ ...track, sourceIdentity: identity, title: "Album source " + String(index + 1) }));
  const storage = new Map([["aurialis-state-v1", JSON.stringify({ tracks, albums: [{ id: "memory-album", title: "Memory album", artist: "", target: "−14 LUFS", trackIds: tracks.map((track) => track.id), mastered: false }], stems: [] })]]);
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value); } });
  window.history.replaceState(null, "", "/albums/memory-album");
  mocks.getAudio.mockReset().mockResolvedValue(canonical);
  vi.spyOn(memory, "reserveBrowserAudioMemory").mockImplementation((bytes = 0) => {
    const owned = reserve(bytes), observed = { update: vi.fn(owned.update), dispose: vi.fn(owned.dispose) };
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
  vi.spyOn(engine, "serverRender").mockImplementation((_source, _params, bits) => Promise.resolve(bits === 24 ? wav : canonical));
});
afterEach(() => { cleanup(); for (const owner of owners) owner.dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("charges transient work before rendering and retains the growing verified prefix until its order changes", async () => {
  mount();
  vi.mocked(engine.serverRender).mockImplementation((_source, _params, bits) => {
    expect(owners[1]?.update).toHaveBeenLastCalledWith(workBytes);
    return Promise.resolve(bits === 24 ? wav : canonical);
  });
  await start(); await screen.findByRole("button", { name: "Download Album source 2" });
  expect(owners).toHaveLength(2); expect(owners[0]?.update).toHaveBeenNthCalledWith(1, encodedBytes); expect(owners[0]?.update).toHaveBeenNthCalledWith(2, 2 * encodedBytes);
  expect(owners[0]?.dispose).not.toHaveBeenCalled(); expect(owners[1]?.dispose).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Move Album source 1 down" }));
  await waitFor(() => { expect(owners[0]?.dispose).toHaveBeenCalledOnce(); });
  expect(screen.queryByRole("region", { name: "Rendered album downloads" })).toBeNull();
});

it("releases failed transient work while preserving the verified prefix for an unchanged-cohort retry", async () => {
  mount(); let renders = 0;
  vi.mocked(engine.serverRender).mockImplementation((_source, _params, bits) => {
    renders++; return renders === 4 ? Promise.reject(new Error("Controlled second-track failure")) : Promise.resolve(bits === 24 ? wav : canonical);
  });
  await start(); await screen.findByText("Controlled second-track failure");
  expect(owners[0]?.update).toHaveBeenCalledExactlyOnceWith(encodedBytes); expect(owners[0]?.dispose).not.toHaveBeenCalled(); expect(owners[1]?.dispose).toHaveBeenCalledOnce();
  expect(screen.getByRole("button", { name: "Download Album source 1" })).toBeDefined(); expect(screen.queryByRole("button", { name: "Download Album source 2" })).toBeNull();
  await start(); await screen.findByRole("button", { name: "Download Album source 2" });
  expect(owners).toHaveLength(3); expect(owners[2]?.dispose).toHaveBeenCalledOnce(); expect(owners[0]?.update).toHaveBeenLastCalledWith(2 * encodedBytes);
  expect(vi.mocked(engine.serverRender).mock.calls.filter((call) => call[2] === 24)).toHaveLength(2);
});

it("releases the prefix on unmount, retains pending work until its late result settles and never publishes that WAV", async () => {
  const mounted = mount(); let finish: ((value: Blob) => void) | undefined;
  vi.mocked(engine.serverRender).mockImplementation(() => new Promise<Blob>((resolve) => { finish = resolve; }));
  await start(); await waitFor(() => { expect(finish).toBeTypeOf("function"); });
  expect(owners[1]?.update).toHaveBeenLastCalledWith(workBytes);
  mounted.unmount(); expect(owners[0]?.dispose).toHaveBeenCalledOnce(); expect(owners[1]?.dispose).not.toHaveBeenCalled();
  await act(async () => { finish?.(canonical); await Promise.resolve(); });
  expect(owners[1]?.dispose).toHaveBeenCalledOnce(); expect(owners[0]?.update).not.toHaveBeenCalled();
});

it("surfaces download allocation failure while preserving the already verified cache", async () => {
  mount(); await start(); const download = await screen.findByRole("button", { name: "Download Album source 2" });
  vi.mocked(memory.reserveBrowserAudioMemory).mockImplementationOnce(() => { throw new Error("Controlled download memory budget"); });
  fireEvent.click(download); expect(await screen.findByText("Controlled download memory budget")).toBeDefined();
  expect(screen.getByRole("region", { name: "Rendered album downloads" })).toBeDefined(); expect(owners[0]?.dispose).not.toHaveBeenCalled();
});
