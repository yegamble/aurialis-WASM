import { clampAdvancedToSampleRate } from "./audio-dsp";
import { getAudio, saveAudio, discardStagedAudio, newAudioAssetId } from "./db";
import { importedTrack, type prepareProjectFile } from "./project-import";
import type { SourceIdentity, Track } from "./types";

export type LibrarySort = "recent" | "name" | "duration";
export function sortedTracks(tracks: readonly Track[], sort: LibrarySort): Track[] {
  return [...tracks].sort((a, b) => {
    const difference = sort === "name" ? a.title.localeCompare(b.title) : sort === "duration" ? a.duration - b.duration : (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0);
    return difference || a.id.localeCompare(b.id);
  });
}
export const audioKey = (track: Track): string => track.sourceAudioId ?? track.id;
export function sameSource(left: SourceIdentity | undefined, right: SourceIdentity | undefined): boolean {
  return !!left && !!right && left.pcmHash === right.pcmHash && left.sampleRate === right.sampleRate && left.frames === right.frames;
}
export async function duplicateProject(track: Track, signal: AbortSignal): Promise<Track> {
  const blob = await getAudio(audioKey(track));
  signal.throwIfAborted();
  if (!blob) throw new Error("The source is missing. Restore it before duplicating this project.");
  const copy = structuredClone(track);
  copy.id = newAudioAssetId("track");
  copy.title = `${track.title} copy`;
  copy.createdAt = copy.updatedAt = new Date().toISOString();
  copy.status = "ready";
  delete copy.sourceAudioId;
  delete copy.retiredSourceAudioIds;
  delete copy.releaseScore;
  delete copy.importNotice;
  const saved = await saveAudio(copy.id, blob);
  if (signal.aborted) { await discardStagedAudio(copy.id, saved.durable); signal.throwIfAborted(); }
  copy.persistenceWarning = saved.durable ? "" : saved.warning;
  return copy;
}
export function replacementProject(track: Track, file: File, imported: Awaited<ReturnType<typeof prepareProjectFile>>): Track {
  const source = importedTrack(file, imported, track.id);
  const next: Track & { script?: unknown; masteringScript?: unknown; analysisRevision?: unknown } = {
    ...track, filename: source.filename, size: source.size, duration: source.duration, format: source.format, sampleRate: source.sampleRate,
    advanced: clampAdvancedToSampleRate(track.advanced, source.sampleRate), metrics: source.metrics, measurements: imported.measurement.afterMetrics,
    measurementKind: "source", status: "ready", simpleCustom: true, shortcutUndo: {},
  };
  delete next.sourceIdentity;
  if (source.sourceIdentity) next.sourceIdentity = source.sourceIdentity;
  delete next.script; delete next.masteringScript; delete next.analysisRevision; delete next.releaseScore;
  return next;
}
