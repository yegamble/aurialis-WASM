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
const WINDOW_SECONDS = 0.9, STRIKES = 3;

/**
 * Judge sustained device underruns from successive playbackStats samples
 * (about one per second). The first window after (re)start is a warm-up:
 * Chromium records 12–19 underrun events while the stream starts. Three bad
 * windows in a row are an overload; one host stall, even across a second
 * boundary, is not.
 */
export function createUnderrunWatch() {
  let previous: PlaybackStatsLike | null = null, windows = 0, strikes = 0;
  return {
    reset(): void { previous = null; windows = 0; strikes = 0; },
    /** True once the overload is confirmed. */
    sample(stats: PlaybackStatsLike): boolean {
      if (!previous || stats.totalDuration < previous.totalDuration) { previous = { ...stats }; return false; }
      const seconds = stats.totalDuration - previous.totalDuration;
      if (seconds < WINDOW_SECONDS) return false;
      const underrun = stats.underrunDuration - previous.underrunDuration;
      previous = { ...stats };
      strikes = ++windows > 1 && underrun > UNDERRUN_SHARE * seconds ? strikes + 1 : 0;
      return strikes >= STRIKES;
    },
  };
}
