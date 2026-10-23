import { Blob as NativeBlob } from "node:buffer";
import { createHash, webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AlbumBatch, albumCohortKey, albumLinearParams, readAlbumReport, type AlbumMemoryFactory } from "../album-batch";
import { clampAdvancedToSampleRate } from "../audio-dsp";
import { engineParams, measureAudio, measureScriptAudio, previewWAV, serverRender, serverRenderScript } from "../browser-engine";
import { getAudio } from "../db";
import { analyzeSourceFeatures } from "../feature-analysis";
import { normalizeHydratedState, reduceStoreState } from "../store";
import type { Album, MeasuredAudioMetrics, SourceIdentity, Track } from "../types";
import { testStore } from "./fixtures";

vi.mock("../db", () => ({ getAudio: vi.fn() }));
vi.mock("../feature-analysis", () => ({ analyzeSourceFeatures: vi.fn() }));
vi.mock("../browser-engine", async (original) => ({ ...await original<typeof import("../browser-engine")>(), measureAudio: vi.fn(), measureScriptAudio: vi.fn(), serverRender: vi.fn(), serverRenderScript: vi.fn() }));
const rate = 8000, frames = 4096;
const paths = new Map<string, Blob>();
const edges = [20, 120, 500, 2000, 6000, 20000];
const bands = edges.slice(0, -1).map((lowHz, index) => ({ lowHz, highHz: edges.at(index + 1) ?? 0,
  usableHighHz: Math.max(lowHz, Math.min(rate / 2, edges.at(index + 1) ?? 0)), powerDb: -20, valid: lowHz < rate / 2 }));
function memory(budget = 1024 * 1024 * 1024) {
  const owners: { bytes: number; disposed: boolean }[] = [];
  const reserve: AlbumMemoryFactory = (initial) => {
    const owner = { bytes: 0, disposed: false };
    const update = (bytes: number) => {
      if (owner.disposed || bytes + owners.filter((item) => item !== owner && !item.disposed).reduce((sum, item) => sum + item.bytes, 0) > budget) throw new Error("Device memory budget exceeded.");
      owner.bytes = bytes;
    };
    owners.push(owner); update(initial);
    return { update, dispose: () => { owner.disposed = true; owner.bytes = 0; } };
  };
  return { reserve, owners, total: () => owners.filter((item) => !item.disposed).reduce((sum, item) => sum + item.bytes, 0) };
}
async function sourceIdentity(blob: Blob): Promise<SourceIdentity> {
  const bytes = await blob.arrayBuffer(), view = new DataView(bytes), sampleRate = view.getUint32(24, true), count = (bytes.byteLength - 44) / 8;
  view.setUint32(28, sampleRate, true); view.setUint32(32, 2, true); view.setBigUint64(36, BigInt(count), true);
  return { pcmHash: createHash("sha256").update(new Uint8Array(bytes, 28)).digest("hex"), sampleRate, frames: count };
}
async function samples(blob: Blob) {
  const view = new DataView(await blob.arrayBuffer()), bits = view.getUint16(34, true), stride = bits / 8;
  const values = new Float32Array((view.byteLength - 44) / stride);
  for (let index = 0; index < values.length; index++) {
    const offset = 44 + index * stride;
    if (bits === 32) values.set([view.getFloat32(offset, true)], index);
    else if (bits === 24) { const raw = view.getUint8(offset) | view.getUint8(offset + 1) << 8 | view.getUint8(offset + 2) << 16; values.set([(raw << 8 >> 8) / 8388608], index); }
    else values.set([view.getInt16(offset, true) / 32768], index);
  }
  return values;
}
async function encode(blob: Blob, bits: 16 | 24 | 32, gain = 0) {
  const input = await samples(blob), data = new ArrayBuffer(44 + input.length * bits / 8), view = new DataView(data), stride = bits / 8;
  const label = (value: string, offset: number) => { for (let index = 0; index < value.length; index++) view.setUint8(offset + index, value.charCodeAt(index)); };
  label("RIFF", 0); view.setUint32(4, data.byteLength - 8, true); label("WAVE", 8); label("fmt ", 12); view.setUint32(16, 16, true); view.setUint16(20, bits === 32 ? 3 : 1, true);
  view.setUint16(22, 2, true); view.setUint32(24, rate, true); view.setUint32(28, rate * stride * 2, true); view.setUint16(32, stride * 2, true); view.setUint16(34, bits, true); label("data", 36); view.setUint32(40, data.byteLength - 44, true);
  for (let index = 0; index < input.length; index++) {
    const sample = (input.at(index) ?? 0) * 10 ** (gain / 20), offset = 44 + index * stride;
    if (bits === 32) view.setFloat32(offset, sample, true);
    else if (bits === 24) { const raw = Math.max(-8388608, Math.min(8388607, Math.round(sample * 8388608))); view.setUint8(offset, raw & 255); view.setUint8(offset + 1, raw >> 8 & 255); view.setUint8(offset + 2, raw >> 16 & 255); }
    else view.setInt16(offset, Math.round(sample * 32768), true);
  }
  return new Blob([data], { type: "audio/wav" });
}
async function metrics(blob: Blob): Promise<MeasuredAudioMetrics> {
  const input = await samples(blob), peak = Math.max(...input.map(Math.abs));
  const rms = Math.sqrt(input.reduce((sum, value) => sum + value * value, 0) / input.length);
  const rmsDb = rms ? 20 * Math.log10(rms) : -120, peakDb = peak ? 20 * Math.log10(peak) : -120;
  return { integratedLufs: rms ? rmsDb - 0.7 : -70, shortTermLufs: rms ? rmsDb - 0.7 : -70, truePeakDbtp: peakDb, samplePeakDbfs: peakDb,
    dynamicRangeDb: rms ? peakDb - rmsDb : 0, correlation: 1, lowBassCorrelation: 1, dcLeftDbfs: -120, dcRightDbfs: -120, clippingSamples: 0, gainReductionDb: 0 };
}
async function fixture() {
  const base = testStore.tracks.at(0); if (!base) throw new Error("Missing fixture");
  const tracks: Track[] = [];
  for (const [index, level] of [0.1, 0.2].entries()) {
    const wave = Float32Array.from({ length: frames }, (_, frame) => Math.sin(frame * 2 * Math.PI * 500 / rate) * level);
    const blob = previewWAV({ sampleRate: rate, left: wave, right: wave });
    const track: Track = { ...structuredClone(base), id: `track-${String(index)}`, title: `Song ${String(index)}`, sampleRate: rate, duration: frames / rate, sourceIdentity: await sourceIdentity(blob), sourceRevision: 2, advanced: clampAdvancedToSampleRate(base.advanced, rate) };
    tracks.push(track); paths.set(track.id, blob);
  }
  const album: Album = { id: "album-test", title: "Sequence", artist: "Artist", target: "−14 LUFS", trackIds: tracks.map((track) => track.id), mastered: false, gainMode: "relationships", offsets: {} };
  return { album, tracks };
}
beforeEach(() => {
  vi.stubGlobal("Blob", NativeBlob); vi.stubGlobal("crypto", webcrypto);
  vi.mocked(getAudio).mockImplementation((id) => Promise.resolve(paths.get(id)));
  vi.mocked(serverRender).mockImplementation((blob, params, bits) => encode(blob, bits, (params as { inputGainDb?: number }).inputGainDb ?? 0));
  vi.mocked(serverRenderScript).mockImplementation((blob, script, bits) => encode(blob, bits, script.moves.at(0)?.points.at(0)?.value ?? 0));
  vi.mocked(measureAudio).mockImplementation(async (blob) => { const measured = await metrics(blob); return { sampleRate: rate, frames, duration: frames / rate, beforeMetrics: measured, afterMetrics: measured }; });
  vi.mocked(measureScriptAudio).mockImplementation((blob) => measureAudio(blob));
  vi.mocked(analyzeSourceFeatures).mockImplementation(async (blob) => ({ source: await sourceIdentity(blob), bands, sections: [{ id: "all", name: "All", startFrame: 0, endFrame: frames, confidence: 0 }], warnings: [] }));
});
afterEach(() => { paths.clear(); vi.restoreAllMocks(); vi.resetAllMocks(); vi.unstubAllGlobals(); });

describe("album batch ownership and final encoded measurement", () => {
  it("plans the complete cohort before rendering, applies a separate pure-gain stage, and measures the exact retained 24-bit WAV", async () => {
    const { album, tracks } = await fixture(), owners = memory(), batch = new AlbumBatch(album, tracks, owners.reserve);
    const original = structuredClone(tracks), stages: string[] = [];
    const report = await batch.run(() => true, (value) => { stages.push(value.stage); });
    expect(stages.slice(0, 2).every((stage) => stage.startsWith("Measuring accepted chain"))).toBe(true);
    expect(report.complete).toBe(true); expect(report.tracks).toHaveLength(2); expect(readAlbumReport(report)).toEqual(report);
    const files = batch.getFiles(); expect(files).toHaveLength(2);
    for (const [index, file] of files.entries()) {
      const row = report.tracks.at(index); if (!row) throw new Error("Missing row");
      expect(row.output.sha256).toBe(createHash("sha256").update(new Uint8Array(await file.wav.arrayBuffer())).digest("hex"));
      expect(row.metrics).toEqual(await metrics(file.wav)); expect(row.output.encoding).toMatchObject({ frames, sampleRate: rate, bitDepth: 24 });
      expect(vi.mocked(measureAudio).mock.calls.some((call) => call[0] === file.wav && JSON.stringify(call[1]) === '{"bypass":true}')).toBe(true);
    }
    const gainStages = vi.mocked(serverRender).mock.calls.filter((call) => call[2] === 24);
    expect(gainStages).toHaveLength(2); expect(gainStages.every((call) => JSON.stringify(call[1]) === JSON.stringify(albumLinearParams(report.tracks[0]?.gain.gainDb ?? 0)))).toBe(true);
    expect(tracks).toEqual(original); expect(owners.total()).toBe(files.reduce((sum, file) => sum + file.wav.size, 0));
    batch.dispose(); expect(owners.total()).toBe(0); expect(batch.getFiles()).toHaveLength(0); expect(owners.owners.every((owner) => owner.disposed)).toBe(true);
  });
  it("retains a verified prefix after cancellation and retries only the unfinished outputs after full source re-verification", async () => {
    const { album, tracks } = await fixture(), owners = memory(), batch = new AlbumBatch(album, tracks, owners.reserve);
    await expect(batch.run(() => true, (value) => { if (value.completed === 1) batch.cancel(); })).rejects.toMatchObject({ name: "AbortError" });
    const first = batch.getFiles().at(0)?.wav; expect(first).toBeDefined(); expect(batch.getReport()?.complete).toBe(false);
    expect(owners.owners.filter((owner) => !owner.disposed)).toHaveLength(1);
    const report = await batch.run(() => true, () => undefined);
    expect(report.complete).toBe(true); expect(batch.getFiles()[0]?.wav).toBe(first);
    expect(vi.mocked(serverRender).mock.calls.filter((call) => call[2] === 24)).toHaveLength(2);
    expect(getAudio).toHaveBeenCalledTimes(6); // Initial two measurements, two renders, all two sources checked again on resume.
    batch.dispose();
  });
  it("rejects late stale cohort work, cancellation during a current track and all late publication", async () => {
    const { album, tracks } = await fixture(), owners = memory(), batch = new AlbumBatch(album, tracks, owners.reserve);
    let current = true;
    vi.mocked(serverRender).mockImplementationOnce(async (blob, _params, bits) => { current = false; return encode(blob, bits); });
    await expect(batch.run(() => current, () => undefined)).rejects.toThrow(/changed/u);
    expect(batch.getFiles()).toHaveLength(0); expect(owners.total()).toBe(0);
    await expect(batch.run(() => true, () => undefined)).rejects.toThrow(/no longer/u);
    const next = new AlbumBatch(album, tracks, owners.reserve);
    vi.mocked(serverRender).mockImplementationOnce(async (blob, _params, bits) => { next.cancel(); return encode(blob, bits); });
    await expect(next.run(() => true, () => undefined)).rejects.toMatchObject({ name: "AbortError" });
    expect(next.getFiles()).toHaveLength(0); next.dispose(); expect(owners.total()).toBe(0);
  });
  it("rejects memory/cache/track-limit jobs before audio allocation and disposes failed transient owners", async () => {
    const { album, tracks } = await fixture(), owners = memory(1000), batch = new AlbumBatch(album, tracks, owners.reserve);
    await expect(batch.run(() => true, () => undefined)).rejects.toThrow(/memory/u); expect(getAudio).not.toHaveBeenCalled();
    expect(owners.total()).toBe(0); expect(owners.owners.filter((owner) => !owner.disposed)).toHaveLength(1); batch.dispose();
    const huge = tracks.map((track) => ({ ...track, duration: 16_777_216 / rate, sourceIdentity: { pcmHash: "a".repeat(64), frames: 16_777_216, sampleRate: rate } }));
    expect(() => new AlbumBatch(album, huge, memory().reserve)).toThrow(/128 MiB/u);
    expect(() => new AlbumBatch({ ...album, trackIds: Array.from({ length: 65 }, (_, i) => `x${String(i)}`) }, Array.from({ length: 65 }, (_, i) => ({ ...tracks[0] as Track, id: `x${String(i)}` })), memory().reserve)).toThrow(/64/u);
  });
  it("reserves first-use source hash copies before reading and counts a retained prefix alongside another active owner", async () => {
    const { album, tracks } = await fixture(), canonicalBytes = 44 + frames * 8, encodedBytes = 44 + frames * 6;
    const blob = paths.get(tracks[0]?.id ?? ""); if (!blob) throw new Error("Missing source");
    const read = vi.spyOn(blob, "arrayBuffer");
    const tooSmall = memory(canonicalBytes * 3 - 1), denied = new AlbumBatch(album, tracks, tooSmall.reserve);
    await expect(denied.run(() => true, () => undefined)).rejects.toThrow(/memory/u);
    expect(getAudio).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled(); denied.dispose();
    const renderBytes = canonicalBytes * 5 + encodedBytes * 3;
    const owners = memory(renderBytes + encodedBytes), batch = new AlbumBatch(album, tracks, owners.reserve);
    let external: ReturnType<AlbumMemoryFactory> | undefined;
    await expect(batch.run(() => true, (progress) => { if (progress.completed === 1) external = owners.reserve(1); })).rejects.toThrow(/memory/u);
    expect(batch.getFiles()).toHaveLength(1); expect(getAudio).toHaveBeenCalledTimes(3);
    expect(owners.total()).toBe(encodedBytes + 1); expect(owners.owners.filter((owner) => !owner.disposed)).toHaveLength(2);
    external?.dispose(); batch.dispose(); expect(owners.total()).toBe(0);
  });
  it("preserves the full accepted Deep script and binds every authored point, title, source and album setting", async () => {
    const { album, tracks } = await fixture(), first = tracks[0]; if (!first?.sourceIdentity) throw new Error("Missing source");
    const measurement = await metrics(paths.get(first.id) as Blob);
    const script = { version: "2.0" as const, source: first.sourceIdentity, revision: 1, profile: "Warm Analog" as const, summary: "Applied plan", chainParams: engineParams(first.advanced),
      sections: [{ id: "all", name: "All", roleHint: "unknown" as const, startFrame: 0, endFrame: frames, confidence: 0 }],
      moves: [{ id: "gain", sectionId: "all", reason: "Lift", target: "inputGainDb" as const, operation: "add" as const, points: [{ frame: 0, value: 2 }, { frame: frames, value: 2 }], fadeFrames: 0, muted: false }], findings: [], beforeMetrics: measurement };
    first.deepMastering = { sourceRevision: 2, proposal: script, applied: script, targets: [] };
    const original = structuredClone(tracks), batch = new AlbumBatch(album, tracks, memory().reserve);
    const report = await batch.run(() => true, () => undefined);
    expect(serverRenderScript).toHaveBeenCalledWith(paths.get(first.id), script, 32, expect.any(AbortSignal)); expect(measureScriptAudio).toHaveBeenCalled();
    expect(report.tracks[0]?.scriptRevision).toBe(1); expect(tracks).toEqual(original);
    const key = albumCohortKey(album, tracks), changed = structuredClone(tracks), point = changed[0]?.deepMastering?.applied?.moves[0]?.points[0]; if (!point) throw new Error("Missing point"); point.value = 3;
    expect(albumCohortKey(album, changed)).not.toBe(key);
    for (const updated of [{ ...album, target: "−23 LUFS" }, { ...album, artist: "Other" }, { ...album, trackIds: [...album.trackIds].reverse() }, { ...album, offsets: { [first.id]: 1 } }]) expect(albumCohortKey(updated, tracks)).not.toBe(key);
    expect(albumCohortKey({ ...album, report }, tracks)).toBe(key); batch.dispose();
  });
  it("refuses malformed final artifacts, layout drift and changed source bytes without publishing an unverified file", async () => {
    const { album, tracks } = await fixture();
    const original = vi.mocked(serverRender).getMockImplementation(); if (!original) throw new Error("Missing renderer");
    vi.mocked(serverRender).mockImplementation((blob, params, bits, signal) => bits === 24 ? Promise.resolve(new Blob(["bad output"])) : original(blob, params, bits, signal));
    const batch = new AlbumBatch(album, tracks, memory().reserve);
    await expect(batch.run(() => true, () => undefined)).rejects.toThrow(/layout|length/u); expect(batch.getFiles()).toHaveLength(0); batch.dispose();
    vi.mocked(serverRender).mockImplementation(original);
    const second = new AlbumBatch(album, tracks, memory().reserve);
    await expect(second.run(() => true, (value) => { if (value.completed === 1) second.cancel(); })).rejects.toMatchObject({ name: "AbortError" });
    paths.set(tracks[0]?.id ?? "", previewWAV({ sampleRate: rate, left: new Float32Array(frames), right: new Float32Array(frames) }));
    await expect(second.run(() => true, () => undefined)).rejects.toThrow(/PCM differs/u); expect(second.getFiles()).toHaveLength(0); expect(second.getReport()).toBeNull();
  });
  it("discards every completed output if any source changes between cohort planning and its render", async () => {
    const { album, tracks } = await fixture(), owners = memory(), batch = new AlbumBatch(album, tracks, owners.reserve);
    await expect(batch.run(() => true, (value) => {
      if (value.completed === 1) paths.set(tracks[1]?.id ?? "", previewWAV({ sampleRate: rate, left: new Float32Array(frames), right: new Float32Array(frames) }));
    })).rejects.toThrow(/PCM differs/u);
    expect(batch.getFiles()).toHaveLength(0); expect(batch.getReport()).toBeNull(); expect(owners.total()).toBe(0); expect(batch.canResume()).toBe(false);
  });
  it("keeps a saved import visible in Library when a queued album change wins the full-record attach CAS", async () => {
    const { album, tracks } = await fixture(), track = tracks[0]; if (!track) throw new Error("Missing source");
    const newer = { ...album, title: "Changed during import" };
    const state = { tracks: [], albums: [newer], stems: [] };
    const result = reduceStoreState(state, { type: "IMPORT_ALBUM_TRACK", expected: album, track });
    expect(result.tracks).toEqual([track]); expect(result.albums).toEqual([newer]);
    const added = reduceStoreState({ ...state, albums: [] }, { type: "ADD_ALBUM", album });
    expect(added.albums[0]).toMatchObject({ gainMode: "relationships", offsets: {} }); expect(typeof added.albums[0]?.updatedAt).toBe("string");
  });
  it("saves metadata with a complete cohort CAS and drops malformed optional receipts while preserving legacy albums/settings", async () => {
    const { album, tracks } = await fixture(), batch = new AlbumBatch(album, tracks, memory().reserve), report = await batch.run(() => true, () => undefined);
    const state = { tracks, albums: [album], stems: [] };
    const saved = reduceStoreState(state, { type: "SAVE_ALBUM_REPORT", expected: album, tracks, report });
    expect(saved.albums[0]?.report).toBe(report); expect(saved.tracks).toBe(tracks); expect(saved.albums[0]?.updatedAt).toBe(album.updatedAt);
    const newer = { ...tracks[0] as Track, title: "New title" };
    expect(reduceStoreState({ ...state, tracks: [newer, ...tracks.slice(1)] }, { type: "SAVE_ALBUM_REPORT", expected: album, tracks, report })).toMatchObject({ albums: [album] });
    const badRows: unknown[] = [null, { ...report.tracks[0], metrics: { integratedLufs: -14 } }, { ...report.tracks[0], output: { ...report.tracks[0]?.output, bytes: 44 } }];
    for (const invalid of [{ ...report, tracks: badRows }, { ...report, title: "x".repeat(262_144) }, { ...report, bindingHash: "bad" }, { ...report, tracks: [null] }, { ...report, complete: true, tracks: [] }]) {
      expect(readAlbumReport(invalid)).toBeUndefined();
      const hydrated = normalizeHydratedState({ ...state, albums: [{ ...album, report: invalid }] });
      expect(hydrated?.albums[0]?.report).toBeUndefined(); expect(hydrated?.albums[0]?.title).toBe(album.title); expect(hydrated?.tracks[0]?.advanced).toEqual(tracks[0]?.advanced);
    }
    const cyclic: { value?: unknown } = {}; cyclic.value = cyclic; expect(readAlbumReport(cyclic)).toBeUndefined();
    expect(readAlbumReport(report)).toEqual(report); batch.dispose();
  });
});
