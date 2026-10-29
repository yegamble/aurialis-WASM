import { appliedRevisionKey, type ScriptV2 } from "./deep-mastering";
import { deliveryRequest, type DeliveryFormat } from "./delivery-format";
import { engineParams, exportParams, exportRender } from "./engine-params";
import type { AdvancedParams, MeasuredAudioMetrics, Track } from "./types";

/** Selectable album loudness targets, in LUFS. */
export const ALBUM_TARGETS = [-23, -18, -16, -14, -12, -9] as const;
export type AlbumTarget = (typeof ALBUM_TARGETS)[number];
/** A per-track album offset moves one song relative to the target, never beyond six dB. */
export const ALBUM_OFFSET_LIMIT_DB = 6;
// The export-parameter loudness search accepts this range.
const QUIETEST_LUFS = -36, LOUDEST_LUFS = -5;

export type AlbumLevelMode = "keep" | "normalize";
export type AlbumOffset = { trackId: string; offsetDb: number };
/** The album's own level choice. It never lives on, or changes, a project. */
export type AlbumLevel = { mode: AlbumLevelMode; targetLufs: AlbumTarget; offsets: AlbumOffset[] };
export const DEFAULT_ALBUM_LEVEL: AlbumLevel = { mode: "keep", targetLufs: -14, offsets: [] };

type AlbumTrackPlan =
  | { trackId: string; mode: "keep" }
  | { trackId: string; mode: "normalize"; targetLufs: AlbumTarget; offsetDb: number; requestedLufs: number };
type AlbumPlan = { ok: true; tracks: AlbumTrackPlan[] } | { ok: false; error: string };
/** Integrated loudness and true peak measured from one rendered album master. */
export type AlbumMasterLevel = { integratedLufs: number; truePeakDbtp: number };

const clampOffset = (value: number) => Math.max(-ALBUM_OFFSET_LIMIT_DB, Math.min(ALBUM_OFFSET_LIMIT_DB, value));
const isTarget = (value: unknown): value is AlbumTarget => ALBUM_TARGETS.some((target) => target === value);
const lufs = (value: number) => `${value < 0 ? "−" : ""}${String(Math.abs(value))} LUFS`;

/** Restore a saved level. Legacy or corrupt albums keep each master's level. */
export function readAlbumLevel(value: unknown): AlbumLevel {
  if (typeof value !== "object" || value === null) return { ...DEFAULT_ALBUM_LEVEL, offsets: [] };
  const record = value as Partial<Record<keyof AlbumLevel, unknown>>;
  const offsets = Array.isArray(record.offsets) ? (record.offsets as unknown[]).flatMap((item): AlbumOffset[] => {
    if (typeof item !== "object" || item === null || !("trackId" in item) || !("offsetDb" in item)) return [];
    const { trackId, offsetDb } = item;
    return typeof trackId === "string" && trackId && typeof offsetDb === "number" && Number.isFinite(offsetDb) && offsetDb !== 0
      ? [{ trackId, offsetDb: clampOffset(offsetDb) }] : [];
  }).slice(0, 512) : [];
  return { mode: record.mode === "normalize" ? "normalize" : "keep", targetLufs: isTarget(record.targetLufs) ? record.targetLufs : -14, offsets };
}

export function albumOffset(level: AlbumLevel, trackId: string): number {
  return level.offsets.find((item) => item.trackId === trackId)?.offsetDb ?? 0;
}

/** Set one track's offset on the album, bounded; a zero offset is not stored. */
export function withAlbumOffset(level: AlbumLevel, trackId: string, offsetDb: number): AlbumLevel {
  const bounded = Number.isFinite(offsetDb) ? clampOffset(offsetDb) : 0;
  const index = level.offsets.findIndex((item) => item.trackId === trackId);
  const offsets = level.offsets.filter((item) => item.trackId !== trackId);
  if (bounded !== 0) offsets.splice(index < 0 ? offsets.length : index, 0, { trackId, offsetDb: bounded });
  return { ...level, offsets };
}

/** Keep only offsets for tracks still on the album. */
export function pruneAlbumOffsets(level: AlbumLevel, trackIds: readonly string[]): AlbumLevel {
  const offsets = level.offsets.filter((item) => trackIds.includes(item.trackId));
  return offsets.length === level.offsets.length ? level : { ...level, offsets };
}

export function albumLevelSummary(level: AlbumLevel): string {
  return level.mode === "keep" ? "Keeps each master’s level" : `Normalizes to ${lufs(level.targetLufs)}`;
}

/** What each album master renders. Keep: the single export, unchanged.
 * Normalize: the target plus that track's album offset, or a reason it cannot. */
export function planAlbumLevels(level: AlbumLevel, tracks: readonly Pick<Track, "id" | "title" | "deepMastering">[]): AlbumPlan {
  if (level.mode === "keep") return { ok: true, tracks: tracks.map((track) => ({ trackId: track.id, mode: "keep" })) };
  const plans: AlbumTrackPlan[] = [];
  for (const track of tracks) {
    if (track.deepMastering?.applied)
      return { ok: false, error: `“${track.title}” plays an applied Deep script, which album normalization cannot adjust. Keep each master’s level, or detach Deep automation in that master.` };
    const offsetDb = albumOffset(level, track.id), requestedLufs = level.targetLufs + offsetDb;
    if (requestedLufs < QUIETEST_LUFS || requestedLufs > LOUDEST_LUFS)
      return { ok: false, error: `“${track.title}” would need ${lufs(requestedLufs)}. Keep each normalized level between −36 and −5 LUFS.` };
    plans.push({ trackId: track.id, mode: "normalize", targetLufs: level.targetLufs, offsetDb, requestedLufs });
  }
  return { ok: true, tracks: plans };
}

/** Identifies rendered masters: the sequence, each project's settings, the used level
 * and the delivery format (bit depth plus the rate and dither sent with the render;
 * the default format keeps the key masters had before the format was selectable).
 * A normalize choice always names its target and offsets, blocked or not, so it can
 * never match masters kept at each level. */
export function albumMastersKey(tracks: readonly Track[], level: AlbumLevel, format: DeliveryFormat): string {
  const plan = planAlbumLevels(level, tracks);
  const sequence = tracks.map((track, index) => {
    const step = plan.ok ? plan.tracks.at(index) : undefined;
    const baseline = appliedRevisionKey(track) ?? engineParams(track.advanced);
    const render = exportRender(track);
    const algorithm = "script" in render ? render.script.chainParams.algorithmVersion : render.params.algorithmVersion;
    // Keep old Classic keys byte-for-byte, while selected Oversampled masters
    // cannot be confused with a saved render of the same settings in Classic.
    const processing = algorithm === 3 ? { algorithmVersion: 3, baseline } : baseline;
    return [track.id, track.sourceRevision, processing, step?.mode === "normalize" ? step.requestedLufs : "keep"];
  });
  const request = deliveryRequest(format);
  // The default format (each source rate, 24-bit, TPDF) is what every earlier master
  // rendered, so it keeps the earlier key and those saved masters stay current.
  const delivery = format.bitDepth === 24 && Object.keys(request).length === 0 ? {} : { delivery: { bitDepth: format.bitDepth, ...request } };
  if (level.mode === "keep") return "delivery" in delivery ? JSON.stringify({ ...delivery, sequence }) : JSON.stringify(sequence);
  const offsets = tracks.map((track) => albumOffset(level, track.id));
  return JSON.stringify({ mode: "normalize", targetLufs: level.targetLufs, offsets, blocked: !plan.ok, ...delivery, sequence });
}

export type AlbumRenderEngine = {
  normalize: (file: Blob, settings: AdvancedParams, targetLufs: number, signal?: AbortSignal) => Promise<{ advanced: AdvancedParams }>;
  /** Renders exactly what Export delivers for this request and format. */
  render: (file: Blob, render: { params: object } | { script: ScriptV2 }, format: DeliveryFormat, signal?: AbortSignal) => Promise<Blob>;
  measure: (file: Blob, params: object, signal?: AbortSignal) => Promise<{ beforeMetrics: MeasuredAudioMetrics }>;
};

/** Render one album master at the album's delivery format from a read-only project,
 * then measure the rendered file. Keep renders exactly the single export at that format. */
export async function renderAlbumTrack(track: Pick<Track, "advanced" | "deepMastering">, file: Blob, plan: AlbumTrackPlan, format: DeliveryFormat, engine: AlbumRenderEngine, signal?: AbortSignal): Promise<{ blob: Blob; measured: AlbumMasterLevel }> {
  let blob: Blob;
  if (plan.mode === "keep") {
    blob = await engine.render(file, exportRender(track), format, signal);
  } else {
    const { advanced } = await engine.normalize(file, track.advanced, plan.requestedLufs, signal);
    blob = await engine.render(file, { params: exportParams(advanced) }, format, signal);
  }
  const { beforeMetrics } = await engine.measure(blob, { bypass: true }, signal);
  return { blob, measured: { integratedLufs: beforeMetrics.integratedLufs, truePeakDbtp: beforeMetrics.truePeakDbtp } };
}
