import { engineParams, measureAudio, measureScriptAudio, serverRender, serverRenderScript } from "./browser-engine";
import { getAudio } from "./db";
import { inspectEncodedWAV } from "./encoded-inspection";
import { analyzeSourceFeatures, type FeatureMeasurements } from "./feature-analysis";
import { audioKey } from "./library";
import { verifyCanonicalSource } from "./project-import";
import { albumTargets, planAlbumGain, type AlbumGainMode, type AlbumGainPlan, type AlbumReading } from "./album-consistency";
import type { Album, MeasuredAudioMetrics, SourceIdentity, Track } from "./types";

const maxCacheBytes = 128 * 1024 * 1024;
const metricKeys = ["integratedLufs", "shortTermLufs", "truePeakDbtp", "samplePeakDbfs", "dynamicRangeDb", "correlation", "lowBassCorrelation", "dcLeftDbfs", "dcRightDbfs", "clippingSamples", "gainReductionDb"] as const;
type AlbumMemoryOwner = Readonly<{ update: (bytes: number) => void; dispose: () => void }>;
export type AlbumMemoryFactory = (bytes: number) => AlbumMemoryOwner;
type GainRow = AlbumGainPlan["tracks"][number];
type AlbumOutputRow = AlbumReading & {
  source: SourceIdentity; sourceRevision: number; audioKey: string;
  beforeMetrics: MeasuredAudioMetrics; processingHash: string; scriptRevision: number | null;
  gain: GainRow; output: Awaited<ReturnType<typeof inspectEncodedWAV>> & { bytes: number };
};
export type AlbumReport = {
  version: 1; createdAt: string; albumId: string; title: string; artist: string;
  bindingHash: string; target: number; mode: AlbumGainMode; cohortIds: string[];
  medianTrackLufs: number | null; commonGainDb: number | null; complete: boolean; tracks: AlbumOutputRow[];
};
export type AlbumProgress = { stage: string; completed: number; total: number; report: AlbumReport | null };

export function albumTarget(album: Album): number {
  const value = Number(album.target.replace("−", "-").replace(/\s*LUFS\s*$/u, ""));
  return albumTargets.some((target) => target === value) ? value : -14;
}
/** Only report metadata is excluded: saving a report cannot change audible processing. */
export function albumCohortKey(album: Album, tracks: readonly Track[]): string {
  const { report: _report, ...record } = album;
  return JSON.stringify({ album: record, tracks: tracks.map((track) => ({ id: track.id, title: track.title,
    audioKey: audioKey(track), source: track.sourceIdentity, sourceRevision: track.sourceRevision ?? 0,
    sampleRate: track.sampleRate, duration: track.duration, params: engineParams(track.advanced),
    script: track.deepMastering?.applied ?? null })), bits: 24 });
}
async function hashText(value: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  signal.throwIfAborted();
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
function identity(track: Track): SourceIdentity {
  const source = track.sourceIdentity;
  if (typeof track.title !== "string" || !track.title.trim() || track.title.length > 1024
    || !Number.isFinite(track.duration) || track.duration <= 0 || !Number.isSafeInteger(track.sourceRevision ?? 0) || (track.sourceRevision ?? 0) < 0
    || !source || !Number.isSafeInteger(source.frames) || source.frames < 1 || source.frames > 16_777_216
    || !Number.isSafeInteger(source.sampleRate) || source.sampleRate !== track.sampleRate || source.sampleRate < 8000 || source.sampleRate > 192000
    || !/^[a-f0-9]{64}$/u.test(source.pcmHash) || Math.abs(source.frames / source.sampleRate - track.duration) > 0.001)
    throw new Error(`Restore the matching source for “${track.title}” in Library before rendering this sequence.`);
  return source;
}
function assertLayout(measured: { frames: number; sampleRate: number }, source: SourceIdentity) {
  if (measured.frames !== source.frames || measured.sampleRate !== source.sampleRate)
    throw new Error("A rendered track changed its sample count or sample rate. No new master was retained.");
}
/** Every non-gain module is explicitly disabled; this stage does not normalize or limit. */
export function albumLinearParams(gainDb: number) {
  if (!Number.isFinite(gainDb) || Math.abs(gainDb) > 36) throw new Error("Album gain must be within 36 dB.");
  return { bypass: false, abOriginal: false, loudnessMatchAb: false, inputGainDb: gainDb, eqEnabled: false,
    compressor: { enabled: false }, saturation: { enabled: false }, stereo: { enabled: false },
    limiter: { enabled: false }, repair: { enabled: false }, deHarsh: { enabled: false }, multiband: { enabled: false }, ditherBits: 0 };
}

/** Own one unchanged cohort and its verified completed prefix. Audio never enters a saved report. */
export class AlbumBatch {
  readonly key: string;
  private readonly album: Album;
  private readonly tracks: Track[];
  private readonly reserve: AlbumMemoryFactory;
  private readonly prefixMemory: AlbumMemoryOwner;
  private prefixBytes = 0;
  private disposed = false;
  private active: AbortController | null = null;
  private readings: AlbumReading[] | null = null;
  private plan: AlbumGainPlan | null = null;
  private report: AlbumReport | null = null;
  private readonly outputs: { id: string; title: string; wav: Blob }[] = [];
  constructor(album: Album, tracks: readonly Track[], reserve: AlbumMemoryFactory) {
    if (!tracks.length || tracks.length > 64 || tracks.length !== album.trackIds.length
      || tracks.some((track, index) => track.id !== album.trackIds.at(index))
      || new Set(tracks.map((track) => track.id)).size !== tracks.length) throw new Error("Choose between one and 64 different, available album tracks.");
    if (typeof album.title !== "string" || !album.title.trim() || album.title.length > 1024 || typeof album.artist !== "string" || album.artist.length > 1024)
      throw new Error("Give the album and every track a name before rendering.");
    const target = Number(album.target.replace("−", "-").replace(/\s*LUFS\s*$/u, ""));
    if (!albumTargets.some((item) => item === target)) throw new Error("Choose a supported album target before rendering.");
    if (tracks.some((track) => { const offset = album.offsets?.[track.id] ?? 0; return !Number.isFinite(offset) || Math.abs(offset) > 6; }))
      throw new Error("Choose manual offsets within six dB.");
    let expectedBytes = 0;
    for (const track of tracks) expectedBytes += identity(track).frames * 6 + 44;
    if (expectedBytes > maxCacheBytes) throw new Error("This sequence exceeds the 128 MiB encoded download cache. Use a smaller album or export tracks individually.");
    this.key = albumCohortKey(album, tracks); this.album = structuredClone(album); this.tracks = structuredClone([...tracks]);
    this.reserve = reserve; this.prefixMemory = reserve(0);
  }
  canResume() { return !this.disposed; }
  getFiles() { return this.outputs.map((item) => ({ ...item })); }
  getReport() { return this.report; }
  cancel() { this.active?.abort(); }
  dispose() {
    this.disposed = true; this.cancel(); this.outputs.length = 0; this.report = null; this.readings = null;
    this.prefixBytes = 0; this.prefixMemory.dispose();
  }
  async run(isCurrent: () => boolean, onProgress: (value: AlbumProgress) => void): Promise<AlbumReport> {
    if (this.disposed || this.active) throw new Error("This album job is no longer available or is already running.");
    const controller = new AbortController(), signal = controller.signal;
    const work = this.reserve(0);
    this.active = controller;
    const check = () => { signal.throwIfAborted(); if (this.disposed || !isCurrent()) { this.dispose(); throw new Error("The sequence, source or settings changed. Render the updated album again."); } };
    const progress = (stage: string) => { check(); onProgress({ stage, completed: this.outputs.length, total: this.tracks.length, report: this.report }); };
    try {
      check();
      const bindingHash = await hashText(this.key, signal); check();
      if (!this.readings) {
        const readings: AlbumReading[] = [];
        for (const track of this.tracks) {
          const source = identity(track), canonicalBytes = 44 + source.frames * 8;
          // Source Blob, verification arrayBuffer and WebCrypto input snapshot; workers reserve their own job/clone bytes.
          work.update(canonicalBytes * 3); progress(`Measuring accepted chain ${String(readings.length + 1)} of ${String(this.tracks.length)}: ${track.title}`);
          const blob = await this.verifiedSource(track, signal, check);
          const applied = track.deepMastering?.applied;
          const measurement = applied ? await measureScriptAudio(blob, applied, signal) : await measureAudio(blob, engineParams(track.advanced), signal);
          check(); assertLayout(measurement, source); await verifyCanonicalSource(blob, source, signal); check();
          readings.push({ id: track.id, title: track.title, duration: track.duration, metrics: measurement.afterMetrics, bands: [] });
          work.update(0);
        }
        this.readings = readings;
      }
      else {
        // Resume only after re-verifying every source, including the retained completed prefix.
        for (const track of this.tracks) {
          const expected = identity(track); work.update((44 + expected.frames * 8) * 3);
          await this.verifiedSource(track, signal, check); check(); work.update(0);
        }
      }
      const mode = this.album.gainMode ?? "relationships", target = albumTarget(this.album);
      this.plan ??= planAlbumGain(this.readings, target, mode, this.tracks.map((track) => this.album.offsets?.[track.id] ?? 0));
      this.report ??= { version: 1, createdAt: new Date().toISOString(), albumId: this.album.id, title: this.album.title, artist: this.album.artist,
        bindingHash, target, mode, cohortIds: this.tracks.map((track) => track.id), medianTrackLufs: this.plan.medianTrackLufs,
        commonGainDb: this.plan.commonGainDb, complete: false, tracks: [] };
      for (let index = this.outputs.length; index < this.tracks.length; index++) {
        const track = this.tracks.at(index), gain = this.plan.tracks.at(index), before = this.readings.at(index);
        if (!track || !gain || !before) throw new Error("The planned sequence is incomplete.");
        const source = identity(track), canonicalBytes = 44 + source.frames * 8, encodedBytes = 44 + source.frames * 6;
        // Conservatively covers original source, full-chain and final canonical Blobs (3*C),
        // source verification arrayBuffer + WebCrypto snapshot (2*C), and encoded Blob/scan/hash copies (3*E).
        // Prefix and worker job/clone owners overlap this reservation until every async operation returns.
        work.update(canonicalBytes * 5 + encodedBytes * 3);
        progress(`Rendering and verifying ${String(index + 1)} of ${String(this.tracks.length)}: ${track.title}`);
        const result = await this.renderTrack(track, gain, before, source, signal, check);
        check();
        this.prefixMemory.update(this.prefixBytes + result.wav.size);
        this.prefixBytes += result.wav.size;
        this.outputs.push({ id: track.id, title: track.title, wav: result.wav });
        this.report = { ...this.report, tracks: [...this.report.tracks, result.row], complete: this.outputs.length === this.tracks.length };
        work.update(0); progress(this.report.complete ? "All measured masters are ready." : `${String(this.outputs.length)} verified master(s) retained.`);
      }
      check(); return this.report;
    } finally {
      work.dispose(); if (this.active === controller) this.active = null;
    }
  }
  private async verifiedSource(track: Track, signal: AbortSignal, check: () => void): Promise<Blob> {
    const blob = await getAudio(audioKey(track)); check();
    if (!blob) { this.dispose(); throw new Error(`The source for “${track.title}” is missing. Restore it in Library.`); }
    try { await verifyCanonicalSource(blob, identity(track), signal); }
    catch (cause) { if (!signal.aborted) this.dispose(); throw cause; }
    check(); return blob;
  }
  private async renderTrack(track: Track, gain: GainRow, before: AlbumReading, source: SourceIdentity, signal: AbortSignal, check: () => void) {
    const blob = await this.verifiedSource(track, signal, check);
    const applied = track.deepMastering?.applied, params = engineParams(track.advanced);
    const chain = applied ? await serverRenderScript(blob, applied, 32, signal) : await serverRender(blob, params, 32, signal);
    check();
    await inspectEncodedWAV(chain, 32, source, signal); check();
    const wav = await serverRender(chain, albumLinearParams(gain.gainDb), 24, signal); check();
    const output = await inspectEncodedWAV(wav, 24, source, signal); check();
    const measured = await measureAudio(wav, { bypass: true }, signal); check(); assertLayout(measured, source);
    const canonical = await serverRender(wav, { bypass: true }, 32, signal); check();
    const features = await analyzeSourceFeatures(canonical, signal, () => undefined); check(); assertLayout(features.source, source);
    await verifyCanonicalSource(canonical, features.source, signal); check();
    await verifyCanonicalSource(blob, source, signal); check();
    const processingHash = await hashText(JSON.stringify({ params, script: applied ?? null, gainDb: gain.gainDb }), signal); check();
    if (!validBands(features.bands)) throw new Error("The final audio features contain invalid spectral coverage.");
    const row: AlbumOutputRow = { id: track.id, title: track.title, duration: track.duration, source: { ...source }, sourceRevision: track.sourceRevision ?? 0,
      audioKey: audioKey(track), beforeMetrics: { ...before.metrics }, metrics: measured.afterMetrics, bands: features.bands,
      processingHash, scriptRevision: applied?.revision ?? null, gain: { ...gain }, output: { ...output, bytes: wav.size } };
    return { wav, row };
  }
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function validMetrics(value: unknown): value is MeasuredAudioMetrics {
  const metrics = record(value);
  return !!metrics && Object.keys(metrics).length === metricKeys.length
    && Object.entries(metrics).every(([key, number]) => metricKeys.some((name) => name === key) && typeof number === "number" && Number.isFinite(number));
}
function validBands(value: unknown): value is FeatureMeasurements["bands"] {
  const edges = [20, 120, 500, 2000, 6000, 20000];
  return Array.isArray(value) && value.length === 5 && value.every((unknownBand: unknown, index) => {
    const band = record(unknownBand);
    return !!band && Object.keys(band).length === 5 && band.lowHz === edges.at(index) && band.highHz === edges.at(index + 1)
      && typeof band.lowHz === "number" && typeof band.highHz === "number" && typeof band.usableHighHz === "number" && Number.isFinite(band.usableHighHz)
      && band.usableHighHz >= band.lowHz && band.usableHighHz <= band.highHz && typeof band.powerDb === "number" && Number.isFinite(band.powerDb) && typeof band.valid === "boolean";
  });
}
/** Strict, bounded metadata reader; a restored report never restores download ownership. */
export function readAlbumReport(value: unknown): AlbumReport | undefined {
  const report = record(value);
  if (!report) return undefined;
  try { if (JSON.stringify(report).length > 262_144) return undefined; } catch { return undefined; }
  const hash = (candidate: unknown) => typeof candidate === "string" && /^[a-f0-9]{64}$/u.test(candidate);
  const text = (candidate: unknown) => typeof candidate === "string" && candidate.length > 0 && candidate.length <= 1024;
  const finite = (candidate: unknown): candidate is number => typeof candidate === "number" && Number.isFinite(candidate);
  const whole = (candidate: unknown): candidate is number => finite(candidate) && Number.isSafeInteger(candidate);
  if (Object.keys(report).length !== 13 || report.version !== 1 || !text(report.albumId) || !text(report.title) || typeof report.artist !== "string" || report.artist.length > 1024
    || typeof report.createdAt !== "string" || !Number.isFinite(Date.parse(report.createdAt)) || !hash(report.bindingHash)
    || !albumTargets.some((item) => item === report.target) || !["relationships", "normalize", "manual"].some((item) => item === report.mode)
    || typeof report.complete !== "boolean" || !Array.isArray(report.cohortIds) || report.cohortIds.length < 1 || report.cohortIds.length > 64
    || !report.cohortIds.every(text) || new Set(report.cohortIds).size !== report.cohortIds.length || !Array.isArray(report.tracks)
    || report.tracks.length > report.cohortIds.length || (report.complete && report.tracks.length !== report.cohortIds.length)
    || !(report.medianTrackLufs === null || finite(report.medianTrackLufs)) || !(report.commonGainDb === null || finite(report.commonGainDb))) return undefined;
  for (const [index, unknownRow] of report.tracks.entries()) {
    const row = record(unknownRow); if (!row) return undefined;
    const source = record(row.source), output = record(row.output), gain = record(row.gain), encoding = record(output?.encoding);
    if (!source || !output || !gain || !encoding || Object.keys(row).length !== 13 || Object.keys(source).length !== 3 || Object.keys(output).length !== 3
      || Object.keys(encoding).length !== 8 || Object.keys(gain).length !== 5 || row.id !== report.cohortIds.at(index) || !text(row.title) || !text(row.audioKey)
      || !hash(source.pcmHash) || !whole(source.frames) || source.frames < 1 || source.frames > 16_777_216 || !whole(source.sampleRate)
      || source.sampleRate < 8000 || source.sampleRate > 192000 || !finite(row.duration) || Math.abs(row.duration - source.frames / source.sampleRate) > 0.001
      || !whole(row.sourceRevision) || row.sourceRevision < 0 || !hash(row.processingHash) || !(row.scriptRevision === null || whole(row.scriptRevision) && row.scriptRevision > 0)
      || !validMetrics(row.metrics) || !validMetrics(row.beforeMetrics) || !validBands(row.bands) || gain.id !== row.id || !finite(gain.gainDb) || Math.abs(gain.gainDb) > 36
      || !(gain.requestedLufs === null || finite(gain.requestedLufs)) || typeof gain.measurable !== "boolean" || ![null, "peak", "gain-range"].some((item) => item === gain.limitedBy)
      || !hash(output.sha256) || output.bytes !== 44 + source.frames * 6 || encoding.sampleRate !== source.sampleRate || encoding.frames !== source.frames
      || encoding.channels !== 2 || encoding.bitDepth !== 24 || encoding.silenceThresholdDbfs !== -60
      || ![encoding.fullScaleFrames, encoding.leadingSilenceFrames, encoding.trailingSilenceFrames].every((count) => whole(count) && count >= 0 && whole(source.frames) && count <= source.frames)) return undefined;
  }
  return structuredClone(report) as unknown as AlbumReport;
}
