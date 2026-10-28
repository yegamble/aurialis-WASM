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
// Three bad seconds in a row: one host stall that straddles a second boundary
// (measured: 41 ms then 12 ms, at load average 40) is two bad seconds and must
// not stop playback; a sustained 60 ms-per-second dropout is bad every second.
// Periodic dropouts that skip a second (60/60/0 ms, or 200 ms every 2 s) are
// caught over the last five windows: at least two separate bursts (runs of
// adjacent bad windows with a good window between them) and over 3% underrun
// in total. Sparser glitches are caught once fifteen windows have been judged:
// three or more separate bursts and at least 2% underrun across those fifteen
// (300 ms every 5 s, 1 s every 6 s, 60 ms every 3 s; a full window keeps this
// independent of where the glitches fall). So three or more separate glitches
// within about 15 s stop playback. A single glitch spanning at most two judged
// windows (under about 1 s) never does, however it splits (QA measured a 1 s
// startup burst on a loaded host); a dropout of about 2 s or more always does
// (three bad seconds in a row). Accepted limits: sparse small glitches under 2%
// over 15 s (70 ms every 4 s) never stop, and glitches 8 or more judged windows
// apart never stop. A real 1 s stall plus its recovery uses about two windows,
// so the wall-clock spacing that escapes depends on the host.
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
 * an overload. One glitch spanning at most two windows (under about 1 s) is
 * not, however it splits; one dropout of about 2 s or more always is.
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
