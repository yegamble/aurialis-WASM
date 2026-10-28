/** Shown when live playback cannot keep up; the worklet posts the same text. */
export const OVERLOAD_MESSAGE = "Playback can't keep up on this device with the current processing. Turn off some processing modules, or close other busy apps or tabs, then press Play.";

/** Chromium's AudioContext.playbackStats: what the output device actually missed. */
type PlaybackStatsLike = { underrunDuration: number; underrunEvents: number; totalDuration: number };

export function readPlaybackStats(context: BaseAudioContext): PlaybackStatsLike | null {
  const stats: unknown = Reflect.get(context, "playbackStats");
  if (typeof stats !== "object" || stats === null) return null;
  const read = (key: string) => { const value: unknown = Reflect.get(stats, key); return typeof value === "number" && Number.isFinite(value) ? value : null; };
  const underrunDuration = read("underrunDuration"), underrunEvents = read("underrunEvents"), totalDuration = read("totalDuration");
  return underrunDuration === null || underrunEvents === null || totalDuration === null ? null : { underrunDuration, underrunEvents, totalDuration };
}

/** Share of a ~1 s window the device may spend in underrun before it counts as
 * bad: 1% (10 ms per second). A 60 ms dropout per second is 6%; one 5–8 ms
 * kernel call per second is absorbed by the output buffer and adds nothing. */
const UNDERRUN_SHARE = 0.01;
// Three rules, each over judged windows (about 1 s each; a window is bad over
// 1% underrun):
// 1. Three bad windows in a row.
// 2. Two separate bursts (runs of adjacent bad windows) and over 3% underrun
//    in the last five windows.
// 3. Three separate bursts and 2% or more underrun in the last fifteen, judged
//    only once fifteen windows exist (so the result does not depend on phase).
// By construction, a glitch confined to at most two judged windows cannot
// trigger rule 1 alone (a stall straddling a second boundary, measured 41 ms
// then 12 ms at load average 40, does not stop playback). Wall-clock patterns
// are not windows: on a real host a ~1 s stall spans two or three judged
// windows, and when its recovery reaches a third it stops playback on its own
// (seen in about 1 of 15 stalls, QA E9). Sparse glitches spaced well apart may
// never stop playback. Unit rows and measured examples are in
// `__tests__/live-overload.test.ts` and docs/architecture.md.
const WINDOW_SECONDS = 0.9, STRIKES = 3, RECENT = 5, RECENT_SHARE = 0.03, BURSTS = 2, LONG = 15, LONG_SHARE = 0.02, LONG_BURSTS = 3;

type JudgedWindow = { underrun: number; seconds: number; bad: boolean };
/** At least `minBursts` separate bursts (runs of adjacent bad windows) and more
 * than `share` underrun across `windows` (at least `share` when `inclusive`). */
function judge(windows: readonly JudgedWindow[], minBursts: number, share: number, inclusive = false): boolean {
  const bursts = windows.filter((window, index) => window.bad && !windows[index - 1]?.bad).length;
  const sum = windows.reduce((total, window) => ({ underrun: total.underrun + window.underrun, seconds: total.seconds + window.seconds }), { underrun: 0, seconds: 0 });
  return bursts >= minBursts && (inclusive ? sum.underrun >= share * sum.seconds : sum.underrun > share * sum.seconds);
}

/**
 * Judge sustained device underruns from successive playbackStats samples
 * (about one per second). The first window after (re)start is a warm-up:
 * Chromium records 12–19 underrun events while the stream starts. Three bad
 * windows in a row, two separate bursts with over 3% underrun in the last five
 * windows, or three separate bursts with at least 2% over the last fifteen, are
 * an overload. A glitch confined to two windows cannot trigger the first rule
 * alone.
 */
export function createUnderrunWatch() {
  let previous: PlaybackStatsLike | null = null, windows = 0, strikes = 0;
  let history: JudgedWindow[] = [];
  function reset(): void { previous = null; windows = 0; strikes = 0; history = []; }
  return {
    reset,
    /** True once the overload is confirmed. */
    sample(stats: PlaybackStatsLike): boolean {
      // A duration that runs backwards is a new stream: start over, warm-up included.
      if (previous && stats.totalDuration < previous.totalDuration) reset();
      if (!previous) { previous = { ...stats }; return false; }
      const seconds = stats.totalDuration - previous.totalDuration;
      if (seconds < WINDOW_SECONDS) return false;
      const underrun = stats.underrunDuration - previous.underrunDuration;
      previous = { ...stats };
      if (++windows === 1) return false;
      const bad = underrun > UNDERRUN_SHARE * seconds;
      strikes = bad ? strikes + 1 : 0;
      history = [...history, { underrun, seconds, bad }].slice(-LONG);
      return strikes >= STRIKES || judge(history.slice(-RECENT), BURSTS, RECENT_SHARE)
        || (history.length === LONG && judge(history, LONG_BURSTS, LONG_SHARE, true));
    },
  };
}
