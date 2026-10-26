import { MAX_SOURCE_FRAMES } from "./audio-limits";
import { createDefaultAdvancedParams } from "./audio-dsp";
import { runAudioJob } from "./audio-jobs";
import { deviceAudioRequest } from "./browser-jobs";
import { engineParams } from "./browser-engine";
import { sameSource } from "./library";
import { normalizeShortcutUndo } from "./mastering-shortcuts";
import type { AdvancedParams, MeasuredAudioMetrics, ProfileId, ShortcutUndo, SourceIdentity, Track } from "./types";

export const deepProfiles = ["Warm Analog", "Punchy Commercial", "Dynamic & Open", "Vocal Forward", "Bass Heavy"] as const;
export type DeepProfile = typeof deepProfiles[number];
export type ScriptParams = ReturnType<typeof engineParams> & { algorithmVersion?: number };
export const automationTargets = ["inputGainDb", "eq.0.gainDb", "eq.1.gainDb", "eq.2.gainDb", "eq.3.gainDb", "eq.4.gainDb", "compressor.thresholdDb", "compressor.ratio", "saturation.amount", "stereo.widthPct"] as const;
export type AutomationTarget = typeof automationTargets[number];
interface AutomationPoint { frame: number; value: number }
export interface AutomationMove { id: string; sectionId: string; reason: string; target: AutomationTarget; operation: "absolute" | "add"; points: AutomationPoint[]; fadeFrames: number; muted: boolean }
export interface DeepSection { id: string; name: string; roleHint: "unknown"; startFrame: number; endFrame: number; confidence: number }
export interface ScriptV2 {
  version: "2.0";
  source: SourceIdentity;
  revision: number;
  profile: DeepProfile;
  summary: string;
  chainParams: ScriptParams;
  sections: DeepSection[];
  moves: AutomationMove[];
  findings: { id: string; severity: "info" | "warning"; title: string; detail: string; lane: string }[];
  beforeMetrics: MeasuredAudioMetrics;
}
export interface TargetMetadata { name: AutomationTarget; minimum: number; maximum: number; cellTolerance: number; sampleAccurate: boolean }
interface CompiledScript {
  version: "1.0";
  source: SourceIdentity;
  revision: number;
  deviceRate: number;
  quantumFrames: number;
  baseline: ScriptParams;
  moves: { target: number; fadeFrames: number; muted: boolean; points: AutomationPoint[] }[];
  targets: TargetMetadata[];
  sourceVerified: false;
}
export type DeepSettingsSnapshot = { advanced: AdvancedParams; profile: ProfileId; genre: string; tone: string; intensity: number; target: string; simpleCustom: boolean; shortcutUndo: ShortcutUndo };
export interface DeepMasteringState { sourceRevision: number; proposal: ScriptV2; targets: TargetMetadata[]; applied?: ScriptV2; before?: DeepSettingsSnapshot }

const failure = () => new Error("Invalid or unsupported mastering script.");
function object(value: unknown, names?: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw failure();
  const record = value as Record<string, unknown>;
  if (names && (Object.keys(record).length !== names.length || names.some((name) => !Object.hasOwn(record, name)))) throw failure();
  return record;
}
function number(value: unknown, minimum = -Number.MAX_VALUE, maximum = Number.MAX_VALUE, integer = false): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum || (integer && !Number.isSafeInteger(value))) throw failure();
  return value;
}
function text(value: unknown, maximum = 128): string { if (typeof value !== "string" || value.length > maximum) throw failure(); return value; }
function bool(value: unknown): boolean { if (typeof value !== "boolean") throw failure(); return value; }
function list(value: unknown, maximum: number, minimum = 0): unknown[] { if (!Array.isArray(value) || value.length < minimum || value.length > maximum) throw failure(); return value as unknown[]; }
function source(value: unknown): SourceIdentity {
  const record = object(value, ["pcmHash", "sampleRate", "frames"]);
  const pcmHash = text(record.pcmHash, 64); if (!/^[a-f0-9]{64}$/u.test(pcmHash)) throw failure();
  return { pcmHash, sampleRate: number(record.sampleRate, 8000, 192000, true), frames: number(record.frames, 1, MAX_SOURCE_FRAMES, true) };
}
function typedShape<T>(template: T, value: unknown): T {
  function check(expected: unknown, candidate: unknown): void {
    if (Array.isArray(expected)) { const values = list(candidate, expected.length, expected.length); for (let index = 0; index < expected.length; index++) check(expected.at(index), values.at(index)); }
    else if (typeof expected === "object" && expected !== null) {
      const record = object(candidate, Object.keys(expected));
      for (const [key, item] of Object.entries(expected)) {
        // Fixed DTO keys from the application template, never evaluated target paths.
        // eslint-disable-next-line security/detect-object-injection
        check(item, record[key]);
      }
    } else if (typeof expected === "number") number(candidate);
    else if (typeof expected === "boolean") bool(candidate);
    else if (typeof expected === "string") text(candidate, 128);
    else throw failure();
  }
  check(template, value);
  return value as T;
}
function params(value: unknown): ScriptParams {
  const record = object(value);
  const { algorithmVersion, ...rest } = record;
  const parsed = typedShape(engineParams(createDefaultAdvancedParams()), rest);
  for (const band of parsed.bands) if (!["high_pass", "low_shelf", "peaking", "high_shelf"].includes(band.type)) throw failure();
  if (!["optical", "vari_mu", "fet", "vca"].includes(parsed.compressor.topology) || !["Warm", "Thick", "Crisp", "Clean", "Tube", "Tape", "Transformer"].includes(parsed.saturation.character)) throw failure();
  if (parsed.repair.enabled || (parsed.limiter.enabled && parsed.limiter.truePeak)) throw failure();
  return { ...parsed, ...(algorithmVersion !== undefined ? { algorithmVersion: number(algorithmVersion, 0, 1, true) } : {}) };
}
function points(value: unknown, frames: number): AutomationPoint[] {
  const values = list(value, 256, 2).map((item) => { const point = object(item, ["frame", "value"]); return { frame: number(point.frame, 0, frames, true), value: number(point.value) }; });
  for (let index = 1; index < values.length; index++) if ((values.at(index)?.frame ?? 0) <= (values.at(index - 1)?.frame ?? 0)) throw failure();
  return values;
}
const metricsTemplate: MeasuredAudioMetrics = { integratedLufs: 0, shortTermLufs: 0, truePeakDbtp: 0, samplePeakDbfs: 0, dynamicRangeDb: 0, correlation: 0, lowBassCorrelation: 0, dcLeftDbfs: 0, dcRightDbfs: 0, clippingSamples: 0, gainReductionDb: 0 };

/** DTO safety only. Go remains the authoritative compiler, validator and evaluator. */
export function readScriptV2(value: unknown, expectedSource?: SourceIdentity): ScriptV2 {
  const serialized = JSON.stringify(value);
  if (typeof serialized !== "string" || new TextEncoder().encode(serialized).byteLength > 2 * 1024 * 1024) throw failure();
  const data = object(value, ["version", "source", "revision", "profile", "summary", "chainParams", "sections", "moves", "findings", "beforeMetrics"]);
  const identity = source(data.source);
  if (data.version !== "2.0" || !deepProfiles.some((profile) => profile === data.profile) || (expectedSource && !sameSource(identity, expectedSource))) throw failure();
  const sections = list(data.sections, 128, 1).map((item): DeepSection => {
    const section = object(item, ["id", "name", "roleHint", "startFrame", "endFrame", "confidence"]); if (section.roleHint !== "unknown") throw failure();
    return { id: text(section.id), name: text(section.name, 256), roleHint: "unknown", startFrame: number(section.startFrame, 0, identity.frames, true), endFrame: number(section.endFrame, 1, identity.frames, true), confidence: number(section.confidence, 0, 1) };
  });
  let end = 0; const sectionIds = new Set<string>();
  for (const section of sections) { if (!section.id || sectionIds.has(section.id) || section.startFrame !== end || section.endFrame <= end) throw failure(); sectionIds.add(section.id); end = section.endFrame; }
  if (end !== identity.frames) throw failure();
  const moves = list(data.moves, 128).map((item): AutomationMove => {
    const move = object(item, ["id", "sectionId", "reason", "target", "operation", "points", "fadeFrames", "muted"]);
    if (!automationTargets.some((target) => target === move.target) || (move.operation !== "absolute" && move.operation !== "add")) throw failure();
    return { id: text(move.id), sectionId: text(move.sectionId), reason: text(move.reason, 2048), target: move.target as AutomationTarget, operation: move.operation, points: points(move.points, identity.frames), fadeFrames: number(move.fadeFrames, 0, Math.floor(identity.sampleRate / 10), true), muted: bool(move.muted) };
  });
  const moveIds = new Set<string>();
  for (const move of moves) { if (!move.id || moveIds.has(move.id) || !sectionIds.has(move.sectionId)) throw failure(); moveIds.add(move.id); }
  const findings = list(data.findings, 128).map((item): ScriptV2["findings"][number] => { const finding = object(item, ["id", "severity", "title", "detail", "lane"]); if (finding.severity !== "info" && finding.severity !== "warning") throw failure(); return { id: text(finding.id), severity: finding.severity, title: text(finding.title, 256), detail: text(finding.detail, 2048), lane: text(finding.lane) }; });
  return { version: "2.0", source: identity, revision: number(data.revision, 1, Number.MAX_SAFE_INTEGER, true), profile: data.profile as DeepProfile, summary: text(data.summary, 4096), chainParams: params(data.chainParams), sections, moves, findings, beforeMetrics: typedShape(metricsTemplate, data.beforeMetrics) };
}

export function analyzeDeep(blob: Blob, profile: DeepProfile, identity: SourceIdentity, signal: AbortSignal, onProgress: (progress: number, stage: string) => void): Promise<ScriptV2> {
  const body = new FormData(); body.append("file", blob, "source.wav"); body.append("scriptVersion", "2.0"); body.append("profile", profile);
  return runAudioJob("/api/analyze/deep", body, signal, onProgress, (job) => { if (job.kind !== "analyze_deep_v2") throw failure(); return readScriptV2(job.scriptV2, identity); });
}

function targetMetadata(value: unknown): TargetMetadata[] {
  return list(value, automationTargets.length, automationTargets.length).map((item, index) => {
    const target = object(item, ["name", "minimum", "maximum", "cellTolerance", "sampleAccurate"]);
    const minimum = number(target.minimum); const maximum = number(target.maximum);
    if (target.name !== automationTargets.at(index) || minimum > maximum) throw failure();
    return { name: target.name as AutomationTarget, minimum, maximum, cellTolerance: number(target.cellTolerance, 0), sampleAccurate: bool(target.sampleAccurate) };
  });
}
function sameJSON(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left)) return Array.isArray(right) && left.length === right.length && left.every((item, index) => sameJSON(item, right.at(index)));
  if (typeof left !== "object" || left === null || typeof right !== "object" || right === null || Array.isArray(right)) return false;
  const candidate = right as Record<string, unknown>;
  return Object.keys(left).length === Object.keys(right).length && Object.entries(left).every(([key, item]) => {
    // Fixed DTO members, compared as data rather than interpreted target paths.
    // eslint-disable-next-line security/detect-object-injection
    return Object.hasOwn(candidate, key) && sameJSON(item, candidate[key]);
  });
}
function compiledScript(value: unknown, script: ScriptV2, deviceRate: number): CompiledScript {
  const data = object(value, ["version", "source", "revision", "deviceRate", "quantumFrames", "baseline", "moves", "targets", "sourceVerified"]);
  const identity = source(data.source); const baseline = params(data.baseline);
  if (data.version !== "1.0" || data.sourceVerified !== false || data.revision !== script.revision || data.deviceRate !== deviceRate || !sameSource(identity, script.source) || !sameJSON(baseline, script.chainParams)) throw failure();
  const targets = targetMetadata(data.targets);
  const moves = list(data.moves, 128).map((item) => { const move = object(item, ["target", "fadeFrames", "muted", "points"]); return { target: number(move.target, 0, targets.length - 1, true), fadeFrames: number(move.fadeFrames, 0, Math.floor(identity.sampleRate / 10), true), muted: bool(move.muted), points: points(move.points, identity.frames) }; });
  return { version: "1.0", source: identity, revision: script.revision, deviceRate, quantumFrames: number(data.quantumFrames, 1, 192, true), baseline, moves, targets, sourceVerified: false };
}

/** Ask the common Go compiler for its bounded numeric packet; never evaluate moves here. */
export async function compileScript(script: ScriptV2, deviceRate: number, signal?: AbortSignal): Promise<CompiledScript> {
  number(deviceRate, 8000, 192000, true); readScriptV2(script);
  const response = await deviceAudioRequest(`/api/automation/compile?deviceRate=${String(deviceRate)}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(script), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000) });
  const body: unknown = await response.json();
  if (!response.ok) { const error = object(body); throw new Error(typeof error.detail === "string" ? error.detail.slice(0, 2048) : "The proposed automation could not be validated."); }
  return compiledScript(body, script, deviceRate);
}

/** Hydration never applies a saved script; the live controller validates it before publication. */
export function readDeepMasteringState(value: unknown, identity: SourceIdentity | undefined, sourceRevision: number): DeepMasteringState {
  if (!identity) throw failure();
  const data = object(value); const allowed = ["sourceRevision", "proposal", "targets", "applied", "before"];
  if (Object.keys(data).some((key) => !allowed.includes(key)) || data.sourceRevision !== sourceRevision) throw failure();
  const proposal = readScriptV2(data.proposal, identity); const targets = targetMetadata(data.targets);
  const state: DeepMasteringState = { sourceRevision, proposal, targets };
  if (data.applied !== undefined) state.applied = readScriptV2(data.applied, identity);
  if (data.before !== undefined) {
    const before = object(data.before, ["advanced", "profile", "genre", "tone", "intensity", "target", "simpleCustom", "shortcutUndo"]);
    if (!["modern_pop_polish", "hip_hop_low_end", "indie_warmth", "metal_wall", "pop_punk_air"].includes(text(before.profile))) throw failure();
    object(before.shortcutUndo);
    if (!sameJSON(normalizeShortcutUndo(before.shortcutUndo), before.shortcutUndo)) throw failure();
    state.before = { advanced: typedShape(createDefaultAdvancedParams(), before.advanced), profile: before.profile as ProfileId, genre: text(before.genre), tone: text(before.tone), intensity: number(before.intensity, 0, 100), target: text(before.target), simpleCustom: bool(before.simpleCustom), shortcutUndo: normalizeShortcutUndo(before.shortcutUndo) };
  }
  if ((state.applied === undefined) !== (state.before === undefined)) throw failure();
  return state;
}

export function deepSourceMatches(track: Pick<Track, "sourceRevision" | "sourceIdentity">, script: ScriptV2, revision: number): boolean {
  return (track.sourceRevision ?? 0) === revision && sameSource(track.sourceIdentity, script.source);
}

/** Adapt the supported static controls for display; automation stays in the Go schedule. */
export function advancedFromScript(script: ScriptV2): AdvancedParams {
  const params = script.chainParams; const base = createDefaultAdvancedParams();
  const types = { high_pass: "highpass", low_shelf: "lowshelf", peaking: "peaking", high_shelf: "highshelf" } as const;
  return { ...base, input: params.inputGainDb, threshold: params.compressor.thresholdDb, ratio: params.compressor.ratio, attack: params.compressor.attackMs, release: params.compressor.releaseMs, width: params.stereo.widthPct, saturation: params.saturation.amount,
    eqEnabled: params.eqEnabled,
    eqBands: base.eqBands.map((band, index) => { const item = params.bands.at(index); if (!item) throw failure(); const type = Object.entries(types).find(([name]) => name === item.type)?.[1]; if (!type) throw failure(); return { ...band, enabled: item.enabled, type, freqHz: item.freqHz, gainDb: item.gainDb, q: item.q }; }) as AdvancedParams["eqBands"],
    compressor: { enabled: params.compressor.enabled, threshold: params.compressor.thresholdDb, ratio: params.compressor.ratio, attack: params.compressor.attackMs, release: params.compressor.releaseMs, knee: params.compressor.kneeDb, makeup: params.compressor.makeupDb, sidechainHpfHz: params.compressor.sidechainHpfHz, autoRelease: params.compressor.autoRelease, topology: params.compressor.topology },
    saturationModule: { enabled: params.saturation.enabled, drive: params.saturation.amount, character: params.saturation.character },
    stereo: { enabled: params.stereo.enabled, width: params.stereo.widthPct, monoBass: params.stereo.monoBass, crossoverHz: params.stereo.crossoverHz, midGainDb: params.stereo.midGainDb, sideGainDb: params.stereo.sideGainDb },
    limiter: { enabled: params.limiter.enabled, ceiling: params.limiter.ceilingDbtp, targetLufs: params.limiter.targetLufs, release: params.limiter.releaseMs, truePeak: params.limiter.truePeak },
    deHarsh: params.deHarsh, multiband: params.multiband,
  };
}

export function deepSettingsSnapshot(track: Track): DeepSettingsSnapshot {
  return { advanced: track.advanced, profile: track.profile, genre: track.genre, tone: track.tone, intensity: track.intensity, target: track.target, simpleCustom: track.simpleCustom ?? true, shortcutUndo: track.shortcutUndo ?? {} };
}

export function advancedMatchesScript(advanced: AdvancedParams, script: ScriptV2): boolean {
  return sameJSON(engineParams(advanced), engineParams(advancedFromScript(script)));
}

/** Immutable accepted revisions make cache identity independent of schedule size. */
export function appliedRevisionKey(track: Track): string | null {
  const script = track.deepMastering?.applied;
  return script ? ["script", track.id, track.sourceAudioId ?? track.id, track.sourceRevision ?? 0, script.source.pcmHash, script.revision].join(":") : null;
}
