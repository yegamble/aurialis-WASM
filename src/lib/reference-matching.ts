import { runAudioJob } from "./audio-jobs";
import { engineParams } from "./browser-engine";
import { sameSource } from "./library";
import { verifyCanonicalSource } from "./project-import";
import type { AdvancedParams, SourceIdentity } from "./types";

export interface ReferenceOptions { amount: number; protectBelowHz: 0 | 120; includeWidth: boolean }
interface ReferenceBand { lowHz: number; highHz: number; sourceDensityDb: number; referenceDensityDb: number; targetDeltaDb: number; predictedDeltaDb: number; included: boolean }
interface ReferenceWidth { sourceSideMidDb: number; referenceSideMidDb: number; beforeSideMidDb: number; afterSideMidDb: number; beforeCorrelation: number; afterCorrelation: number; beforeWidthPct: number; afterWidthPct: number; afterSamplePeakDbfs: number; applied: boolean; reason: string }
export interface ReferenceProposal {
  version: "1.0";
  sourceSpectrum: "baseline_rendered";
  source: SourceIdentity;
  reference: SourceIdentity;
  options: ReferenceOptions;
  advanced: AdvancedParams;
  bands: ReferenceBand[];
  beforeOutputResidualDb: number;
  afterOutputResidualDb: number;
  beforeResidualDb: number;
  fitResidualDb: number;
  maxPredictedBoostDb: number;
  maxProtectedDeltaDb: number;
  remeasuredProtectedDeltaDb: number;
  protectionVerified: boolean;
  width?: ReferenceWidth;
  warnings: string[];
}
const failure = () => new Error("Invalid or stale measured reference proposal.");
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw failure();
  return value as Record<string, unknown>;
}
function number(value: unknown, low = -Number.MAX_VALUE, high = Number.MAX_VALUE): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < low || value > high) throw failure();
  return value;
}
function bool(value: unknown): boolean { if (typeof value !== "boolean") throw failure(); return value; }
function text(value: unknown): string { if (typeof value !== "string" || value.length > 2048) throw failure(); return value; }
function source(value: unknown): SourceIdentity {
  const item = object(value);
  const pcmHash = text(item.pcmHash), sampleRate = number(item.sampleRate, 8000, 192000), frames = number(item.frames, 1, 16_777_216);
  if (!/^[a-f0-9]{64}$/u.test(pcmHash) || !Number.isInteger(sampleRate) || !Number.isInteger(frames)) throw failure();
  return { pcmHash, sampleRate, frames };
}
/** Compare fixed DTO members as data; no property paths are evaluated. */
function equal(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left)) return Array.isArray(right) && left.length === right.length && left.every((item, i) => equal(item, right.at(i)));
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null || Array.isArray(right)) return false;
  const record = right as Record<string, unknown>;
  return Object.keys(left).length === Object.keys(right).length && Object.entries(left).every(([key, item]) => {
    // Closed application DTO members, never interpreted as a target path.
    // eslint-disable-next-line security/detect-object-injection
    return Object.hasOwn(record, key) && equal(item, record[key]);
  });
}

/** Only the audio engine's bounded EQ gains and opt-in width may differ from the exact submitted baseline. */
function proposedAdvanced(value: unknown, baseline: AdvancedParams, options: ReferenceOptions): AdvancedParams {
  const candidate = object(value), expected = engineParams(baseline);
  if (!Array.isArray(candidate.bands) || candidate.bands.length !== 5) throw failure();
  const bands = candidate.bands.map((item: unknown, i) => {
    const band = object(item), original = expected.bands.at(i);
    if (!original) throw failure();
    const gain = number(band.gainDb, -24, 24);
    if (Math.abs(gain - original.gainDb) > 3.00000001 || ((!original.enabled || !expected.eqEnabled || options.amount === 0) && gain !== original.gainDb)) throw failure();
    return { ...original, gainDb: gain };
  });
  const stereo = object(candidate.stereo), width = number(stereo.widthPct, 0, 200);
  if ((!options.includeWidth || !expected.stereo.enabled || options.amount === 0) && width !== expected.stereo.widthPct) throw failure();
  if (Math.abs(width - expected.stereo.widthPct) > 20 * options.amount + 1e-8) throw failure();
  const permitted = { ...expected, bands, stereo: { ...expected.stereo, widthPct: width } };
  if (!equal(candidate, permitted)) throw failure();
  const eqBands = baseline.eqBands.map((band, i) => ({ ...band, gainDb: bands.at(i)?.gainDb ?? band.gainDb })) as AdvancedParams["eqBands"];
  return { ...baseline, eqBands, width: width === baseline.stereo.width ? baseline.width : width, stereo: { ...baseline.stereo, width } };
}
function readProposal(value: unknown, baseline: AdvancedParams, options: ReferenceOptions): ReferenceProposal {
  const data = object(value);
  const returnedOptions = object(data.options);
  if (data.version !== "1.0" || data.sourceSpectrum !== "baseline_rendered" || !equal(data.baseline, engineParams(baseline)) || !equal({ ...returnedOptions, includeWidth: returnedOptions.includeWidth === undefined ? false : bool(returnedOptions.includeWidth) }, options)) throw failure();
  if (!Array.isArray(data.bands) || data.bands.length !== 5 || !Array.isArray(data.warnings) || data.warnings.length > 20) throw failure();
  const identity = source(data.source), reference = source(data.reference);
  const edges = [20, 120, 500, 2000, 6000, 20000].map((edge) => Math.min(edge, Math.min(identity.sampleRate, reference.sampleRate) / 2));
  const bands = data.bands.map((item: unknown, i): ReferenceBand => {
    const band = object(item);
    if (band.lowHz !== edges.at(i) || band.highHz !== edges.at(i + 1)) throw failure();
    return { lowHz: number(band.lowHz), highHz: number(band.highHz), sourceDensityDb: number(band.sourceDensityDb), referenceDensityDb: number(band.referenceDensityDb), targetDeltaDb: number(band.targetDeltaDb, -6, 6), predictedDeltaDb: number(band.predictedDeltaDb), included: bool(band.included) };
  });
  const result: ReferenceProposal = { version: "1.0", sourceSpectrum: "baseline_rendered", source: identity, reference, options, advanced: proposedAdvanced(data.params, baseline, options), bands,
    beforeOutputResidualDb: number(data.beforeOutputResidualDb, 0), afterOutputResidualDb: number(data.afterOutputResidualDb, 0),
    beforeResidualDb: number(data.beforeResidualDb, 0), fitResidualDb: number(data.fitResidualDb, 0), maxPredictedBoostDb: number(data.maxPredictedBoostDb, 0, 3.00000001), maxProtectedDeltaDb: number(data.maxProtectedDeltaDb, 0), remeasuredProtectedDeltaDb: number(data.remeasuredProtectedDeltaDb), protectionVerified: bool(data.protectionVerified), warnings: data.warnings.map(text) };
  if (options.protectBelowHz && (result.maxProtectedDeltaDb > .25000001 || Math.abs(result.remeasuredProtectedDeltaDb) > .25000001)) throw failure();
  if (data.width !== undefined) {
    if (!options.includeWidth) throw failure();
    const width = object(data.width);
    result.width = { sourceSideMidDb: number(width.sourceSideMidDb), referenceSideMidDb: number(width.referenceSideMidDb), beforeSideMidDb: number(width.beforeSideMidDb), afterSideMidDb: number(width.afterSideMidDb), beforeCorrelation: number(width.beforeCorrelation, -1, 1), afterCorrelation: number(width.afterCorrelation, -1, 1), beforeWidthPct: number(width.beforeWidthPct, 0, 200), afterWidthPct: number(width.afterWidthPct, 0, 200), afterSamplePeakDbfs: number(width.afterSamplePeakDbfs), applied: bool(width.applied), reason: text(width.reason) };
    if (result.width.afterWidthPct !== result.advanced.stereo.width || (result.width.applied && result.width.afterCorrelation < .1)) throw failure();
  }
  return result;
}

/** Measure the two actual loaded sources; saved reference knob positions are never inputs. */
export async function matchReference(sourceBlob: Blob, referenceBlob: Blob, baseline: AdvancedParams, options: ReferenceOptions, expected: { source: SourceIdentity; reference: SourceIdentity }, signal: AbortSignal, onProgress: (progress: number, stage: string) => void): Promise<ReferenceProposal> {
  signal.throwIfAborted();
  await verifyCanonicalSource(sourceBlob, expected.source, signal);
  await verifyCanonicalSource(referenceBlob, expected.reference, signal);
  const form = new FormData();
  form.append("source", sourceBlob, "source.wav"); form.append("reference", referenceBlob, "reference.wav");
  form.append("params", JSON.stringify(engineParams(baseline))); form.append("options", JSON.stringify(options));
  const result = await runAudioJob("/api/analyze/reference", form, signal, onProgress, (job) => { if (job.kind !== "analyze_reference") throw failure(); return readProposal(job.referenceProposal, baseline, options); });
  signal.throwIfAborted();
  if (!sameSource(result.source, expected.source) || !sameSource(result.reference, expected.reference)) throw failure();
  onProgress(100, "Verifying the loaded source and reference…");
  await verifyCanonicalSource(sourceBlob, result.source, signal);
  await verifyCanonicalSource(referenceBlob, result.reference, signal);
  if (sameSource(result.source, result.reference)) result.warnings = [...result.warnings, "The source and reference contain the same reconstructed PCM."];
  return result;
}

export function hasAppliedDeep(track: unknown): boolean {
  const deep: unknown = typeof track === "object" && track !== null && "deepMastering" in track ? track.deepMastering : undefined;
  return typeof deep === "object" && deep !== null && "applied" in deep && deep.applied !== undefined;
}
