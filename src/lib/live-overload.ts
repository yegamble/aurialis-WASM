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
// caught by the sum over the last three windows, over 3% of them (90 ms in 3 s),
// but only when at least two of those windows are bad: one isolated stall, even
// 300 ms long, falls in a single window and never fires. Known limit: a single
// stall over about 90 ms that splits across a boundary with both halves over
// 10 ms makes two bad windows and does fire.
const WINDOW_SECONDS = 0.9, STRIKES = 3, RECENT = 3, RECENT_SHARE = 0.03, RECENT_BAD = 2;

/**
 * Judge sustained device underruns from successive playbackStats samples
 * (about one per second). The first window after (re)start is a warm-up:
 * Chromium records 12–19 underrun events while the stream starts. Three bad
 * windows in a row, or more than 3% underrun summed over the last three windows
 * when at least two of them are bad, are an overload. One isolated host stall is
 * not, nor one that splits across a boundary into one bad and one clean window.
 */
export function createUnderrunWatch() {
  let previous: PlaybackStatsLike | null = null, windows = 0, strikes = 0;
  let recent: { underrun: number; seconds: number; bad: boolean }[] = [];
  function reset(): void { previous = null; windows = 0; strikes = 0; recent = []; }
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
      recent = [...recent, { underrun, seconds, bad }].slice(-RECENT);
      const sum = recent.reduce((total, window) => ({ underrun: total.underrun + window.underrun, seconds: total.seconds + window.seconds }), { underrun: 0, seconds: 0 });
      const periodic = recent.length === RECENT && recent.filter((window) => window.bad).length >= RECENT_BAD && sum.underrun > RECENT_SHARE * sum.seconds;
      return strikes >= STRIKES || periodic;
    },
  };
}
