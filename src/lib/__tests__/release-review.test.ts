import { Blob as NativeBlob } from "node:buffer";
import { createHash, webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { measureAudio, previewWAV, serverRender, serverRenderScript } from "../browser-engine";
import { engineParams, exportParams } from "../engine-params";
import { reserveBrowserAudioMemory } from "../browser-jobs";
import type { ScriptV2 } from "../deep-mastering";
import { collectReleaseReview, readReleaseReport, releaseBindingHash, reserveReleaseReviewMemory } from "../release-review";
import { normalizeHydratedState, reduceStoreState } from "../store";
import type { MeasuredAudioMetrics, Track } from "../types";
import { testStore } from "./fixtures";

vi.mock("../browser-engine", async (original) => ({ ...await original<typeof import("../browser-engine")>(), measureAudio: vi.fn(), serverRender: vi.fn(), serverRenderScript: vi.fn() }));
const identity = { pcmHash: "b091c728c915b19f387a55e0ae9c3b6f69bdda55c17c02775aa414e8dd4208cd", sampleRate: 48000, frames: 1 };
const base = testStore.tracks[0]; if (!base) throw new Error("Missing source");
const track: Track = { ...base, duration: 1 / 48000, sourceIdentity: identity, sourceRevision: 4 };
const metrics: MeasuredAudioMetrics = { integratedLufs: -20, shortTermLufs: -20, truePeakDbtp: -6, samplePeakDbfs: -6, dynamicRangeDb: 0, correlation: 1, lowBassCorrelation: 1, dcLeftDbfs: -120, dcRightDbfs: -120, clippingSamples: 0, gainReductionDb: 0 };
const signal = () => new AbortController().signal;
function source(right = 1.25) { return previewWAV({ sampleRate: 48000, left: Float32Array.of(-0), right: Float32Array.of(right) }); }
function script(): ScriptV2 { return { version: "2.0", source: identity, revision: 1, profile: "Warm Analog", summary: "Test plan", chainParams: engineParams(track.advanced),
  sections: [{ id: "section-1", name: "Section 1", roleHint: "unknown", startFrame: 0, endFrame: 1, confidence: 0 }],
  moves: [{ id: "move-1", sectionId: "section-1", reason: "Test gain", target: "inputGainDb", operation: "add", points: [{ frame: 0, value: 0 }, { frame: 1, value: 0 }], fadeFrames: 0, muted: false }], findings: [], beforeMetrics: metrics }; }
beforeEach(() => {
  vi.stubGlobal("Blob", NativeBlob); vi.stubGlobal("crypto", webcrypto);
  vi.mocked(serverRender).mockResolvedValue(previewWAV({ sampleRate: 48000, left: Float32Array.of(0.5), right: Float32Array.of(0.5) }));
  vi.mocked(serverRenderScript).mockImplementation((...args) => serverRender(args[0], {}, args[2], args[3]));
  vi.mocked(measureAudio).mockResolvedValue({ sampleRate: 48000, frames: 1, duration: 1 / 48000, beforeMetrics: metrics, afterMetrics: metrics });
});
afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe("encoded release artifacts and saved receipts", () => {
  it("renders once, measures the final encoded file in bypass, and retains its exact bytes/hash", async () => {
    const blob = source(), abort = signal();
    const result = await collectReleaseReview(blob, track, 32, "Spotify", abort);
    expect(serverRender).toHaveBeenCalledExactlyOnceWith(blob, exportParams(track.advanced), 32, abort);
    expect(measureAudio).toHaveBeenCalledExactlyOnceWith(result.wav, { bypass: true }, abort);
    expect(result.report.output.sha256).toBe(createHash("sha256").update(new Uint8Array(await result.wav.arrayBuffer())).digest("hex"));
    expect(result.report.bindingHash).toBe(await releaseBindingHash(track, 32, abort));
    expect(result.report.metrics).toEqual(metrics); expect(readReleaseReport(result.report)).toEqual(result.report);
    result.dispose();
  });
  it("uses the accepted script and hashes all its content even when the revision number is unchanged", async () => {
    const applied = script(), deep: Track = { ...track, deepMastering: { sourceRevision: 4, proposal: applied, applied, targets: [] } };
    const result = await collectReleaseReview(source(), deep, 32, "Podcast", signal());
    expect(serverRenderScript).toHaveBeenCalledOnce(); expect(result.report.scriptRevision).toBe(1);
    expect(vi.mocked(serverRenderScript).mock.calls[0]?.[1].chainParams).toMatchObject({ algorithmVersion: 2, limiter: { truePeak: true } });
    const changed = structuredClone(deep); const point = changed.deepMastering?.applied?.moves[0]?.points[0]; if (!point) throw new Error("Missing point"); point.value = 3;
    expect(await releaseBindingHash(changed, 32, signal())).not.toBe(result.report.bindingHash);
    expect(await releaseBindingHash(deep, 24, signal())).not.toBe(result.report.bindingHash);
    result.dispose();
  });
  it("rejects changed source bytes and mismatched output measurements without publishing a report", async () => {
    await expect(collectReleaseReview(source(1.2), track, 32, "Spotify", signal())).rejects.toThrow(/PCM differs/u);
    expect(serverRender).not.toHaveBeenCalled();
    vi.mocked(measureAudio).mockResolvedValue({ sampleRate: 48000, frames: 2, duration: 2 / 48000, beforeMetrics: metrics, afterMetrics: metrics });
    await expect(collectReleaseReview(source(), track, 32, "Spotify", signal())).rejects.toThrow(/output layout/u);
  });
  it("honors late cancellation and saves only to the exact current track record", async () => {
    const result = await collectReleaseReview(source(), track, 32, "Spotify", signal());
    const state = { ...testStore, tracks: [track] };
    const saved = reduceStoreState(state, { type: "SAVE_RELEASE_REVIEW", expected: track, report: result.report });
    expect(saved.tracks[0]?.releaseReview).toEqual(result.report);
    const newer = { ...track, advanced: { ...track.advanced, input: 3 } };
    expect(reduceStoreState({ ...state, tracks: [newer] }, { type: "SAVE_RELEASE_REVIEW", expected: track, report: result.report }).tracks[0]?.releaseReview).toBeUndefined();
    result.dispose();
    const controller = new AbortController(); vi.mocked(measureAudio).mockImplementation(() => { controller.abort(); return Promise.resolve({ sampleRate: 48000, frames: 1, duration: 1 / 48000, beforeMetrics: metrics, afterMetrics: metrics }); });
    await expect(collectReleaseReview(source(), track, 32, "Spotify", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
  it("charges first source hashing and encoded inspection, then transfers only retained bytes", async () => {
    const blob = source(), memory = { update: vi.fn<(bytes: number) => void>(), dispose: vi.fn() };
    const originalRead = blob.arrayBuffer.bind(blob);
    vi.spyOn(blob, "arrayBuffer").mockImplementation(() => {
      expect(memory.update).toHaveBeenLastCalledWith(blob.size * 3 + 52);
      return originalRead();
    });
    vi.mocked(serverRender).mockImplementation(() => {
      expect(memory.update).toHaveBeenLastCalledWith(104);
      return Promise.resolve(previewWAV({ sampleRate: 48000, left: Float32Array.of(0.5), right: Float32Array.of(0.5) }));
    });
    vi.mocked(measureAudio).mockImplementation(() => {
      expect(memory.update).toHaveBeenLastCalledWith(104);
      return Promise.resolve({ sampleRate: 48000, frames: 1, duration: 1 / 48000, beforeMetrics: metrics, afterMetrics: metrics });
    });
    const retained = await collectReleaseReview(blob, track, 32, "Spotify", signal(), memory);
    expect(memory.update.mock.calls.map(([bytes]) => bytes)).toEqual([208, 104, 208, 104, 52]);
    expect(memory.dispose).not.toHaveBeenCalled();
    expect(retained.dispose).toBe(memory.dispose);
    retained.dispose(); expect(memory.dispose).toHaveBeenCalledOnce();
  });
  it("keeps the original source charged when inspection needs three encoded buffers", async () => {
    const other = reserveBrowserAudioMemory();
    const encoded = new ArrayBuffer(48), view = new DataView(encoded);
    new Uint8Array(encoded).set(new Uint8Array(await source().arrayBuffer()).subarray(0, 44));
    view.setUint32(4, 40, true); view.setUint16(20, 1, true); view.setUint32(28, 192000, true);
    view.setUint16(32, 4, true); view.setUint16(34, 16, true); view.setUint32(40, 4, true);
    view.setInt16(44, 16384, true); view.setInt16(46, 16384, true);
    const wav = new Blob([encoded]), read = vi.spyOn(wav, "arrayBuffer");
    vi.mocked(serverRender).mockImplementation(() => {
      // Three encoded copies alone fit exactly, but the still-live source must
      // make this inspection reject before reading the final encoded buffer.
      other.update(448 * 1024 * 1024 - wav.size * 3);
      return Promise.resolve(wav);
    });
    try {
      await expect(collectReleaseReview(source(), track, 16, "Spotify", signal())).rejects.toThrow("memory budget");
      expect(read).not.toHaveBeenCalled(); expect(measureAudio).not.toHaveBeenCalled();
    } finally { other.dispose(); }
  });
  it("releases supplied memory on validation, measurement and late-cancellation failures", async () => {
    const memory = { update: vi.fn<(bytes: number) => void>(), dispose: vi.fn() };
    await expect(collectReleaseReview(new Blob(["bad"]), track, 32, "Spotify", signal(), memory)).rejects.toThrow("source layout");
    expect(memory.dispose).toHaveBeenCalledOnce(); memory.dispose.mockClear();
    vi.mocked(measureAudio).mockRejectedValueOnce(new Error("Controlled final measurement failure"));
    await expect(collectReleaseReview(source(), track, 32, "Spotify", signal(), memory)).rejects.toThrow("final measurement failure");
    expect(memory.dispose).toHaveBeenCalledOnce(); memory.dispose.mockClear();
    const controller = new AbortController();
    vi.mocked(measureAudio).mockImplementationOnce(() => { controller.abort(); return Promise.resolve({ sampleRate: 48000, frames: 1, duration: 1 / 48000, beforeMetrics: metrics, afterMetrics: metrics }); });
    await expect(collectReleaseReview(source(), track, 32, "Spotify", controller.signal, memory)).rejects.toMatchObject({ name: "AbortError" });
    expect(memory.dispose).toHaveBeenCalledOnce();
  });
  it("rejects unsafe expected source admission before loading or hashing it", () => {
    const frames = 16_777_216, large = { ...track, duration: frames / 48000, sourceIdentity: { ...identity, frames } };
    expect(() => reserveReleaseReviewMemory(large, 32)).toThrow("memory budget");
    expect(serverRender).not.toHaveBeenCalled(); expect(measureAudio).not.toHaveBeenCalled();
  });
  it("restores a bounded valid receipt and discards malformed receipts without losing settings", async () => {
    const retained = await collectReleaseReview(source(), track, 32, "Spotify", signal());
    const { report } = retained;
    retained.dispose();
    expect(normalizeHydratedState({ ...testStore, tracks: [{ ...track, releaseReview: report }] })?.tracks[0]?.releaseReview).toEqual(report);
    for (const invalid of [{ ...report, output: { ...report.output, channels: 1 } }, { ...report, metrics: { ...report.metrics, integratedLufs: NaN } }, { ...report, bindingHash: "bad" }, { ...report, output: { ...report.output, bytes: 44 } }]) {
      expect(readReleaseReport(invalid)).toBeUndefined();
      const restored = normalizeHydratedState({ ...testStore, tracks: [{ ...track, releaseReview: invalid }] });
      expect(restored?.tracks[0]?.releaseReview).toBeUndefined(); expect(restored?.tracks[0]?.advanced).toEqual(track.advanced);
    }
  });
});
