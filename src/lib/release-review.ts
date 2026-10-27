import { MAX_SOURCE_FRAMES } from "./audio-limits";
import { measureAudio, renderDelivery } from "./browser-engine";
import { reserveBrowserAudioMemory } from "./browser-jobs";
import { deliveredFrames, deliveredRate, deliveryRequest, type DeliveryFormat } from "./delivery-format";
import { engineParams, exportRender } from "./engine-params";
import { inspectEncodedWAV } from "./encoded-inspection";
import { convertedFrames } from "./export-rates";
import { verifyCanonicalSource } from "./project-import";
import { releaseProfiles, type EncodedInspection, type OutputBits, type ReleasePlatform } from "./release-policy";
import { EXPORT_SAMPLE_RATES, type MeasuredAudioMetrics, type SourceIdentity, type Track } from "./types";

export type ReleaseReport = {
  version: 1; createdAt: string; title: string; platform: ReleasePlatform;
  bindingHash: string; processingHash: string; scriptRevision: number | null;
  source: SourceIdentity; sourceRevision: number;
  /** The measured delivered file, at the delivery rate and bit depth. */
  output: EncodedInspection & { sha256: string; bytes: number };
  /** Dither the delivered file carries; 32-bit float carries none. */
  dither: ReleaseDither;
  metrics: MeasuredAudioMetrics;
};
type ReleaseDither = "tpdf" | "none";
const releaseDither = (format: DeliveryFormat): ReleaseDither => format.bitDepth !== 32 && format.dither ? "tpdf" : "none";

async function textHash(value: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  signal.throwIfAborted();
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Hash the entire accepted script, including points, rather than only its revision.
 * A converted rate or disabled dither is appended, so a source-rate dithered check
 * keeps the binding it had before the delivery format was selectable. */
export async function releaseBindingHash(track: Track, format: DeliveryFormat, signal: AbortSignal): Promise<string> {
  return textHash(JSON.stringify({ id: track.id, title: track.title, audio: track.sourceAudioId ?? track.id,
    sourceRevision: track.sourceRevision ?? 0, source: track.sourceIdentity, bits: format.bitDepth,
    params: engineParams(track.advanced), script: track.deepMastering?.applied ?? null, ...deliveryRequest(format) }), signal);
}

type ReviewMemory = ReturnType<typeof reserveBrowserAudioMemory>;
export type ReleaseArtifact = { report: ReleaseReport; wav: Blob; dispose: () => void };

function reviewIdentity(track: Track, bits: OutputBits): SourceIdentity {
  const identity = track.sourceIdentity;
  if (!identity || !/^[a-f0-9]{64}$/u.test(identity.pcmHash)
    || !Number.isSafeInteger(identity.frames) || identity.frames < 1 || identity.frames > MAX_SOURCE_FRAMES
    || !Number.isSafeInteger(identity.sampleRate) || identity.sampleRate < 8000 || identity.sampleRate > 192000
    || identity.sampleRate !== track.sampleRate || !Number.isFinite(track.duration)
    || Math.abs(identity.frames / identity.sampleRate - track.duration) > 0.001)
    throw new Error("Restore the matching source in Library before reviewing a release.");
  if (![16, 24, 32].includes(bits)) throw new Error("Choose 16-bit, 24-bit or 32-bit output.");
  return { ...identity };
}

/** Frames of the delivered file, refusing a rate this source cannot be converted to. */
function outputFrames(identity: SourceIdentity, format: DeliveryFormat): number {
  const frames = deliveredFrames(format, identity.sampleRate, identity.frames);
  if (frames > MAX_SOURCE_FRAMES) throw new Error("This track would exceed the converted-length limit at that rate. Choose a lower sample rate.");
  return frames;
}

/** Claim expected IDB source/hash copies and output before loading the source Blob. */
export function reserveReleaseReviewMemory(track: Track, format: DeliveryFormat): ReviewMemory {
  const identity = reviewIdentity(track, format.bitDepth);
  return reserveBrowserAudioMemory((44 + identity.frames * 8) * 3 + 44 + outputFrames(identity, format) * format.bitDepth / 4);
}

/** Render the file Export delivers at this format, then inspect and measure that same
 * file. Transfer this same owner from loading/inspection to the retained measured file. */
export async function collectReleaseReview(source: Blob, track: Track, format: DeliveryFormat, platform: ReleasePlatform, signal: AbortSignal, memory?: ReviewMemory): Promise<ReleaseArtifact> {
  const owned = memory ?? reserveReleaseReviewMemory(track, format);
  try {
    const bits = format.bitDepth, identity = reviewIdentity(track, bits);
    const output = { sampleRate: deliveredRate(format, identity.sampleRate), frames: outputFrames(identity, format) };
    const outputBytes = 44 + output.frames * bits / 4;
    if (source.size !== 44 + identity.frames * 8) throw new Error("The stored source layout changed. Restore the matching source in Library.");
    owned.update(source.size * 3 + outputBytes);
    const render = exportRender(track), request = deliveryRequest(format);
    const script = "script" in render ? render.script : undefined;
    const title = track.title, sourceRevision = track.sourceRevision ?? 0;
    const bindingHash = await releaseBindingHash(track, format, signal);
    await verifyCanonicalSource(source, identity, signal);
    const processingHash = await textHash(JSON.stringify({ ...render, ...request }), signal);
    owned.update(source.size + outputBytes);
    // The same request Export sends for this format, so this file is the delivered file.
    const { blob: wav } = await renderDelivery(source, render, bits, request, signal);
    // Blob + inspection arrayBuffer + possible WebCrypto input copy coexist.
    owned.update(source.size + wav.size * 3);
    const inspected = await inspectEncodedWAV(wav, bits, output, signal);
    owned.update(source.size + wav.size);
    // Bypass measurement decodes the FINAL encoded PCM, including quantization.
    const measured = await measureAudio(wav, { bypass: true }, signal);
    if (measured.sampleRate !== output.sampleRate || measured.frames !== output.frames
      || Math.abs(measured.duration - output.frames / output.sampleRate) > 0.001)
      throw new Error("The measured output layout changed. Run the release check again.");
    await verifyCanonicalSource(source, identity, signal);
    signal.throwIfAborted();
    owned.update(wav.size);
    return { wav, dispose: owned.dispose, report: { version: 1, createdAt: new Date().toISOString(), title, platform,
      bindingHash, processingHash, scriptRevision: script?.revision ?? null, source: identity, sourceRevision,
      output: { ...inspected.encoding, sha256: inspected.sha256, bytes: wav.size }, dither: releaseDither(format), metrics: measured.afterMetrics } };
  } catch (cause) { owned.dispose(); throw cause; }
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
  const dither: unknown = (item as { dither?: unknown }).dither;
  // A converted delivery keeps the duration; an earlier receipt carries no dither field.
  // Silence and full-scale counts describe the delivered file, so they are bounded by its frames.
  const converted = output.sampleRate !== source.sampleRate;
  const expectedFrames = converted ? convertedFrames(source.frames, source.sampleRate, output.sampleRate) : source.frames;
  const silenceThreshold = (output as { silenceThresholdDbfs: unknown }).silenceThresholdDbfs;
  if (!Number.isSafeInteger(source.frames) || source.frames < 1 || source.frames > MAX_SOURCE_FRAMES
    || !Number.isSafeInteger(source.sampleRate) || source.sampleRate < 8000 || source.sampleRate > 192000
    || (converted && !EXPORT_SAMPLE_RATES.some((rate) => rate === output.sampleRate)) || output.frames !== expectedFrames || channels !== 2
    || !(dither === undefined || dither === "tpdf" || dither === "none")
    || ![16, 24, 32].includes(output.bitDepth) || silenceThreshold !== -60
    || output.bytes !== 44 + output.frames * 2 * output.bitDepth / 8
    || ![output.fullScaleFrames, output.leadingSilenceFrames, output.trailingSilenceFrames].every((count) => Number.isSafeInteger(count) && count >= 0 && count <= expectedFrames)
    || Object.keys(item.metrics).length !== 11 || !Object.values(item.metrics).every((number) => typeof number === "number" && Number.isFinite(number))) return undefined;
  const metrics = item.metrics;
  if (![metrics.integratedLufs, metrics.shortTermLufs, metrics.truePeakDbtp, metrics.samplePeakDbfs, metrics.dynamicRangeDb, metrics.correlation,
    metrics.lowBassCorrelation, metrics.dcLeftDbfs, metrics.dcRightDbfs, metrics.clippingSamples, metrics.gainReductionDb].every(Number.isFinite)) return undefined;
  return { version: 1, createdAt: item.createdAt, title: item.title, platform: item.platform as ReleasePlatform,
    bindingHash: item.bindingHash as string, processingHash: item.processingHash as string, scriptRevision: item.scriptRevision as number | null,
    source: { ...source }, sourceRevision: item.sourceRevision as number, output: { ...output },
    dither: dither ?? (output.bitDepth === 32 ? "none" : "tpdf"), metrics: { ...metrics } };
}
