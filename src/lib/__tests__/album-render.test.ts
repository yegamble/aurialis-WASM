import { Blob as NativeBlob } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderAlbumTrack, measureAlbumTrack, AlbumSourceMismatchError, type AlbumRenderContext } from "../album-render";
import { engineParams, measureAudio, measureScriptAudio, serverRenderOwned } from "../browser-engine";
import { getAudio } from "../db";
import { inspectEncodedWAV } from "../encoded-inspection";
import { analyzeSourceFeatures } from "../feature-analysis";
import { verifyCanonicalSource } from "../project-import";
import { qualifyProcessingBuild } from "../processing-build";
import { ProcessingBuildMismatchError } from "../processing-identity";
import type { AlbumTrackRecipe } from "../album-binding";
import type { OwnedAudioResult } from "../browser-jobs";
import type { MeasuredAudioMetrics } from "../types";
import { testStore } from "./fixtures";
vi.mock("../db", () => ({ getAudio: vi.fn() }));
vi.mock("../browser-engine", async (original) => ({ ...await original<typeof import("../browser-engine")>(), serverRenderOwned: vi.fn(), measureAudio: vi.fn(), measureScriptAudio: vi.fn() }));
vi.mock("../encoded-inspection", () => ({ inspectEncodedWAV: vi.fn() }));
vi.mock("../feature-analysis", () => ({ analyzeSourceFeatures: vi.fn() }));
vi.mock("../project-import", () => ({ verifyCanonicalSource: vi.fn() }));
vi.mock("../processing-build", () => ({ qualifyProcessingBuild: vi.fn() }));
const frames = 1024, sampleRate = 48000, canonicalBytes = 44 + frames * 8, encodedBytes = 44 + frames * 6, build = "a".repeat(64);
const source = { pcmHash: "b".repeat(64), frames, sampleRate }, featureSource = { ...source, pcmHash: "c".repeat(64) };
const metrics: MeasuredAudioMetrics = { integratedLufs: -18, shortTermLufs: -18, truePeakDbtp: -6, samplePeakDbfs: -6, dynamicRangeDb: 12, correlation: 1, lowBassCorrelation: 1, dcLeftDbfs: -120, dcRightDbfs: -120, clippingSamples: 0, gainReductionDb: 0 };
const edges = [20, 120, 500, 2000, 6000, 20000], bands = edges.slice(0, -1).map((lowHz, index) => ({ lowHz, highHz: edges.at(index + 1) ?? 0, usableHighHz: edges.at(index + 1) ?? 0, powerDb: -20, valid: true }));
function recipe(): AlbumTrackRecipe {
  const track = testStore.tracks[0]; if (!track) throw new Error("Missing track");
  return { version: 1, id: "song", title: "Song", audioKey: "immutable-source", source, sourceRevision: 2, duration: frames / sampleRate, sampleRate,
    params: engineParams(track.advanced), script: null, encoding: { version: 1, bits: 24, channels: 2, frames, sampleRate } };
}
function memory(limit = 512 * 1024 * 1024) {
  const owners: { bytes: number; updates: number[]; disposed: boolean }[] = [];
  const reserve = (bytes: number) => {
    const row = { bytes: 0, updates: [] as number[], disposed: false };
    const update = (next: number) => { if (row.disposed || next + owners.reduce((sum, item) => sum + item.bytes, 0) > limit + row.bytes) throw new Error("Memory denied before allocation"); row.bytes = next; row.updates.push(next); };
    owners.push(row); update(bytes); return { update, dispose: () => { row.bytes = 0; row.disposed = true; } };
  };
  return { reserve, owners, total: () => owners.reduce((sum, item) => sum + item.bytes, 0) };
}
function context(owned = memory(), controller = new AbortController()): AlbumRenderContext {
  return { reserve: owned.reserve, processingBuild: build, signal: controller.signal, check: () => { controller.signal.throwIfAborted(); } };
}
function ownedAudio(bytes: number, memoryOwner: ReturnType<typeof memory>): OwnedAudioResult {
  const owner = memoryOwner.reserve(bytes);
  // Opaque controller fixtures; encoded PCM/CDR/Go-WASM correctness has separate gates.
  return { blob: new Blob([new Uint8Array(bytes)]), owner, dispose: owner.dispose };
}
beforeEach(() => {
  vi.stubGlobal("Blob", NativeBlob);
  vi.mocked(getAudio).mockImplementation(() => Promise.resolve(new Blob([new Uint8Array(canonicalBytes)])));
  vi.mocked(verifyCanonicalSource).mockImplementation((_blob, expected) => Promise.resolve(expected));
  vi.mocked(qualifyProcessingBuild).mockResolvedValue(build);
  vi.mocked(measureAudio).mockResolvedValue({ frames, sampleRate, duration: frames / sampleRate, beforeMetrics: metrics, afterMetrics: metrics });
  vi.mocked(measureScriptAudio).mockResolvedValue({ frames, sampleRate, duration: frames / sampleRate, beforeMetrics: metrics, afterMetrics: metrics });
  vi.mocked(inspectEncodedWAV).mockImplementation((_blob, bits) => { if (bits !== 24 && bits !== 32) throw new Error("Wrong output depth"); return Promise.resolve({ sha256: "d".repeat(64), encoding: { frames, sampleRate, channels: 2, bitDepth: bits, fullScaleFrames: 0, leadingSilenceFrames: 0, trailingSilenceFrames: 0, silenceThresholdDbfs: -60 } }); });
  vi.mocked(analyzeSourceFeatures).mockResolvedValue({ source: featureSource, bands, sections: [], warnings: [] });
});
afterEach(() => { vi.restoreAllMocks(); vi.resetAllMocks(); vi.unstubAllGlobals(); });
describe("single-track owned Album phases", () => {
  it("drops source and chain ownership before later phases and returns only one final owned encoded WAV", async () => {
    const owners = memory(), ctx = context(owners), input = recipe(), original = structuredClone(input), outputs: OwnedAudioResult[] = [];
    vi.mocked(serverRenderOwned).mockImplementation((_file, _processing, layout) => {
      if (outputs.length === 1) expect(owners.owners[0]?.disposed).toBe(true); // Original source dropped before pure gain.
      if (outputs.length === 2) expect(owners.owners[1]?.disposed).toBe(true); // Chain dropped before final measurement/feature decode.
      const output = ownedAudio(layout.bitDepth === 24 ? encodedBytes : canonicalBytes, owners); outputs.push(output); return Promise.resolve(output);
    });
    const result = await renderAlbumTrack(input, 2, ctx);
    expect(result.master).toBe(outputs[1]); expect(result.metrics).toEqual(metrics); expect(result.bands).toEqual(bands);
    expect(owners.total()).toBe(encodedBytes); expect(owners.owners.filter((owner) => !owner.disposed)).toHaveLength(1);
    expect(owners.owners[1]?.updates).toEqual([canonicalBytes, canonicalBytes * 3, canonicalBytes]);
    expect(owners.owners[2]?.updates).toEqual([encodedBytes, encodedBytes * 3, encodedBytes]);
    expect(owners.owners[3]?.updates).toEqual([canonicalBytes, canonicalBytes * 3, canonicalBytes, canonicalBytes * 3]);
    expect(vi.mocked(serverRenderOwned).mock.calls[1]?.[1]).toMatchObject({ params: { inputGainDb: 2, eqEnabled: false, limiter: { enabled: false }, compressor: { enabled: false } } });
    expect(vi.mocked(serverRenderOwned).mock.calls[2]?.[0]).toBe(result.master.blob); expect(vi.mocked(serverRenderOwned).mock.calls[2]?.[1]).toEqual({ params: { bypass: true } });
    expect(measureAudio).toHaveBeenCalledWith(result.master.blob, { bypass: true }, ctx.signal, build);
    expect(analyzeSourceFeatures).toHaveBeenCalledWith(outputs[2]?.blob, ctx.signal, expect.any(Function), build);
    expect(getAudio).toHaveBeenCalledTimes(2); expect(qualifyProcessingBuild).toHaveBeenCalledTimes(5); expect(input).toEqual(original);
    result.master.dispose(); expect(owners.total()).toBe(0);
  });
  it("admits all three source hash copies before loading and releases first-pass measurement sources", async () => {
    const small = memory(canonicalBytes * 3 - 1);
    await expect(measureAlbumTrack(recipe(), context(small))).rejects.toThrow(/Memory/u); expect(getAudio).not.toHaveBeenCalled();
    const owners = memory(), ctx = context(owners), measured = await measureAlbumTrack(recipe(), ctx);
    expect(measured.afterMetrics).toEqual(metrics); expect(owners.total()).toBe(0); expect(getAudio).toHaveBeenCalledTimes(2);
    expect(owners.owners.every((owner) => owner.updates[0] === canonicalBytes * 3 && owner.disposed)).toBe(true);
  });
  it("passes the exact accepted Deep packet to full-chain measurement and rendering", async () => {
    const owners = memory(), input = recipe();
    const script = { version: "2.0" as const, source, revision: 3, profile: "Warm Analog" as const, summary: "Accepted", chainParams: input.params,
      sections: [{ id: "all", name: "All", roleHint: "unknown" as const, startFrame: 0, endFrame: frames, confidence: 0 }], moves: [], findings: [], beforeMetrics: metrics };
    const deep = { ...input, script }; vi.mocked(serverRenderOwned).mockImplementation((_file, _processing, layout) => Promise.resolve(ownedAudio(layout.bitDepth === 24 ? encodedBytes : canonicalBytes, owners)));
    await measureAlbumTrack(deep, context(owners)); const result = await renderAlbumTrack(deep, 0, context(owners));
    expect(vi.mocked(serverRenderOwned).mock.calls[0]?.[1]).toEqual({ script }); expect(measureScriptAudio).toHaveBeenCalledWith(expect.any(Blob), script, expect.any(AbortSignal), build);
    result.master.dispose(); expect(owners.total()).toBe(0);
  });
  it("keeps the source charged while a canceled render is still pending and disposes its late owned result", async () => {
    const owners = memory(), controller = new AbortController(); let finish: ((value: OwnedAudioResult) => void) | undefined;
    vi.mocked(serverRenderOwned).mockReturnValue(new Promise<OwnedAudioResult>((resolve) => { finish = resolve; }));
    const pending = renderAlbumTrack(recipe(), 0, context(owners, controller)), rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => { expect(serverRenderOwned).toHaveBeenCalledOnce(); }); controller.abort();
    expect(owners.total()).toBe(canonicalBytes); finish?.(ownedAudio(canonicalBytes, owners)); await rejected; expect(owners.total()).toBe(0);
  });
  it("invalidates a changed producer before the next stage and discards the previous owned chain", async () => {
    const owners = memory(); vi.mocked(qualifyProcessingBuild).mockResolvedValueOnce(build).mockResolvedValueOnce("f".repeat(64));
    vi.mocked(serverRenderOwned).mockImplementation((_file, _processing, layout) => Promise.resolve(ownedAudio(layout.bitDepth === 24 ? encodedBytes : canonicalBytes, owners)));
    await expect(renderAlbumTrack(recipe(), 0, context(owners))).rejects.toBeInstanceOf(ProcessingBuildMismatchError); expect(serverRenderOwned).toHaveBeenCalledOnce(); expect(owners.total()).toBe(0);
  });
  it("keeps hash and inspection copies charged until their actual canceled operations settle", async () => {
    const owners = memory(), controller = new AbortController(); let finish: (() => void) | undefined;
    vi.mocked(verifyCanonicalSource).mockImplementationOnce(() => new Promise((resolve) => { finish = () => { resolve(source); }; }));
    const sourcePending = measureAlbumTrack(recipe(), context(owners, controller)), sourceRejected = expect(sourcePending).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => { expect(verifyCanonicalSource).toHaveBeenCalledOnce(); }); controller.abort();
    expect(owners.total()).toBe(canonicalBytes * 3); expect(measureAudio).not.toHaveBeenCalled(); finish?.(); await sourceRejected; expect(owners.total()).toBe(0);
    const next = new AbortController(); vi.mocked(serverRenderOwned).mockImplementation((_file, _processing, layout) => Promise.resolve(ownedAudio(layout.bitDepth === 24 ? encodedBytes : canonicalBytes, owners)));
    vi.mocked(inspectEncodedWAV).mockImplementationOnce(() => new Promise((resolve) => { finish = () => { resolve({ sha256: "d".repeat(64), encoding: { frames, sampleRate, channels: 2, bitDepth: 32, fullScaleFrames: 0, leadingSilenceFrames: 0, trailingSilenceFrames: 0, silenceThresholdDbfs: -60 } }); }; }));
    const chainPending = renderAlbumTrack(recipe(), 0, context(owners, next)), chainRejected = expect(chainPending).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => { expect(inspectEncodedWAV).toHaveBeenCalledOnce(); }); next.abort(); expect(owners.total()).toBe(canonicalBytes * 3);
    finish?.(); await chainRejected; expect(serverRenderOwned).toHaveBeenCalledOnce(); expect(owners.total()).toBe(0);
  });
  it("counts the encoded master alongside the fresh source hash before its second load", async () => {
    const owners = memory(), input = recipe(); let calls = 0;
    vi.mocked(serverRenderOwned).mockImplementation((_file, _processing, layout) => Promise.resolve(ownedAudio(layout.bitDepth === 24 ? encodedBytes : canonicalBytes, owners)));
    vi.mocked(getAudio).mockImplementation(() => {
      calls++; expect(owners.total()).toBe(canonicalBytes * 3 + (calls === 2 ? encodedBytes : 0));
      return Promise.resolve(new Blob([new Uint8Array(canonicalBytes)]));
    });
    const result = await renderAlbumTrack(input, 0, context(owners)); expect(calls).toBe(2); result.master.dispose(); expect(owners.total()).toBe(0);
  });
  it("declines malformed chain audio before pure gain and verifies a fresh source again before publication", async () => {
    const owners = memory(); vi.mocked(serverRenderOwned).mockImplementation((_file, _processing, layout) => Promise.resolve(ownedAudio(layout.bitDepth === 24 ? encodedBytes : canonicalBytes, owners)));
    vi.mocked(inspectEncodedWAV).mockRejectedValueOnce(new Error("Non-finite chain"));
    await expect(renderAlbumTrack(recipe(), 0, context(owners))).rejects.toThrow(/Non-finite/u); expect(serverRenderOwned).toHaveBeenCalledOnce(); expect(owners.total()).toBe(0);
    vi.mocked(getAudio).mockClear().mockResolvedValueOnce(new Blob([new Uint8Array(canonicalBytes)])).mockResolvedValueOnce(new Blob([new Uint8Array(canonicalBytes + 8)]));
    await expect(renderAlbumTrack(recipe(), 0, context(owners))).rejects.toBeInstanceOf(AlbumSourceMismatchError); expect(owners.total()).toBe(0);
  });
});
