import { clampAdvancedToSampleRate } from "./audio-dsp";
import { measureRender } from "./browser-engine";
import { type ScriptV2 } from "./deep-mastering";
import { exportParams, exportScript } from "./engine-params";
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

/**
 * Integrated loudness of A (render of the live settings) and B (source). `key`
 * names the measured settings; `scope` the track and source they belong to.
 */
export type LoudnessReading = { key: string; scope: string; processedLufs: number; originalLufs: number };

/** Applied to A Processed and B Original; each is ≤ 0 dB and at least one is exactly 0 dB. */
type MatchOffset = {
  processedDb: number;
  originalDb: number;
  /** The attenuated side, or null when both already measure the same. */
  attenuated: "A" | "B" | null;
};

export type LoudnessMatch =
  | { state: "off" }
  /** `held` is the previous static offset for this track and source, kept until the new reading arrives. */
  | { state: "measuring"; held: MatchOffset | null }
  | { state: "unavailable"; reason: string }
  | ({ state: "matched" } & MatchOffset);

type LoudnessMatchRequest = { key: string; scope: string; render: { params: object } | { script: ScriptV2 } };

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

function offsetOf({ processedLufs, originalLufs }: LoudnessReading): MatchOffset | null {
  if (!Number.isFinite(processedLufs) || !Number.isFinite(originalLufs) || processedLufs <= SILENCE_LUFS || originalLufs <= SILENCE_LUFS) return null;
  const { processedDb, originalDb } = matchGains(processedLufs, originalLufs);
  return { processedDb, originalDb, attenuated: Math.min(processedDb, originalDb) > -MATCHED_DB ? null : processedDb < 0 ? "A" : "B" };
}

/**
 * The match for the current settings. A reading for other settings of the
 * same track and source keeps its static offset while re-measuring (Round E);
 * one from another source is never applied.
 */
export function resolveLoudnessMatch(enabled: boolean, current: { key: string; scope: string } | null, reading: LoudnessReading | null, error?: { key: string; message: string } | null): LoudnessMatch {
  if (!enabled) return { state: "off" };
  if (current === null) return { state: "unavailable", reason: "Restore the source audio to measure A and B." };
  if (error?.key === current.key) return { state: "unavailable", reason: error.message };
  if (reading?.key !== current.key) return { state: "measuring", held: reading?.scope === current.scope ? offsetOf(reading) : null };
  const offset = offsetOf(reading);
  return offset ? { state: "matched", ...offset } : { state: "unavailable", reason: "A or B is too quiet to measure." };
}

function offsetText(offset: MatchOffset): string {
  if (offset.attenuated === null) return "0.0";
  return (offset.attenuated === "B" ? offset.originalDb : offset.processedDb).toFixed(1).replace("-", "−");
}

/** Visible and announced description of the applied offset. */
export function loudnessMatchText(match: LoudnessMatch): string {
  switch (match.state) {
    case "off": return "";
    case "measuring":
      if (!match.held) return "Measuring A and B loudness…";
      return `Re-measuring (holding ${match.held.attenuated === null ? "" : match.held.attenuated + " "}${offsetText(match.held)} dB)`;
    case "unavailable": return `Match unavailable. ${match.reason}`;
    case "matched": {
      if (match.attenuated === null) return "A and B already match";
      return `${match.attenuated} ${offsetText(match)} dB to match ${match.attenuated === "A" ? "B" : "A"}`;
    }
  }
}

/**
 * What live playback plays for this track: the live settings the worklet
 * receives, or the applied Deep revision as it is attached. A must be measured
 * on what is heard (Round E); since V1-10 that is the export algorithm, so the
 * same exportParams/exportScript the player uses build this render.
 */
export function loudnessMatchRequest(track: Track): LoudnessMatchRequest {
  const applied = track.deepMastering?.applied;
  const render = applied ? { script: exportScript(applied, track.advanced.renderQuality ?? "classic") } : { params: exportParams(clampAdvancedToSampleRate(track.advanced, track.sampleRate)) };
  const settings = JSON.stringify(render);
  const scope = ["match", track.id, track.sourceAudioId ?? track.id, track.sourceRevision ?? 0, track.sourceIdentity?.pcmHash ?? ""].join("|");
  return { key: `${scope}|${settings}`, scope, render };
}

/** One offline measurement of A and B through the live settings. */
export async function measureLoudnessMatch(source: Blob, request: LoudnessMatchRequest, signal: AbortSignal): Promise<LoudnessReading> {
  // Background: Export, Deep analysis and other user jobs preempt it in the browser queue.
  const measured = await measureRender(source, request.render, signal, "background");
  signal.throwIfAborted();
  return { key: request.key, scope: request.scope, processedLufs: measured.afterMetrics.integratedLufs, originalLufs: measured.beforeMetrics.integratedLufs };
}

/** Per-browser monitoring preference; never stored in a project or export. */
export function readMatchPreference(): boolean {
  try { return localStorage.getItem(PREFERENCE_KEY) === "1"; } catch { return false; }
}

export function writeMatchPreference(enabled: boolean): void {
  try { localStorage.setItem(PREFERENCE_KEY, enabled ? "1" : "0"); } catch { /* Storage can be unavailable; the toggle still works for this page. */ }
}
