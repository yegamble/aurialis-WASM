import { engineParams } from "./engine-params";
import { readScriptParams, readScriptV2, type ScriptParams, type ScriptV2 } from "./deep-mastering";
import { audioKey } from "./library";
import { boundedMetadata, scriptMetadataBytes } from "./script-metadata";
import type { AlbumMemoryFactory } from "./album-batch";
import type { Album, SourceIdentity, Track } from "./types";

const temporaryBytes = 32 * 1024 * 1024, aggregateMetadataBytes = 64 * 1024 * 1024;
const references = new WeakMap<Track, number>();
let nextReference = 0;
function reference(track: Track) {
  let key = references.get(track);
  if (key === undefined) { key = ++nextReference; references.set(track, key); }
  return key;
}
function boundedKeys(value: object, maximum: number) {
  let count = 0;
  for (const key in value) if (Object.hasOwn(value, key) && ++count > maximum) throw new Error("The retained record metadata exceeds its field limit.");
}
function metadataRecord(value: unknown) { return typeof value === "object" && value !== null && !Array.isArray(value); }
function albumRecipe(album: Album) {
  const allowed = ["id", "title", "artist", "target", "trackIds", "mastered", "gainMode", "offsets", "updatedAt", "report"];
  let keys = 0;
  for (const key in album) if (Object.hasOwn(album, key) && (++keys > allowed.length || !allowed.includes(key))) throw new Error("The album metadata is invalid.");
  if (!Array.isArray(album.trackIds) || album.trackIds.length > 64 || !album.trackIds.every((id) => typeof id === "string" && id.length > 0 && id.length <= 1024)
    || typeof album.id !== "string" || !album.id || album.id.length > 1024 || typeof album.title !== "string" || !album.title.trim() || album.title.length > 1024
    || typeof album.artist !== "string" || album.artist.length > 1024 || typeof album.target !== "string" || album.target.length > 32 || typeof album.mastered !== "boolean"
    || album.gainMode !== undefined && !["relationships", "normalize", "manual"].includes(album.gainMode)
    || album.updatedAt !== undefined && (typeof album.updatedAt !== "string" || album.updatedAt.length > 64)) throw new Error("The album metadata is invalid.");
  if (album.offsets !== undefined) {
    if (!metadataRecord(album.offsets)) throw new Error("The album offsets are invalid.");
    let count = 0;
    for (const id in album.offsets) if (Object.hasOwn(album.offsets, id)) {
      // Bounded own track identifiers are data keys, never evaluated target paths.
      // eslint-disable-next-line security/detect-object-injection
      const gain = album.offsets[id];
      if (++count > 64 || id.length > 1024 || typeof gain !== "number" || !Number.isFinite(gain) || Math.abs(gain) > 6) throw new Error("The album offsets are invalid.");
    }
  }
  const record = { id: album.id, title: album.title, artist: album.artist, target: album.target, trackIds: album.trackIds,
    mastered: album.mastered, gainMode: album.gainMode, offsets: album.offsets, updatedAt: album.updatedAt };
  boundedMetadata(record, 256 * 1024); return record;
}
/** Small process-local invalidation token. Only deterministic digest() binds persisted recipes. */
export function albumRecordKey(album: Album, tracks: readonly Track[]): string {
  if (tracks.length > 64) throw new Error("Choose at most 64 album tracks.");
  return JSON.stringify({ album: albumRecipe(album), records: tracks.map(reference) });
}
function fixedLength(value: unknown, length: number) { return Array.isArray(value) && value.length === length; }
function metadataBytes(track: Track) {
  const source = track.sourceIdentity, key = audioKey(track);
  if (typeof track.title !== "string" || !track.title.trim() || track.title.length > 1024 || typeof track.id !== "string" || !track.id || track.id.length > 1024
    || typeof key !== "string" || !key || key.length > 1024 || !fixedLength(track.advanced.eqBands, 5) || !fixedLength(track.advanced.multiband.bands, 3)
    || !source || typeof source.pcmHash !== "string" || !/^[a-f0-9]{64}$/u.test(source.pcmHash) || !Number.isSafeInteger(source.frames) || source.frames < 1 || source.frames > 16_777_216
    || !Number.isSafeInteger(source.sampleRate) || source.sampleRate !== track.sampleRate || source.sampleRate < 8000 || source.sampleRate > 192000
    || !Number.isFinite(track.duration) || Math.abs(source.frames / source.sampleRate - track.duration) > 0.001
    || !Number.isSafeInteger(track.sourceRevision ?? 0) || (track.sourceRevision ?? 0) < 0) throw new Error("The track metadata is invalid.");
  boundedKeys(source, 3); boundedKeys(track, 64);
  const { deepMastering, ...rest } = track;
  let bytes = boundedMetadata(rest, 1024 * 1024);
  if (deepMastering) {
    boundedKeys(deepMastering, 16);
    const { proposal, applied, ...other } = deepMastering;
    bytes += boundedMetadata(other, 1024 * 1024) + scriptMetadataBytes(proposal);
    if (applied && applied !== proposal) bytes += scriptMetadataBytes(applied);
  }
  return bytes;
}
export type AlbumTrackRecipe = Readonly<{
  version: 1; id: string; title: string; audioKey: string; source: SourceIdentity; sourceRevision: number;
  sampleRate: number; duration: number; params: ScriptParams; script: ScriptV2 | null;
  encoding: { version: 1; bits: 24; channels: 2; sampleRate: number; frames: number };
}>;
function freezeRecipe(value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  for (const item of Object.values(value)) freezeRecipe(item);
  Object.freeze(value);
}
export class AlbumRecipeMismatchError extends Error {
  constructor() { super("The full track recipe changed. Plan the complete album again."); this.name = "AlbumRecipeMismatchError"; }
}
/** Store references supply CAS; each hashed render packet is separately detached under a lease. */
export class AlbumRecipeBinding {
  private albumRecord: Album | null;
  private records: readonly Track[] | null;
  private readonly resident: ReturnType<AlbumMemoryFactory>;
  private active = false;
  private disposed = false;
  private processingBuild: string | null = null;
  private digests: readonly string[] | null = null;
  constructor(album: Album, tracks: readonly Track[], private readonly reserve: AlbumMemoryFactory) {
    if (!tracks.length || tracks.length > 64 || tracks.length !== album.trackIds.length || new Set(tracks.map((track) => track.id)).size !== tracks.length || tracks.some((track, index) => track.id !== album.trackIds.at(index))) throw new Error("The album cohort metadata is invalid.");
    let bytes = boundedMetadata(albumRecipe(album), 256 * 1024) + (album.report ? boundedMetadata(album.report, 256 * 1024) : 0);
    for (const track of tracks) { bytes += metadataBytes(track); if (bytes > aggregateMetadataBytes) throw new Error("The aggregate album recipe metadata exceeds 64 MiB. Use a smaller sequence."); }
    this.resident = reserve(bytes);
    try { this.albumRecord = album; this.records = [...tracks]; } catch (cause) { this.resident.dispose(); throw cause; }
  }
  get album() { if (!this.albumRecord) throw new Error("The album binding was disposed."); return this.albumRecord; }
  get tracks() { if (!this.records) throw new Error("The album binding was disposed."); return this.records; }
  dispose() { this.disposed = true; if (!this.active) this.release(); }
  private release() { this.albumRecord = null; this.records = null; this.digests = null; this.processingBuild = null; this.resident.dispose(); }
  private finish() { this.active = false; if (this.disposed) this.release(); }
  private check(signal: AbortSignal, isCurrent: () => boolean) {
    signal.throwIfAborted();
    if (this.disposed || !isCurrent()) { this.dispose(); throw new Error("The album records changed or their binding was disposed."); }
  }
  private trackRecipe(track: Track): AlbumTrackRecipe {
    metadataBytes(track);
    const source = track.sourceIdentity;
    if (!source) throw new Error("Restore the matching album source before rendering.");
    return { version: 1, id: track.id, title: track.title, audioKey: audioKey(track), source, sourceRevision: track.sourceRevision ?? 0,
      sampleRate: track.sampleRate, duration: track.duration, params: readScriptParams(engineParams(track.advanced)),
      script: track.deepMastering?.applied ? readScriptV2(track.deepMastering.applied, source) : null,
      encoding: { version: 1, bits: 24, channels: 2, sampleRate: source.sampleRate, frames: source.frames } };
  }
  private async withRecipe<T, R>(recipe: () => R, signal: AbortSignal, isCurrent: () => boolean, consume: (value: R, recipeDigest: string) => T | Promise<T>): Promise<T> {
    this.check(signal, isCurrent); const owner = this.reserve(temporaryBytes);
    let candidate: R | undefined, value: R | undefined, text: string | undefined, bytes: Uint8Array<ArrayBuffer> | undefined;
    try {
      candidate = recipe(); value = structuredClone(candidate); candidate = undefined;
      freezeRecipe(value); text = JSON.stringify(value); bytes = new TextEncoder().encode(text);
      const digest = await crypto.subtle.digest("SHA-256", bytes); this.check(signal, isCurrent);
      text = undefined; bytes = undefined;
      const recipeDigest = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
      const result = await consume(value, recipeDigest); this.check(signal, isCurrent); return result;
    } finally { candidate = undefined; value = undefined; text = undefined; bytes = undefined; owner.dispose(); }
  }
  async digest(processingBuild: string, signal: AbortSignal, isCurrent: () => boolean): Promise<string> {
    if (this.disposed || this.active || !/^[a-f0-9]{64}$/u.test(processingBuild) || this.processingBuild !== null && this.processingBuild !== processingBuild) throw new Error("The album binding needs an available matching qualified processing build.");
    this.active = true;
    try {
      const hashes: string[] = [];
      for (const track of this.tracks) hashes.push(await this.withRecipe(() => this.trackRecipe(track), signal, isCurrent, (_value, recipeDigest) => recipeDigest));
      const binding = await this.withRecipe(() => ({ version: 1, processingBuild, album: albumRecipe(this.album), tracks: hashes }), signal, isCurrent, (_value, recipeDigest) => recipeDigest);
      this.digests = hashes; this.processingBuild = processingBuild; return binding;
    } finally { this.finish(); }
  }
  /** Recapture, hash and compare one detached packet; consumers must render this same packet. */
  async withTrackRecipe<T>(index: number, processingBuild: string, signal: AbortSignal, isCurrent: () => boolean, consume: (recipe: AlbumTrackRecipe, digest: string) => Promise<T>): Promise<T> {
    const track = this.tracks.at(index), expected = this.digests?.at(index);
    if (this.disposed || this.active || !Number.isSafeInteger(index) || index < 0 || !track || !expected || this.processingBuild !== processingBuild) throw new Error("The album track needs its current whole-cohort binding before rendering.");
    this.active = true;
    try {
      return await this.withRecipe(() => this.trackRecipe(track), signal, isCurrent, (recipe, recipeDigest) => {
        if (recipeDigest !== expected) { this.dispose(); throw new AlbumRecipeMismatchError(); }
        return consume(recipe, recipeDigest);
      });
    } finally { this.finish(); }
  }
}
