import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createUnderrunWatch, OVERLOAD_MESSAGE, readPlaybackStats } from "../live-overload";

/** Feed one-second playbackStats samples with `underrunMs` of underrun in each. */
function run(underrunMs: number[], startupEvents = 15) {
  const watch = createUnderrunWatch();
  let total = 0, underrun = startupEvents * 0.002, events = startupEvents;
  const fired: number[] = [];
  expect(watch.sample({ totalDuration: total, underrunDuration: underrun, underrunEvents: events })).toBe(false);
  underrunMs.forEach((ms, second) => {
    total += 1; underrun += ms / 1000; events += ms > 0 ? 1 : 0;
    if (watch.sample({ totalDuration: total, underrunDuration: underrun, underrunEvents: events })) fired.push(second + 1);
  });
  return fired;
}

describe("playbackStats underrun watch (V1-10 Round 4)", () => {
  it("fires after three consecutive seconds over 1% underrun, after a warm-up second", () => {
    expect(run([60, 60, 60, 60, 60])).toEqual([4, 5]);
    // 4 ms every quantum: the device misses most of each second.
    expect(run([500, 500, 500, 500])[0]).toBe(4);
  });
  it("fires on periodic dropouts that skip a second, by the 3-window sum (Round 6 S-2)", () => {
    // 60/60/0 ms repeating: never three bad seconds in a row, but 4% of 3 s.
    expect(run([60, 60, 0, 60, 60, 0, 60, 60, 0]).length).toBeGreaterThan(0);
    // 200 ms every 2 s: 6.7–13% of any 3 s.
    expect(run([200, 0, 200, 0, 200, 0]).length).toBeGreaterThan(0);
    expect(run([0, 200, 0, 200, 0, 200])[0]).toBeLessThanOrEqual(4);
  });
  it("tolerates one glitch however long or split (Round 7 revised R-1)", () => {
    for (const ms of [85, 91, 100, 120, 150, 250, 300]) expect(run([0, 0, ms, 0, 0, 0, 0, 0]), `${String(ms)} ms`).toEqual([]);
    expect(run([0, 0, 41, 12, 0, 0, 0, 0]), "41/12 straddle").toEqual([]);
    expect(run([0, 0, 60, 40, 0, 0, 0, 0]), "60+40 straddle").toEqual([]);
    expect(run([0, 120, 0, 0, 0, 0, 0]), "120 ms in the first judged window").toEqual([]);
    expect(run([0, 0, 500, 503, 0, 0, 0, 0]), "one ~1 s burst across two windows").toEqual([]);
  });
  it("stops on repeated glitches within the 8 s bound: 60/60/0 and 200 ms every 2 s", () => {
    // Index 0 is the warm-up window; a stop at judged window n is n + 2 s after Play.
    expect(run([0, 60, 60, 0, 60, 60, 0])[0]).toBeLessThanOrEqual(5);
    expect(run([0, 200, 0, 200, 0, 200])[0]).toBeLessThanOrEqual(5);
    expect(run([0, 0, 200, 0, 200, 0])[0]).toBeLessThanOrEqual(5);
    // The trade-off: two separate 80 ms dropouts within five seconds also stop.
    expect(run([0, 0, 80, 0, 0, 80, 0]).length).toBeGreaterThan(0);
  });
  it("restarts with a warm-up when the context's duration runs backwards", () => {
    const watch = createUnderrunWatch();
    const sample = (total: number, under: number) => watch.sample({ totalDuration: total, underrunDuration: under, underrunEvents: 0 });
    sample(10, 0); sample(11, 0); sample(12, 0.1); sample(13, 0.2);
    expect(sample(0, 0)).toBe(false); // baseline of the new stream
    expect(sample(1, 0.3)).toBe(false); // warm-up window, not judged
    expect(sample(2, 0.6)).toBe(false); expect(sample(3, 0.9)).toBe(false);
    expect(sample(4, 1.2)).toBe(true);
  });
  it("ignores one host stall that straddles a second boundary (measured 41 ms then 12 ms)", () => {
    expect(run([0, 0, 41, 12, 0, 0, 41, 12, 0])).toEqual([]);
  });
  it("ignores startup underruns, a clean device and one isolated dropout", () => {
    expect(run([200, 0, 0, 0, 0, 0])).toEqual([]);
    expect(run(Array.from({ length: 30 }, () => 0))).toEqual([]);
    expect(run([0, 0, 80, 0, 0, 0, 0])).toEqual([]);
    expect(run([0, 9, 9, 9, 9])).toEqual([]);
  });
  it("restarts after reset and when the context's duration restarts", () => {
    const watch = createUnderrunWatch();
    const sample = (total: number, under: number) => watch.sample({ totalDuration: total, underrunDuration: under, underrunEvents: 0 });
    sample(0, 0); sample(1, 0); sample(2, 0.1);
    watch.reset();
    expect(sample(2, 0.1)).toBe(false); expect(sample(3, 0.2)).toBe(false); expect(sample(4, 0.3)).toBe(false);
    expect(sample(0, 0)).toBe(false);
  });
  it("reads Chromium's playbackStats and nothing else", () => {
    expect(readPlaybackStats({ playbackStats: { underrunDuration: 0.1, underrunEvents: 3, totalDuration: 5 } } as unknown as BaseAudioContext))
      .toEqual({ underrunDuration: 0.1, underrunEvents: 3, totalDuration: 5 });
    expect(readPlaybackStats({} as BaseAudioContext)).toBeNull();
    expect(readPlaybackStats({ playbackStats: { underrunDuration: "0" } } as unknown as BaseAudioContext)).toBeNull();
  });
  it("posts the same overload text from the worklet", () => {
    expect(readFileSync("public/worklets/aurialis-live-worklet.js", "utf8")).toContain(`const OVERLOAD_MESSAGE = ${JSON.stringify(OVERLOAD_MESSAGE)};`);
  });
});
