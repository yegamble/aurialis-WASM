import { engineParams, measureAudio, serverRender, serverRenderScript } from "./browser-engine";
import { inspectEncodedWAV } from "./encoded-inspection";
import { verifyCanonicalSource } from "./project-import";
import { releaseProfiles, type EncodedInspection, type OutputBits, type ReleasePlatform } from "./release-policy";
import type { MeasuredAudioMetrics, SourceIdentity, Track } from "./types";

export type ReleaseReport = {
  version: 1; createdAt: string; title: string; platform: ReleasePlatform;
  bindingHash: string; processingHash: string; scriptRevision: number | null;
  source: SourceIdentity; sourceRevision: number;
  output: EncodedInspection & { sha256: string; bytes: number };
  metrics: MeasuredAudioMetrics;
};

async function textHash(value: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  signal.throwIfAborted();
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Hash the entire accepted script, including points, rather than only its revision. */
export async function releaseBindingHash(track: Track, bits: OutputBits, signal: AbortSignal): Promise<string> {
  return textHash(JSON.stringify({ id: track.id, title: track.title, audio: track.sourceAudioId ?? track.id,
    sourceRevision: track.sourceRevision ?? 0, source: track.sourceIdentity, bits,
    params: engineParams(track.advanced), script: track.deepMastering?.applied ?? null }), signal);
}

/** Retain the measured file itself; a later download must not silently render new bytes. */
export async function collectReleaseReview(source: Blob, track: Track, bits: OutputBits, platform: ReleasePlatform, signal: AbortSignal): Promise<{ report: ReleaseReport; wav: Blob }> {
  const identity = track.sourceIdentity ? { ...track.sourceIdentity } : undefined;
  const params = engineParams(track.advanced);
  const script = track.deepMastering?.applied ? structuredClone(track.deepMastering.applied) : undefined;
  const title = track.title, sourceRevision = track.sourceRevision ?? 0;
  if (!identity || identity.sampleRate !== track.sampleRate || Math.abs(identity.frames / identity.sampleRate - track.duration) > 0.001)
    throw new Error("Restore the matching source in Library before reviewing a release.");
  const bindingHash = await releaseBindingHash(track, bits, signal);
  await verifyCanonicalSource(source, identity, signal);
  const processingHash = await textHash(JSON.stringify(script ? { script } : { params }), signal);
  const wav = script ? await serverRenderScript(source, script, bits, signal) : await serverRender(source, params, bits, signal);
  const inspected = await inspectEncodedWAV(wav, bits, identity, signal);
  // Bypass measurement decodes the FINAL encoded PCM, including quantization.
  const measured = await measureAudio(wav, { bypass: true }, signal);
  if (measured.sampleRate !== identity.sampleRate || measured.frames !== identity.frames
    || Math.abs(measured.duration - identity.frames / identity.sampleRate) > 0.001)
    throw new Error("The measured output layout changed. Run the release check again.");
  await verifyCanonicalSource(source, identity, signal);
  signal.throwIfAborted();
  return { wav, report: { version: 1, createdAt: new Date().toISOString(), title, platform,
    bindingHash, processingHash, scriptRevision: script?.revision ?? null, source: identity, sourceRevision,
    output: { ...inspected.encoding, sha256: inspected.sha256, bytes: wav.size }, metrics: measured.afterMetrics } };
}

/** A saved report is data, never an authority to process or download audio. */
export function readReleaseReport(value: unknown): ReleaseReport | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  try { if (JSON.stringify(value).length > 16_384) return undefined; } catch { return undefined; }
  const item = value as Partial<ReleaseReport>;
  const hash = (candidate: unknown) => typeof candidate === "string" && /^[a-f0-9]{64}$/u.test(candidate);
  if (item.version !== 1 || typeof item.createdAt !== "string" || !Number.isFinite(Date.parse(item.createdAt))
    || typeof item.title !== "string" || item.title.length > 1024 || !releaseProfiles.some((profile) => profile.name === item.platform)
    || !hash(item.bindingHash) || !hash(item.processingHash) || !item.source || !hash(item.source.pcmHash)
    || !Number.isSafeInteger(item.sourceRevision) || (item.sourceRevision ?? -1) < 0
    || !(item.scriptRevision === null || Number.isSafeInteger(item.scriptRevision) && (item.scriptRevision ?? 0) > 0)
    || !item.output || !hash(item.output.sha256) || !item.metrics) return undefined;
  const output = item.output, source = item.source;
  const channels = (output as { channels: unknown }).channels;
  const silenceThreshold = (output as { silenceThresholdDbfs: unknown }).silenceThresholdDbfs;
  if (!Number.isSafeInteger(source.frames) || source.frames < 1 || source.frames > 16_777_216
    || !Number.isSafeInteger(source.sampleRate) || source.sampleRate < 8000 || source.sampleRate > 192000
    || output.frames !== source.frames || output.sampleRate !== source.sampleRate || channels !== 2
    || ![16, 24, 32].includes(output.bitDepth) || silenceThreshold !== -60
    || output.bytes !== 44 + source.frames * 2 * output.bitDepth / 8
    || ![output.fullScaleFrames, output.leadingSilenceFrames, output.trailingSilenceFrames].every((count) => Number.isSafeInteger(count) && count >= 0 && count <= source.frames)
    || Object.keys(item.metrics).length !== 11 || !Object.values(item.metrics).every((number) => typeof number === "number" && Number.isFinite(number))) return undefined;
  const metrics = item.metrics;
  if (![metrics.integratedLufs, metrics.shortTermLufs, metrics.truePeakDbtp, metrics.samplePeakDbfs, metrics.dynamicRangeDb, metrics.correlation,
    metrics.lowBassCorrelation, metrics.dcLeftDbfs, metrics.dcRightDbfs, metrics.clippingSamples, metrics.gainReductionDb].every(Number.isFinite)) return undefined;
  return { version: 1, createdAt: item.createdAt, title: item.title, platform: item.platform as ReleasePlatform,
    bindingHash: item.bindingHash as string, processingHash: item.processingHash as string, scriptRevision: item.scriptRevision as number | null,
    source: { ...source }, sourceRevision: item.sourceRevision as number, output: { ...output }, metrics: { ...metrics } };
}
