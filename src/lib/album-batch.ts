import { markAlbumCleanup, completeAlbumCleanup, type AlbumCleanupCapability } from "./album-cleanup";
import { AlbumRecipeBinding, AlbumRecipeMismatchError, albumRecordKey, type AlbumTrackRecipe } from "./album-binding";
import { AlbumSpool, maximumAlbumSpoolBytes, type AlbumSpoolOutput } from "./album-spool";
import { AlbumSourceMismatchError, measureAlbumTrack, renderAlbumTrack, verifyAlbumTrackSource, type AlbumRenderContext } from "./album-render";
import { inspectEncodedWAV } from "./encoded-inspection";
import { audioKey } from "./library";
import { downloadLocalBlobAndWait } from "./download";
import { qualifyProcessingBuild } from "./processing-build";
import { ProcessingBuildMismatchError } from "./processing-identity";
import { boundedMetadata } from "./script-metadata";
import { albumTargets, planAlbumGain, type AlbumGainMode, type AlbumGainPlan, type AlbumReading } from "./album-consistency";
import type { FeatureMeasurements } from "./feature-analysis";
import type { Album, MeasuredAudioMetrics, SourceIdentity, Track } from "./types";

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
type AlbumMasterFile = { id: string; title: string; index: number; bytes: number };
export function albumTarget(album: Album): number {
  const value = Number(album.target.replace("−", "-").replace(/\s*LUFS\s*$/u, ""));
  return albumTargets.some((target) => target === value) ? value : -14;
}
/** Process-local CAS token; deterministic persisted binding is computed sequentially under metadata ownership. */
export const albumCohortKey = albumRecordKey;
export { albumLinearParams } from "./album-consistency";
class AlbumCohortMismatchError extends Error {
  constructor(cause?: unknown) { super("The sequence, source or full settings changed. Plan the complete album again.", { cause }); this.name = "AlbumCohortMismatchError"; }
}
class AlbumStoredMismatchError extends Error {
  constructor() { super("The freshly rendered master does not match the stored album output. No stored output was authorized. Render the complete sequence again."); this.name = "AlbumStoredMismatchError"; }
}
function admitReportMetadata(album: Album, tracks: readonly Track[]): void {
  // A 32-ASCII-character placeholder exceeds finite binary64 JSON width, including fixed decimals. Original strings are referenced, never copied here.
  const metric = "0".repeat(32), metrics = Object.fromEntries(metricKeys.map((key) => [key, metric]));
  const rows = tracks.map((track) => {
    const source = track.sourceIdentity; if (!source) throw new Error("Restore every album source before rendering.");
    return { id: track.id, title: track.title, duration: track.duration, source, sourceRevision: track.sourceRevision ?? 0, audioKey: audioKey(track),
      beforeMetrics: metrics, metrics, processingHash: "f".repeat(64), scriptRevision: Number.MAX_SAFE_INTEGER,
      bands: Array.from({ length: 5 }, () => ({ lowHz: metric, highHz: metric, usableHighHz: metric, powerDb: metric, valid: false })),
      gain: { id: track.id, gainDb: metric, requestedLufs: metric, limitedBy: "gain-range", measurable: false },
      output: { sha256: "f".repeat(64), bytes: 44 + source.frames * 6, encoding: { frames: source.frames, sampleRate: source.sampleRate, channels: 2, bitDepth: 24,
        fullScaleFrames: source.frames, leadingSilenceFrames: source.frames, trailingSilenceFrames: source.frames, silenceThresholdDbfs: -60 } } };
  });
  const template = { version: 1, createdAt: "2026-10-23T00:00:00.000Z", albumId: album.id, title: album.title, artist: album.artist, bindingHash: "f".repeat(64),
    target: albumTarget(album), mode: album.gainMode ?? "relationships", cohortIds: tracks.map((track) => track.id), medianTrackLufs: metric, commonGainDb: metric, complete: false, tracks: rows };
  try {
    if (boundedMetadata(template, 256 * 1024) * 2 + 256 * 1024 > 2 * 1024 * 1024) throw new Error("Report capacity");
  } catch (cause) { throw new Error("This sequence exceeds the bounded album report metadata capacity. Shorten its labels or use a smaller sequence.", { cause }); }
}
/** Metadata-only session. Encoded files remain in the dedicated local spool between sequential phases. */
export class AlbumBatch {
  readonly key: string;
  private readonly binding: AlbumRecipeBinding;
  private readonly receiptMemory: AlbumMemoryOwner;
  private tracks: readonly Track[];
  private album: Album;
  private readonly albumId: string;
  private readonly cleanupCapability: AlbumCleanupCapability = Object.freeze({ retry: () => this.dispose(true) });
  private disposed = false;
  private discardStored = false;
  private active: AbortController | null = null;
  private activeWork: Promise<void> | null = null;
  private closing: Promise<void> | null = null;
  private terminalStarted = false;
  private spool: AlbumSpool | null = null;
  private spoolBound = false;
  private pauseFailed = false;
  private processingBuild: string | null = null;
  private bindingHash: string | null = null;
  private planHash: string | null = null;
  private report: AlbumReport | null = null;
  private outputs: { file: AlbumMasterFile; stored: AlbumSpoolOutput }[] = [];
  constructor(album: Album, tracks: readonly Track[], private readonly reserve: AlbumMemoryFactory) {
    this.album = album; this.albumId = album.id;
    if (!tracks.length || tracks.length > 64) throw new Error("Choose between one and 64 available album tracks.");
    const target = Number(album.target.replace("−", "-").replace(/\s*LUFS\s*$/u, ""));
    if (!albumTargets.some((value) => value === target)) throw new Error("Choose a supported album target before rendering.");
    this.binding = new AlbumRecipeBinding(album, tracks, reserve);
    let receiptOwner: AlbumMemoryOwner | null = null;
    try {
      this.receiptMemory = receiptOwner = reserve(2 * 1024 * 1024); // Two bounded report graphs plus manifest/descriptors and publication metadata.
      admitReportMetadata(album, tracks);
      this.key = albumRecordKey(album, tracks); this.tracks = [...tracks];
    } catch (cause) { receiptOwner?.dispose(); this.binding.dispose(); throw cause; }
  }
  canResume() { return !this.disposed; }
  getFiles(): AlbumMasterFile[] { return this.outputs.map((entry) => ({ ...entry.file })); }
  getReport() { return this.report; }
  cancel() { this.active?.abort(); }
  /** UI authority vanishes now; lock/leases outlive every actual phase and storage/URL settlement. */
  dispose(discardStored = false): Promise<void> {
    this.disposed = true; this.discardStored ||= discardStored; this.cancel(); this.clearAuthority();
    if (this.closing) {
      if (discardStored && this.terminalStarted && this.spool) void this.spool.clear().catch(() => undefined);
      return this.closing;
    }
    markAlbumCleanup(this.albumId, this.cleanupCapability);
    const attempt = (async () => {
      await this.activeWork;
      const spool = this.spool; this.terminalStarted = true;
      let retiredFailure: Error | undefined;
      if (spool) {
        try { if (this.spoolBound && this.discardStored) await spool.clear(); else await spool.close(); }
        catch (cause) { if (!spool.isClosed()) throw cause; retiredFailure = cause instanceof Error ? cause : new Error("The previous album cleanup owner was retired.", { cause }); }
      }
      this.spool = null; this.binding.dispose(); this.receiptMemory.dispose(); this.tracks = [];
      this.album = { id: this.albumId, title: "", artist: "", target: "", trackIds: [], mastered: false };
      completeAlbumCleanup(this.albumId, this.cleanupCapability);
      if (retiredFailure !== undefined) throw retiredFailure;
    })();
    this.closing = attempt.catch((cause: unknown) => { this.closing = null; markAlbumCleanup(this.albumId, this.cleanupCapability, cause); throw cause; });
    return this.closing;
  }
  private clearAuthority() { this.outputs = []; this.report = null; }
  private check(signal: AbortSignal, isCurrent: () => boolean) {
    signal.throwIfAborted(); if (this.disposed || !isCurrent()) throw new AlbumCohortMismatchError();
  }
  private launch<T>(isCurrent: () => boolean, operation: (ctx: AlbumRenderContext) => Promise<T>): Promise<T> {
    if (this.disposed || this.active) return Promise.reject(new Error("This album owner is unavailable or another operation is still settling."));
    const controller = new AbortController(), signal = controller.signal;
    this.active = controller;
    const work = operation({ reserve: this.reserve, processingBuild: this.processingBuild ?? "", signal, check: () => { this.check(signal, isCurrent); } });
    const settled = work.then(() => undefined, () => undefined); this.activeWork = settled;
    return work.then(async (result) => {
      if (this.disposed) { await this.dispose(this.discardStored); signal.throwIfAborted(); }
      return result;
    }, async (cause: unknown) => {
      if (this.isFatal(cause, isCurrent)) {
        try { await this.dispose(true); }
        catch (cleanup) { throw new AggregateError([cause, cleanup], "The album changed and its owned stored output could not be removed. Retry cleanup before rendering again."); }
      } else if (this.disposed) await this.dispose(this.discardStored);
      throw cause;
    }).finally(() => { if (this.active === controller) this.active = null; if (this.activeWork === settled) this.activeWork = null; });
  }
  private isFatal(cause: unknown, isCurrent: () => boolean) {
    return cause instanceof AlbumRecipeMismatchError || cause instanceof AlbumSourceMismatchError || cause instanceof ProcessingBuildMismatchError || cause instanceof AlbumCohortMismatchError || cause instanceof AlbumStoredMismatchError || !isCurrent();
  }
  private async qualify(ctx: AlbumRenderContext): Promise<string> {
    ctx.check(); const current = await qualifyProcessingBuild(ctx.signal); ctx.check();
    if (this.processingBuild !== null && current !== this.processingBuild) throw new ProcessingBuildMismatchError();
    this.processingBuild = current; ctx.processingBuild = current; return current;
  }
  private async hashSmall(value: object, ctx: AlbumRenderContext): Promise<string> {
    const owner = this.reserve(1024 * 1024);
    let text: string | undefined, bytes: Uint8Array<ArrayBuffer> | undefined;
    try {
      boundedMetadata(value, 256 * 1024); text = JSON.stringify(value); bytes = new TextEncoder().encode(text);
      const digest = await crypto.subtle.digest("SHA-256", bytes); ctx.check();
      return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    } finally { text = undefined; bytes = undefined; owner.dispose(); }
  }
  private async withTrack<T>(index: number, ctx: AlbumRenderContext, consume: (recipe: AlbumTrackRecipe, digest: string) => Promise<T>): Promise<T> {
    return this.binding.withTrackRecipe(index, ctx.processingBuild, ctx.signal, () => { ctx.check(); return true; }, consume);
  }
  private progress(stage: string, ctx: AlbumRenderContext, onProgress: (value: AlbumProgress) => void) {
    ctx.check(); onProgress({ stage, completed: this.outputs.length, total: this.tracks.length, report: this.report });
  }
  run(isCurrent: () => boolean, onProgress: (value: AlbumProgress) => void): Promise<AlbumReport> {
    return this.launch(isCurrent, (ctx) => this.process(ctx, onProgress).then(async (report) => {
      await this.pauseStorage(); return report;
    }, async (cause: unknown) => {
      if (!this.isFatal(cause, isCurrent)) {
        try { await this.pauseStorage(); }
        catch (cleanup) { throw new AggregateError([cause, cleanup], "Album storage cleanup failed. Retry this unchanged album to finish cleanup before new work."); }
      }
      throw cause;
    }));
  }
  private async pauseStorage(): Promise<void> {
    if (this.spoolBound && this.spool && !this.disposed) {
      try { await this.spool.pause(); this.pauseFailed = false; }
      catch (cause) { this.pauseFailed = true; throw new Error("Album storage cleanup failed. Retry this unchanged album before new work.", { cause }); }
    }
  }
  private async process(ctx: AlbumRenderContext, onProgress: (value: AlbumProgress) => void): Promise<AlbumReport> {
        this.spool ??= await AlbumSpool.claim(this.albumId, this.cleanupCapability); ctx.check();
        if (this.pauseFailed) { await this.spool.pause(); this.pauseFailed = false; ctx.check(); }
        const processingBuild = await this.qualify(ctx), bindingHash = await this.binding.digest(processingBuild, ctx.signal, () => { ctx.check(); return true; }); ctx.check();
        if (this.bindingHash !== null && this.bindingHash !== bindingHash) throw new AlbumCohortMismatchError();
        this.bindingHash = bindingHash;
        const readings: AlbumReading[] = [];
        for (let index = 0; index < this.tracks.length; index++) {
          this.progress(`Measuring accepted chain ${String(index + 1)} of ${String(this.tracks.length)}`, ctx, onProgress);
          readings.push(await this.withTrack(index, ctx, async (recipe) => {
            const measured = await measureAlbumTrack(recipe, ctx); ctx.check();
            return { id: recipe.id, title: recipe.title, duration: recipe.duration, metrics: measured.afterMetrics, bands: [] };
          }));
        }
        const mode = this.album.gainMode ?? "relationships", target = albumTarget(this.album);
        const plan = planAlbumGain(readings, target, mode, this.tracks.map((track) => this.album.offsets?.[track.id] ?? 0));
        const planHash = await this.hashSmall({ version: 1, bindingHash, plan }, ctx); ctx.check();
        if (this.planHash !== null && this.planHash !== planHash) throw new AlbumCohortMismatchError();
        this.planHash = planHash;
        const expectedBytes = this.tracks.reduce((sum, track) => sum + 44 + (track.sourceIdentity?.frames ?? 0) * 6, 0);
        if (expectedBytes > maximumAlbumSpoolBytes) throw new Error("This album exceeds the encoded disk limit.");
        if (!this.spoolBound) {
          await this.spool.bind({ albumId: this.album.id, bindingHash, processingBuild, planHash, expectedBytes, totalTracks: this.tracks.length }); this.spoolBound = true; ctx.check();
        }
        await this.spool.resume(); ctx.check();
        const prefix = this.spool.prefix();
        if (JSON.stringify(prefix) !== JSON.stringify(this.outputs.map((entry) => entry.stored))) {
          // Persisted descriptors are cache only. Withhold every recovered row until ALL rerenders match.
          this.clearAuthority(); const recovered: AlbumOutputRow[] = [];
          for (const stored of prefix) {
            this.progress(`Verifying stored master ${String(stored.index + 1)} of ${String(prefix.length)}`, ctx, onProgress);
            recovered.push(await this.renderOne(stored.index, readings, plan, ctx, stored));
          }
          ctx.check(); this.report = this.newReport(bindingHash, plan, recovered);
          this.outputs = prefix.map((stored, index) => ({ stored, file: this.file(index, stored) }));
          this.progress("Stored prefix freshly rendered and verified.", ctx, onProgress);
        }
        this.report ??= this.newReport(bindingHash, plan, []);
        for (let index = this.outputs.length; index < this.tracks.length; index++) {
          this.progress(`Rendering and verifying ${String(index + 1)} of ${String(this.tracks.length)}`, ctx, onProgress);
          const row = await this.renderOne(index, readings, plan, ctx); ctx.check();
          const stored = this.spool.prefix().at(index); if (!stored) throw new AlbumStoredMismatchError();
          this.report = this.newReport(bindingHash, plan, [...this.report.tracks, row]);
          this.outputs.push({ stored, file: this.file(index, stored) });
          this.progress(this.report.complete ? "All measured masters are ready." : "Verified master stored on this device.", ctx, onProgress);
        }
        ctx.check(); return this.report;
  }
  private newReport(bindingHash: string, plan: AlbumGainPlan, tracks: AlbumOutputRow[]): AlbumReport {
    const report: AlbumReport = { version: 1, createdAt: this.report?.createdAt ?? new Date().toISOString(), albumId: this.album.id, title: this.album.title, artist: this.album.artist,
      bindingHash, target: albumTarget(this.album), mode: this.album.gainMode ?? "relationships", cohortIds: this.tracks.map((track) => track.id), medianTrackLufs: plan.medianTrackLufs,
      commonGainDb: plan.commonGainDb, complete: tracks.length === this.tracks.length, tracks };
    if (!readAlbumReport(report)) throw new Error("The measured album report exceeds its bounded metadata contract."); return report;
  }
  private file(index: number, stored: AlbumSpoolOutput): AlbumMasterFile {
    const track = this.tracks.at(index); if (!track) throw new AlbumStoredMismatchError();
    return { id: track.id, title: track.title, index, bytes: stored.bytes };
  }
  private async verifyStored(stored: AlbumSpoolOutput, expected: AlbumOutputRow, recipe: AlbumTrackRecipe, ctx: AlbumRenderContext): Promise<void> {
    if (stored.frames !== recipe.source.frames || stored.sampleRate !== recipe.source.sampleRate || stored.bytes !== expected.output.bytes || stored.sha256 !== expected.output.sha256 || !this.spool) throw new AlbumStoredMismatchError();
    const owner = this.reserve(stored.bytes * 3);
    try {
      await this.spool.withOutput(stored, ctx.signal, async (blob) => {
        const inspected = await inspectEncodedWAV(blob, 24, recipe.source, ctx.signal); ctx.check();
        if (inspected.sha256 !== expected.output.sha256 || JSON.stringify(inspected.encoding) !== JSON.stringify(expected.output.encoding)) throw new AlbumStoredMismatchError();
        owner.update(stored.bytes); await verifyAlbumTrackSource(recipe, ctx); ctx.check();
      });
    } finally { owner.dispose(); }
  }
  private async renderOne(index: number, readings: AlbumReading[], plan: AlbumGainPlan, ctx: AlbumRenderContext, recovered?: AlbumSpoolOutput): Promise<AlbumOutputRow> {
    const before = readings.at(index), gain = plan.tracks.at(index), spool = this.spool; if (!before || !gain || !spool) throw new Error("The complete album plan is unavailable.");
    return this.withTrack(index, ctx, async (recipe, recipeDigest) => {
      let rendered: Awaited<ReturnType<typeof renderAlbumTrack>> | null = null;
      try {
        rendered = await renderAlbumTrack(recipe, gain.gainDb, ctx); ctx.check();
        const processingHash = await this.hashSmall({ version: 1, recipeDigest, gainDb: gain.gainDb, processingBuild: ctx.processingBuild, encoding: recipe.encoding }, ctx); ctx.check();
        const row: AlbumOutputRow = { id: recipe.id, title: recipe.title, duration: recipe.duration, source: { ...recipe.source }, sourceRevision: recipe.sourceRevision, audioKey: recipe.audioKey,
          beforeMetrics: { ...before.metrics }, metrics: { ...rendered.metrics }, bands: rendered.bands.map((band) => ({ ...band })), processingHash, scriptRevision: recipe.script?.revision ?? null,
          gain: { ...gain }, output: { sha256: rendered.output.sha256, encoding: { ...rendered.output.encoding }, bytes: rendered.master.blob.size } };
        let stored = recovered;
        if (!stored) {
          rendered.master.owner.update(row.output.bytes * 2); // Immutable Blob and possible storage copy coexist through transaction settlement.
          stored = await spool.stage(rendered.master.blob, { index, sha256: row.output.sha256, frames: recipe.source.frames, sampleRate: recipe.source.sampleRate }, ctx.signal); ctx.check();
        }
        const owner = rendered.master.owner; rendered = null; owner.dispose();
        await this.verifyStored(stored, row, recipe, ctx); ctx.check();
        if (!recovered) { await spool.promote(stored.assetId, ctx.signal); ctx.check(); }
        return row;
      } finally { const owner = rendered?.master.owner; rendered = null; owner?.dispose(); }
    });
  }
  download(index: number, isCurrent: () => boolean): Promise<void> {
    if (this.pauseFailed) return Promise.reject(new Error("Retry album storage cleanup before downloading."));
    return this.launch(isCurrent, async (ctx) => {
      const selected = this.outputs.at(index), expected = this.report?.tracks.at(index), spool = this.spool;
      if (!selected || !expected || !spool || !this.spoolBound) throw new Error("Render and verify the current album before downloading its stored WAVs.");
      await this.qualify(ctx);
      for (let track = 0; track < this.tracks.length; track++) await this.withTrack(track, ctx, async (recipe) => { await verifyAlbumTrackSource(recipe, ctx); });
      const owner = this.reserve(selected.stored.bytes * 3);
      try {
        await spool.withOutput(selected.stored, ctx.signal, async (blob) => {
          const inspected = await inspectEncodedWAV(blob, 24, expected.source, ctx.signal); ctx.check();
          if (inspected.sha256 !== expected.output.sha256 || JSON.stringify(inspected.encoding) !== JSON.stringify(expected.output.encoding)) throw new AlbumStoredMismatchError();
          owner.update(selected.stored.bytes);
          await this.withTrack(index, ctx, async (recipe) => { await verifyAlbumTrackSource(recipe, ctx); });
          await this.qualify(ctx); ctx.check();
          await downloadLocalBlobAndWait(blob, `${selected.file.title.replace(/[^a-zA-Z0-9_-]/gu, "-") || "aurialis"}-album-master.wav`); ctx.check();
        });
      } finally { owner.dispose(); }
    });
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
  try { boundedMetadata(report, 262_144); } catch { return undefined; }
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

/** Metadata export reserves before validation copies, serialization and Blob creation. */
export async function downloadAlbumReport(report: AlbumReport, reserve: AlbumMemoryFactory): Promise<void> {
  const owner = reserve(2 * 1024 * 1024);
  let validated: AlbumReport | undefined, text: string | undefined, blob: Blob | null = null;
  try {
    if (boundedMetadata(report, 256 * 1024) + 4 * 256 * 1024 > 2 * 1024 * 1024) throw new Error("This saved report exceeds the metadata download memory bound.");
    validated = readAlbumReport(report); if (!validated) throw new Error("The album report metadata is invalid.");
    text = JSON.stringify(validated); blob = new Blob([text], { type: "application/json" }); validated = undefined; text = undefined;
    await downloadLocalBlobAndWait(blob, "aurialis-album-report.json");
  } finally { validated = undefined; text = undefined; blob = null; owner.dispose(); }
}
