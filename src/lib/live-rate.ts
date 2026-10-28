import { formatRate } from "./export-rates";

/** Highest rate live playback runs at. The CPU gate, on the real worklet, is a
 * mean kernel load of at most half the quantum (2× headroom). With every module
 * on, QA measured 0.35–0.47 at 48 kHz (2.1–2.9×) and 0.65 at 96 kHz (1.53×), so
 * higher rates are capped (docs/tasks.md V1-10). The Node V8 bench reads about
 * 2.5× lower load and is not used for this gate. */
const LIVE_MAX_SAMPLE_RATE = 48000;

/** Rate the live AudioContext opens at: the source rate up to 48 kHz; above
 * it, 44.1 kHz for the 44.1 kHz family (88.2, 176.4) and 48 kHz otherwise.
 * The ratio is an integer for the 44.1/48 kHz families (88.2, 176.4, 96, 192);
 * any other rate above 48 kHz plays at 48 kHz at a non-integer ratio. Exports
 * keep the source rate. */
export function liveContextRate(sourceRate: number): number {
  if (sourceRate <= LIVE_MAX_SAMPLE_RATE) return sourceRate;
  return sourceRate % 44100 === 0 ? 44100 : 48000;
}

/** What can honestly be said about the rate live A is processed at. */
export type LiveRateStatus =
  | { kind: "pending" } // at or below the cap, before the context exists: no rate claim
  | { kind: "source" } // the context runs at the source rate
  | { kind: "capped"; liveRate: number; sourceRate: number } // above the cap, by design
  | { kind: "resampled"; liveRate: number; targetRate: number; sourceRate: number }; // the browser refused the target rate

export function liveRateStatus(sourceRate: number, contextRate: number | undefined): LiveRateStatus {
  const target = liveContextRate(sourceRate);
  if (contextRate !== undefined && contextRate !== target) return { kind: "resampled", liveRate: contextRate, targetRate: target, sourceRate };
  if (target !== sourceRate) return { kind: "capped", liveRate: target, sourceRate };
  return contextRate === undefined ? { kind: "pending" } : { kind: "source" };
}

/** Plain note for a live rate other than the source's, or null. */
export function liveRateNote(status: LiveRateStatus): string | null {
  if (status.kind === "capped")
    return `Aurialis plays this ${formatRate(status.sourceRate)} source live at ${formatRate(status.liveRate)} to stay within its live CPU budget, so live A may differ slightly from the export (about 0.2 LU). Use Audition export for an exact listen; the export keeps the source's ${formatRate(status.sourceRate)}.`;
  if (status.kind === "resampled")
    return `This device plays A at ${formatRate(status.liveRate)}, not ${status.targetRate === status.sourceRate ? "the source's " : ""}${formatRate(status.targetRate)}, so live A is resampled before processing and may differ slightly from the export (about 0.2 LU). Use Audition export for an exact listen.`;
  return null;
}

/** The live half of the Set target loudness summary. */
export function liveRateClaim(status: LiveRateStatus): string {
  switch (status.kind) {
    case "pending": return "Live playback runs the same chain.";
    case "source": return "Live playback runs the same chain at the source rate.";
    case "capped": return `Live playback runs the same chain at ${formatRate(status.liveRate)} to stay within its CPU budget; the export keeps the source's ${formatRate(status.sourceRate)}.`;
    case "resampled": return "Live playback runs the same chain, resampled on this device, so it may differ slightly.";
  }
}
