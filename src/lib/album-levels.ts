import { appliedRevisionKey, type ScriptV2 } from "./deep-mastering";
import { engineParams, exportParams, exportScript } from "./engine-params";
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
  | { trackId: string; mode: "keep"; gainDb: 0 }
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
  if (level.mode === "keep") return { ok: true, tracks: tracks.map((track) => ({ trackId: track.id, mode: "keep", gainDb: 0 })) };
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

/** Identifies rendered masters: the sequence, each project's settings and the used level.
 * A normalize choice always names its target and offsets, blocked or not, so it can
 * never match masters kept at each level. */
export function albumMastersKey(tracks: readonly Track[], level: AlbumLevel): string {
  const plan = planAlbumLevels(level, tracks);
  const sequence = tracks.map((track, index) => {
    const step = plan.ok ? plan.tracks.at(index) : undefined;
    return [track.id, track.sourceRevision, appliedRevisionKey(track) ?? engineParams(track.advanced), step?.mode === "normalize" ? step.requestedLufs : "keep"];
  });
  if (level.mode === "keep") return JSON.stringify(sequence);
  const offsets = tracks.map((track) => albumOffset(level, track.id));
  return JSON.stringify({ mode: "normalize", targetLufs: level.targetLufs, offsets, blocked: !plan.ok, sequence });
}

export type AlbumRenderEngine = {
  normalize: (file: Blob, settings: AdvancedParams, targetLufs: number, signal?: AbortSignal) => Promise<{ advanced: AdvancedParams }>;
  render: (file: Blob, params: object, bitDepth: 24, signal?: AbortSignal) => Promise<Blob>;
  renderScript: (file: Blob, script: ScriptV2, bitDepth: 24, signal?: AbortSignal) => Promise<Blob>;
  measure: (file: Blob, params: object, signal?: AbortSignal) => Promise<{ beforeMetrics: MeasuredAudioMetrics }>;
};

/** Render one 24-bit album master from a read-only project, then measure the rendered file. */
export async function renderAlbumTrack(track: Pick<Track, "advanced" | "deepMastering">, file: Blob, plan: AlbumTrackPlan, engine: AlbumRenderEngine, signal?: AbortSignal): Promise<{ blob: Blob; measured: AlbumMasterLevel }> {
  let blob: Blob;
  if (plan.mode === "keep") {
    const script = track.deepMastering?.applied;
    blob = script ? await engine.renderScript(file, exportScript(script), 24, signal) : await engine.render(file, exportParams(track.advanced), 24, signal);
  } else {
    const { advanced } = await engine.normalize(file, track.advanced, plan.requestedLufs, signal);
    blob = await engine.render(file, exportParams(advanced), 24, signal);
  }
  const { beforeMetrics } = await engine.measure(blob, { bypass: true }, signal);
  return { blob, measured: { integratedLufs: beforeMetrics.integratedLufs, truePeakDbtp: beforeMetrics.truePeakDbtp } };
}
