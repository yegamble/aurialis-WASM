import { clampAdvancedToSampleRate } from "./audio-dsp";
import { measureRender } from "./browser-engine";
import { appliedRevisionKey, type ScriptV2 } from "./deep-mastering";
import { engineParams } from "./engine-params";
import type { Track } from "./types";

/**
 * Opt-in, static, attenuate-only A/B loudness match for monitoring (V1-11).
 *
 * One fixed gain, computed from the integrated loudness of an offline render of
 * exactly what live playback plays (A) and the source (B), lowers whichever is
 * louder. It never boosts, never
 * tracks the signal over time, and never reaches export: the transport applies
 * it after the engine, and export requests are built without it.
 */

/** Integrated loudness of A (render of the live settings) and B (source), for one settings key. */
export type LoudnessReading = { key: string; processedLufs: number; originalLufs: number };

export type LoudnessMatch =
  | { state: "off" }
  | { state: "measuring" }
  | { state: "unavailable"; reason: string }
  | {
    state: "matched";
    /** Applied to A Processed and B Original; each is ≤ 0 dB and at least one is exactly 0 dB. */
    processedDb: number;
    originalDb: number;
    processedGain: number;
    originalGain: number;
    /** The attenuated side, or null when both already measure the same. */
    attenuated: "A" | "B" | null;
  };

type LoudnessMatchRequest = { key: string; render: { params: object } | { script: ScriptV2 } };

/** BS.1770 gating reports −70 LUFS for silence; a match against it would be meaningless. */
const SILENCE_LUFS = -70;
/** Offsets that display as 0.0 dB are reported as already matched. */
const MATCHED_DB = 0.05;
const PREFERENCE_KEY = "aurialis-match-loudness-v1";

/** Attenuate only the louder side by the measured difference. */
export function matchGains(processedLufs: number, originalLufs: number): { processedDb: number; originalDb: number } {
  const difference = processedLufs - originalLufs;
  return difference > 0 ? { processedDb: -difference, originalDb: 0 } : { processedDb: 0, originalDb: difference };
}

/**
 * The match for the current settings. A reading measured for other settings
 * is stale: report re-measuring and apply nothing rather than a wrong offset.
 */
export function resolveLoudnessMatch(enabled: boolean, key: string | null, reading: LoudnessReading | null, error?: { key: string; message: string } | null): LoudnessMatch {
  if (!enabled) return { state: "off" };
  if (key === null) return { state: "unavailable", reason: "Restore the source audio to measure A and B." };
  if (error?.key === key) return { state: "unavailable", reason: error.message };
  if (reading?.key !== key) return { state: "measuring" };
  const { processedLufs, originalLufs } = reading;
  if (!Number.isFinite(processedLufs) || !Number.isFinite(originalLufs) || processedLufs <= SILENCE_LUFS || originalLufs <= SILENCE_LUFS)
    return { state: "unavailable", reason: "A or B is too quiet to measure." };
  const { processedDb, originalDb } = matchGains(processedLufs, originalLufs);
  const offset = Math.min(processedDb, originalDb);
  return {
    state: "matched", processedDb, originalDb,
    processedGain: 10 ** (processedDb / 20), originalGain: 10 ** (originalDb / 20),
    attenuated: offset > -MATCHED_DB ? null : processedDb < 0 ? "A" : "B",
  };
}

/** Visible and announced description of the applied offset. */
export function loudnessMatchText(match: LoudnessMatch): string {
  switch (match.state) {
    case "off": return "";
    case "measuring": return "Measuring A and B loudness…";
    case "unavailable": return `Match unavailable. ${match.reason}`;
    case "matched": {
      if (match.attenuated === null) return "A and B already match";
      const offset = (match.attenuated === "A" ? match.processedDb : match.originalDb).toFixed(1).replace("-", "−");
      return `${match.attenuated} ${offset} dB to match ${match.attenuated === "A" ? "B" : "A"}`;
    }
  }
}

/**
 * What live playback plays for this track: the algorithm 1 settings the
 * worklet receives, or the applied Deep revision as it is attached. Export's
 * true-peak limiter reads up to about 2 LU quieter on heavily limited masters,
 * so measuring export would mis-match what is heard (Round E). When V1-10
 * moves live playback to the export algorithm, this follows automatically.
 */
export function loudnessMatchRequest(track: Track): LoudnessMatchRequest {
  const applied = track.deepMastering?.applied;
  const render = applied ? { script: applied } : { params: engineParams(clampAdvancedToSampleRate(track.advanced, track.sampleRate)) };
  const settings = appliedRevisionKey(track) ?? JSON.stringify(render);
  return { key: ["match", track.id, track.sourceAudioId ?? track.id, track.sourceRevision ?? 0, track.sourceIdentity?.pcmHash ?? "", settings].join("|"), render };
}

/** One offline measurement of A and B through the live settings. */
export async function measureLoudnessMatch(source: Blob, request: LoudnessMatchRequest, signal: AbortSignal): Promise<LoudnessReading> {
  const measured = await measureRender(source, request.render, signal);
  signal.throwIfAborted();
  return { key: request.key, processedLufs: measured.afterMetrics.integratedLufs, originalLufs: measured.beforeMetrics.integratedLufs };
}

/** Per-browser monitoring preference; never stored in a project or export. */
export function readMatchPreference(): boolean {
  try { return localStorage.getItem(PREFERENCE_KEY) === "1"; } catch { return false; }
}

export function writeMatchPreference(enabled: boolean): void {
  try { localStorage.setItem(PREFERENCE_KEY, enabled ? "1" : "0"); } catch { /* Storage can be unavailable; the toggle still works for this page. */ }
}
