import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { LoudnessMatchGains } from "./live-playback";
import { loudnessMatchRequest, loudnessMatchText, measureLoudnessMatch, readMatchPreference, resolveLoudnessMatch, writeMatchPreference, type LoudnessMatch, type LoudnessReading } from "./loudness-match";
import type { Track } from "./types";

/** Wait for a settings edit to settle before measuring a whole export render. */
const MEASURE_DELAY_MS = 400;

/**
 * The opt-in static A/B loudness match for one track (V1-11). While the stored
 * reading belongs to other settings it reports re-measuring and applies unity,
 * never a stale offset. The preference is per browser, not per project.
 */
export function useLoudnessMatch(track: Track | undefined, source: Blob | null) {
  const [enabled, setEnabledState] = useState(false);
  const [reading, setReading] = useState<LoudnessReading | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  // Read after mount: the static prerender has no localStorage.
  useEffect(() => { setEnabledState(readMatchPreference()); }, []);
  const setEnabled = useCallback((next: boolean) => {
    setEnabledState(next);
    setFailure(null);
    writeMatchPreference(next);
  }, []);
  const request = useMemo(() => {
    if (!track) return null;
    try { return loudnessMatchRequest(track); }
    catch (cause) { return { key: null, error: cause instanceof Error ? cause.message : "These settings cannot be measured." }; }
  }, [track]);
  const pending = useRef(request);
  pending.current = request;
  const key = request?.key ?? null;
  const measuredKey = reading?.key ?? null;
  useEffect(() => {
    const current = pending.current;
    if (!enabled || !source || !current || current.key === null || measuredKey === current.key) return undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      measureLoudnessMatch(source, current, controller.signal).then((next) => {
        if (!controller.signal.aborted) setReading(next);
      }, (cause: unknown) => {
        if (!controller.signal.aborted) setFailure({ key: current.key, message: cause instanceof Error ? cause.message : "A and B could not be measured." });
      });
    }, MEASURE_DELAY_MS);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [enabled, source, key, measuredKey]);
  let match: LoudnessMatch;
  if (!enabled) match = { state: "off" };
  else if (request && "error" in request) match = { state: "unavailable", reason: request.error };
  else if (!source) match = { state: "measuring" };
  else match = resolveLoudnessMatch(true, key, reading, failure);
  const gains: LoudnessMatchGains = match.state === "matched" ? { processedDb: match.processedDb, originalDb: match.originalDb } : { processedDb: 0, originalDb: 0 };
  return { enabled, setEnabled, match, gains, text: loudnessMatchText(match) };
}
