import { Blob as NativeBlob } from "node:buffer";
import { createHash, webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { measureAudio, previewWAV, renderDelivery } from "../browser-engine";
import { CD_DELIVERY, DEFAULT_DELIVERY, type DeliveryFormat } from "../delivery-format";
import { engineParams, exportParams, exportRender } from "../engine-params";
import { reserveBrowserAudioMemory } from "../browser-jobs";
import type { ScriptV2 } from "../deep-mastering";
import { collectReleaseReview, readReleaseReport, releaseBindingHash, reserveReleaseReviewMemory } from "../release-review";
import { normalizeHydratedState, reduceStoreState } from "../store";
import type { MeasuredAudioMetrics, Track } from "../types";
import { testStore } from "./fixtures";

vi.mock("../browser-engine", async (original) => ({ ...await original<typeof import("../browser-engine")>(), measureAudio: vi.fn(), renderDelivery: vi.fn() }));
const bits = (bitDepth: 16 | 24 | 32): DeliveryFormat => ({ ...DEFAULT_DELIVERY, bitDepth });
const delivered = (blob: Blob) => Promise.resolve({ blob, truePeakDbtp: null });
/** A clean 16-bit stereo WAV of the given frames at the given rate. */
function pcm16(sampleRate: number, frames: number): Blob {
  const buffer = new ArrayBuffer(44 + frames * 4), view = new DataView(buffer), text = (at: number, value: string) => { for (let index = 0; index < value.length; index++) view.setUint8(at + index, value.charCodeAt(index)); };
  text(0, "RIFF"); view.setUint32(4, 36 + frames * 4, true); text(8, "WAVE"); text(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 2, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 4, true); view.setUint16(32, 4, true); view.setUint16(34, 16, true); text(36, "data"); view.setUint32(40, frames * 4, true);
  for (let frame = 0; frame < frames; frame++) { view.setInt16(44 + frame * 4, 8192, true); view.setInt16(46 + frame * 4, 8192, true); }
  return new Blob([buffer]);
}
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
  vi.mocked(renderDelivery).mockImplementation(() => delivered(previewWAV({ sampleRate: 48000, left: Float32Array.of(0.5), right: Float32Array.of(0.5) })));
  vi.mocked(measureAudio).mockResolvedValue({ sampleRate: 48000, frames: 1, duration: 1 / 48000, beforeMetrics: metrics, afterMetrics: metrics });
});
afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe("encoded release artifacts and saved receipts", () => {
  it("renders once, measures the final encoded file in bypass, and retains its exact bytes/hash", async () => {
    const blob = source(), abort = signal();
    const result = await collectReleaseReview(blob, track, bits(32), "Spotify", abort);
    expect(renderDelivery).toHaveBeenCalledExactlyOnceWith(blob, { params: exportParams(track.advanced) }, 32, {}, abort);
    expect(measureAudio).toHaveBeenCalledExactlyOnceWith(result.wav, { bypass: true }, abort);
    expect(result.report.output.sha256).toBe(createHash("sha256").update(new Uint8Array(await result.wav.arrayBuffer())).digest("hex"));
    expect(result.report.bindingHash).toBe(await releaseBindingHash(track, bits(32), abort));
    expect(result.report.metrics).toEqual(metrics); expect(readReleaseReport(result.report)).toEqual(result.report);
    result.dispose();
  });
  it("uses the accepted script and hashes all its content even when the revision number is unchanged", async () => {
    const applied = script(), deep: Track = { ...track, deepMastering: { sourceRevision: 4, proposal: applied, applied, targets: [] } };
    const result = await collectReleaseReview(source(), deep, bits(32), "Podcast", signal());
    expect(renderDelivery).toHaveBeenCalledOnce(); expect(result.report.scriptRevision).toBe(1);
    const rendered = vi.mocked(renderDelivery).mock.calls[0]?.[1];
    expect(rendered && "script" in rendered ? rendered.script.chainParams : undefined).toMatchObject({ algorithmVersion: 2, limiter: { truePeak: true } });
    const changed = structuredClone(deep); const point = changed.deepMastering?.applied?.moves[0]?.points[0]; if (!point) throw new Error("Missing point"); point.value = 3;
    expect(await releaseBindingHash(changed, bits(32), signal())).not.toBe(result.report.bindingHash);
    expect(await releaseBindingHash(deep, bits(24), signal())).not.toBe(result.report.bindingHash);
    result.dispose();
  });
  it("rejects changed source bytes and mismatched output measurements without publishing a report", async () => {
    await expect(collectReleaseReview(source(1.2), track, bits(32), "Spotify", signal())).rejects.toThrow(/PCM differs/u);
    expect(renderDelivery).not.toHaveBeenCalled();
    vi.mocked(measureAudio).mockResolvedValue({ sampleRate: 48000, frames: 2, duration: 2 / 48000, beforeMetrics: metrics, afterMetrics: metrics });
    await expect(collectReleaseReview(source(), track, bits(32), "Spotify", signal())).rejects.toThrow(/output layout/u);
  });
  it("honors late cancellation and saves only to the exact current track record", async () => {
    const result = await collectReleaseReview(source(), track, bits(32), "Spotify", signal());
    const state = { ...testStore, tracks: [track] };
    const saved = reduceStoreState(state, { type: "SAVE_RELEASE_REVIEW", expected: track, report: result.report });
    expect(saved.tracks[0]?.releaseReview).toEqual(result.report);
    const newer = { ...track, advanced: { ...track.advanced, input: 3 } };
    expect(reduceStoreState({ ...state, tracks: [newer] }, { type: "SAVE_RELEASE_REVIEW", expected: track, report: result.report }).tracks[0]?.releaseReview).toBeUndefined();
    result.dispose();
    const controller = new AbortController(); vi.mocked(measureAudio).mockImplementation(() => { controller.abort(); return Promise.resolve({ sampleRate: 48000, frames: 1, duration: 1 / 48000, beforeMetrics: metrics, afterMetrics: metrics }); });
    await expect(collectReleaseReview(source(), track, bits(32), "Spotify", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
  it("charges first source hashing and encoded inspection, then transfers only retained bytes", async () => {
    const blob = source(), memory = { update: vi.fn<(bytes: number) => void>(), dispose: vi.fn() };
    const originalRead = blob.arrayBuffer.bind(blob);
    vi.spyOn(blob, "arrayBuffer").mockImplementation(() => {
      expect(memory.update).toHaveBeenLastCalledWith(blob.size * 3 + 52);
      return originalRead();
    });
    vi.mocked(renderDelivery).mockImplementation(() => {
      expect(memory.update).toHaveBeenLastCalledWith(104);
      return delivered(previewWAV({ sampleRate: 48000, left: Float32Array.of(0.5), right: Float32Array.of(0.5) }));
    });
    vi.mocked(measureAudio).mockImplementation(() => {
      expect(memory.update).toHaveBeenLastCalledWith(104);
      return Promise.resolve({ sampleRate: 48000, frames: 1, duration: 1 / 48000, beforeMetrics: metrics, afterMetrics: metrics });
    });
    const retained = await collectReleaseReview(blob, track, bits(32), "Spotify", signal(), memory);
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
    vi.mocked(renderDelivery).mockImplementation(() => {
      // Three encoded copies alone fit exactly, but the still-live source must
      // make this inspection reject before reading the final encoded buffer.
      other.update(448 * 1024 * 1024 - wav.size * 3);
      return delivered(wav);
    });
    try {
      await expect(collectReleaseReview(source(), track, bits(16), "Spotify", signal())).rejects.toThrow("memory budget");
      expect(read).not.toHaveBeenCalled(); expect(measureAudio).not.toHaveBeenCalled();
    } finally { other.dispose(); }
  });
  it("releases supplied memory on validation, measurement and late-cancellation failures", async () => {
    const memory = { update: vi.fn<(bytes: number) => void>(), dispose: vi.fn() };
    await expect(collectReleaseReview(new Blob(["bad"]), track, bits(32), "Spotify", signal(), memory)).rejects.toThrow("source layout");
    expect(memory.dispose).toHaveBeenCalledOnce(); memory.dispose.mockClear();
    vi.mocked(measureAudio).mockRejectedValueOnce(new Error("Controlled final measurement failure"));
    await expect(collectReleaseReview(source(), track, bits(32), "Spotify", signal(), memory)).rejects.toThrow("final measurement failure");
    expect(memory.dispose).toHaveBeenCalledOnce(); memory.dispose.mockClear();
    const controller = new AbortController();
    vi.mocked(measureAudio).mockImplementationOnce(() => { controller.abort(); return Promise.resolve({ sampleRate: 48000, frames: 1, duration: 1 / 48000, beforeMetrics: metrics, afterMetrics: metrics }); });
    await expect(collectReleaseReview(source(), track, bits(32), "Spotify", controller.signal, memory)).rejects.toMatchObject({ name: "AbortError" });
    expect(memory.dispose).toHaveBeenCalledOnce();
  });
  it("rejects unsafe expected source admission before loading or hashing it", () => {
    const frames = 16_777_216, large = { ...track, duration: frames / 48000, sourceIdentity: { ...identity, frames } };
    expect(() => reserveReleaseReviewMemory(large, bits(32))).toThrow("memory budget");
    expect(renderDelivery).not.toHaveBeenCalled(); expect(measureAudio).not.toHaveBeenCalled();
  });
  it("renders the Export delivery request and measures the converted file it delivers", async () => {
    const abort = signal(), wav = pcm16(44100, 1);
    vi.mocked(renderDelivery).mockImplementation(() => delivered(wav));
    vi.mocked(measureAudio).mockResolvedValue({ sampleRate: 44100, frames: 1, duration: 1 / 44100, beforeMetrics: metrics, afterMetrics: metrics });
    const blob = source(), result = await collectReleaseReview(blob, track, CD_DELIVERY, "CD", abort);
    expect(renderDelivery).toHaveBeenCalledExactlyOnceWith(blob, exportRender(track), 16, { sampleRate: 44100 }, abort);
    expect(result.wav).toBe(wav);
    expect(result.report.output).toMatchObject({ sampleRate: 44100, frames: 1, bitDepth: 16, bytes: wav.size });
    expect(result.report.dither).toBe("tpdf");
    expect(result.report.source.sampleRate).toBe(48000);
    expect(readReleaseReport(result.report)).toEqual(result.report);
    result.dispose();
    // A delivered file at the source rate, or of the wrong converted length, is refused.
    vi.mocked(measureAudio).mockResolvedValue({ sampleRate: 48000, frames: 1, duration: 1 / 48000, beforeMetrics: metrics, afterMetrics: metrics });
    await expect(collectReleaseReview(source(), track, CD_DELIVERY, "CD", signal())).rejects.toThrow(/output layout/u);
    vi.mocked(renderDelivery).mockImplementation(() => delivered(pcm16(48000, 1)));
    await expect(collectReleaseReview(source(), track, CD_DELIVERY, "CD", signal())).rejects.toThrow(/expected clean WAV/u);
  });
  it("binds the check to the delivery rate and dither, keeping the default format's earlier binding", async () => {
    const cd = await releaseBindingHash(track, CD_DELIVERY, signal());
    const sourceRate = await releaseBindingHash(track, { ...CD_DELIVERY, sampleRate: "source" }, signal());
    const undithered = await releaseBindingHash(track, { ...CD_DELIVERY, dither: false }, signal());
    expect(new Set([cd, sourceRate, undithered]).size).toBe(3);
    // 32-bit float carries no dither, so the dither choice cannot change its file.
    expect(await releaseBindingHash(track, { bitDepth: 32, sampleRate: "source", dither: false }, signal())).toBe(await releaseBindingHash(track, bits(32), signal()));
    const legacy = createHash("sha256").update(JSON.stringify({ id: track.id, title: track.title, audio: track.sourceAudioId ?? track.id, sourceRevision: 4, source: identity, bits: 24, params: engineParams(track.advanced), script: null })).digest("hex");
    expect(await releaseBindingHash(track, DEFAULT_DELIVERY, signal())).toBe(legacy);
  });
  it("restores a converted receipt, defaults an earlier receipt's dither and rejects an impossible converted length", async () => {
    vi.mocked(renderDelivery).mockImplementation(() => delivered(pcm16(44100, 1)));
    vi.mocked(measureAudio).mockResolvedValue({ sampleRate: 44100, frames: 1, duration: 1 / 44100, beforeMetrics: metrics, afterMetrics: metrics });
    const retained = await collectReleaseReview(source(), track, CD_DELIVERY, "CD", signal()); retained.dispose();
    const { dither: _dither, ...earlier } = retained.report;
    expect(readReleaseReport(earlier)?.dither).toBe("tpdf");
    expect(readReleaseReport({ ...retained.report, output: { ...retained.report.output, frames: 2, bytes: 44 + 8 } })).toBeUndefined();
    expect(readReleaseReport({ ...retained.report, output: { ...retained.report.output, sampleRate: 22050 } })).toBeUndefined();
    expect(readReleaseReport({ ...retained.report, dither: "noise" })).toBeUndefined();
  });
  it("restores a bounded valid receipt and discards malformed receipts without losing settings", async () => {
    const retained = await collectReleaseReview(source(), track, bits(32), "Spotify", signal());
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
