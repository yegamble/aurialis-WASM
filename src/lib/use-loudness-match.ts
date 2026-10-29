import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LoudnessMatchGains } from "./live-playback";
import { loudnessMatchRequest, loudnessMatchText, measureLoudnessMatch, readMatchPreference, resolveLoudnessMatch, writeMatchPreference, type LoudnessMatch, type LoudnessReading } from "./loudness-match";
import type { MonitorMode } from "./monitor-mode";
import type { Track } from "./types";

/** Wait for a settings edit to settle before measuring a whole render. */
const MEASURE_DELAY_MS = 400;
/** Retry after a user job preempted the background measurement. */
const RETRY_DELAY_MS = 1500;

/**
 * The opt-in static A/B loudness match for one track (V1-11). While edited
 * settings are re-measured it keeps applying the previous static offset for the
 * same track and source ("Re-measuring (holding …)"); a reading from another
 * track or source is never applied, so that case plays at unity. The background
 * measurement yields to Export, Deep and other user jobs and retries later.
 * The preference is per browser, not per project.
 */
export function useLoudnessMatch(track: Track | undefined, source: Blob | null, monitorMode: MonitorMode = "stereo") {
  const [enabled, setEnabledState] = useState(false);
  const [reading, setReading] = useState<LoudnessReading | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  // Read after mount: the static prerender has no localStorage.
  useEffect(() => { setEnabledState(readMatchPreference()); }, []);
  const setEnabled = useCallback((next: boolean) => {
    setEnabledState(next);
    setFailure(null);
    writeMatchPreference(next);
  }, []);
  const request = useMemo(() => {
    if (!track) return null;
    try { return loudnessMatchRequest(track, monitorMode); }
    catch (cause) { return { key: null, scope: null, error: cause instanceof Error ? cause.message : "These settings cannot be measured." }; }
  }, [track, monitorMode]);
  const pending = useRef(request);
  pending.current = request;
  const key = request?.key ?? null;
  const measuredKey = reading?.key ?? null;
  useEffect(() => {
    const current = pending.current;
    if (!enabled || !source || !current || current.key === null || measuredKey === current.key) return undefined;
    const controller = new AbortController();
    let retry: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      measureLoudnessMatch(source, current, controller.signal).then((next) => {
        if (!controller.signal.aborted) setReading(next);
      }, (cause: unknown) => {
        if (controller.signal.aborted) return;
        // Export, Deep or another user job took the local queue: measure again later.
        // DOMException is not an Error in every realm, so read its fields directly.
        const name = typeof cause === "object" && cause !== null && "name" in cause ? String(cause.name) : "";
        if (name === "AbortError" || (cause instanceof Error && cause.message.includes("busy"))) retry = setTimeout(() => { setAttempt((count) => count + 1); }, RETRY_DELAY_MS);
        else setFailure({ key: current.key, message: cause instanceof Error ? cause.message : "A and B could not be measured." });
      });
    }, MEASURE_DELAY_MS);
    return () => { clearTimeout(timer); clearTimeout(retry); controller.abort(); };
  }, [enabled, source, key, measuredKey, attempt]);
  let match: LoudnessMatch;
  if (!enabled) match = { state: "off" };
  else if (request && "error" in request) match = { state: "unavailable", reason: request.error };
  else if (!source || !request) match = { state: "measuring", held: null };
  else match = resolveLoudnessMatch(true, request, reading, failure);
  // Static either way: the measured offset, or the previous one held while re-measuring.
  const applied = match.state === "matched" ? match : match.state === "measuring" ? match.held : null;
  const gains: LoudnessMatchGains = applied ? { processedDb: applied.processedDb, originalDb: applied.originalDb } : { processedDb: 0, originalDb: 0 };
  return { enabled, setEnabled, match, gains, text: loudnessMatchText(match) };
}
