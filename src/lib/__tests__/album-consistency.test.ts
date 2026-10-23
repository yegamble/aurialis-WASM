import { describe, expect, it } from "vitest";
import { planAlbumGain, summarizeAlbum, type AlbumReading } from "../album-consistency";

function reading(id: string, lufs = -20, peak = -6, tone = [-20, -20, -20, -20, -20]): AlbumReading {
  const edges = [20, 120, 500, 2000, 6000, 20000];
  return { id, title: id, duration: 10,
    metrics: { integratedLufs: lufs, shortTermLufs: lufs, truePeakDbtp: peak, samplePeakDbfs: peak, dynamicRangeDb: 8,
      correlation: 1, lowBassCorrelation: 1, dcLeftDbfs: -120, dcRightDbfs: -120, clippingSamples: 0, gainReductionDb: 0 },
    bands: tone.map((powerDb, index) => ({ lowHz: edges.at(index) ?? 0, highHz: edges.at(index + 1) ?? 0,
      usableHighHz: edges.at(index + 1) ?? 0, powerDb, valid: true })) };
}
describe("album post-chain gain and measured consistency", () => {
  it("keeps relative levels by applying one gain, including every manual offset in the peak cap", () => {
    const tracks = [reading("quiet", -24, -10), reading("loud", -16, -4)];
    const plan = planAlbumGain(tracks, -14, "relationships", [0, 2]);
    expect(plan.medianTrackLufs).toBe(-20); expect(plan.commonGainDb).toBeCloseTo(0.99, 10);
    expect(plan.tracks.map((item) => item.gainDb)).toEqual([plan.commonGainDb, (plan.commonGainDb ?? 0) + 2]);
    for (const item of plan.tracks) expect(item.requestedLufs).toBeNull();
    expect(tracks[0]?.metrics.integratedLufs).toBe(-24);
  });
  it("preserves manual gain when individual loudness normalization is unavailable", () => {
    const tracks = [reading("a", -20, -12), reading("b", -24, -2), reading("silent", -70, -120), { ...reading("short"), duration: 0.1 }];
    const plan = planAlbumGain(tracks, -14, "normalize", [1, 0, 6, 6]);
    expect(plan.tracks[0]?.gainDb).toBe(7); expect(plan.tracks[1]?.gainDb).toBeCloseTo(0.99, 10);
    expect(plan.tracks[1]?.limitedBy).toBe("peak");
    expect(plan.tracks.slice(2).map((item) => item.gainDb)).toEqual([6, 4.99]);
    expect(plan.tracks[2]?.requestedLufs).toBeNull();
  });
  it("allows explicit manual-only gain for an all-silent sequence without inventing a loudness median", () => {
    const plan = planAlbumGain([reading("silent", -70, -120)], -14, "manual", [3]);
    expect(plan.medianTrackLufs).toBeNull(); expect(plan.commonGainDb).toBeNull();
    expect(plan.tracks[0]).toMatchObject({ gainDb: 3, requestedLufs: null, measurable: false, limitedBy: null });
    expect(() => planAlbumGain([reading("silent", -70)], -14, "normalize", [0])).toThrow(/manual/u);
  });
  it("distinguishes the bounded gain range from a peak-headroom constraint", () => {
    const tracks = [reading("quiet", -68, -58)];
    expect(planAlbumGain(tracks, -9, "normalize", [0]).tracks[0]).toMatchObject({ gainDb: 36, limitedBy: "gain-range" });
    expect(planAlbumGain(tracks, -9, "relationships", [0]).tracks[0]).toMatchObject({ gainDb: 36, limitedBy: "gain-range" });
    expect(planAlbumGain([reading("normal")], -23, "normalize", [0]).tracks[0]).toMatchObject({ gainDb: -3, limitedBy: null });
  });
  it("declines invalid, all-unmeasurable or unsupported gain jobs", () => {
    expect(() => planAlbumGain([reading("silent", -70)], -14, "relationships", [0])).toThrow(/No measurable/u);
    expect(() => planAlbumGain([reading("a")], -15, "normalize", [0])).toThrow(/supported/u);
    expect(() => planAlbumGain([reading("a")], -14, "normalize", [6.01])).toThrow(/supported/u);
    expect(() => planAlbumGain([reading("a", -20, 40)], -14, "normalize", [0])).toThrow(/attenuation/u);
    expect(() => planAlbumGain([reading("a"), reading("a")], -14, "normalize", [0, 0])).toThrow(/different/u);
    expect(() => planAlbumGain([reading("a", NaN)], -14, "normalize", [0])).toThrow(/invalid/u);
  });
  it("compares relative band balance independently of gain and names deliberate loudness outliers", () => {
    const a = reading("a"), b = reading("b", -12, -2, [-12, -12, -12, -12, -12]);
    const summary = summarizeAlbum([a, { ...a, id: "c" }, b]);
    expect(summary.medianTrackLufs).toBe(-20); expect(summary.loudnessSpreadLu).toBe(8);
    expect(summary.tracks[2]?.tonalDeviationDb).toBeCloseTo(0, 10);
    expect(summary.tracks[2]?.findings.join(" ")).toMatch(/intentional/u);
  });
  it("uses only complete physical bands shared by all audible sources", () => {
    const tracks = [reading("a"), reading("b"), reading("c", -20, -6, [-10, -30, -20, -20, -20])];
    const lowRate = tracks[1]; if (!lowRate) throw new Error("Missing fixture");
    const partial = lowRate.bands[3], absent = lowRate.bands[4];
    if (!partial || !absent) throw new Error("Missing band");
    partial.usableHighHz = 4000; absent.usableHighHz = 6000; absent.valid = false;
    const summary = summarizeAlbum(tracks);
    expect(summary.commonBands).toHaveLength(3); expect(summary.tracks[2]?.tonalDeviationDb).toBeGreaterThan(3);
    absent.powerDb = 200; expect(summarizeAlbum(tracks).tracks[2]?.tonalDeviationDb).toBe(summary.tracks[2]?.tonalDeviationDb);
  });
  it("reports unavailable tone/silent measurements instead of manufacturing zero deviations", () => {
    const a = reading("a", -20, -6, [-20, -120, -120, -120, -120]);
    expect(summarizeAlbum([a]).tracks[0]?.tonalDeviationDb).toBeNull();
    expect(summarizeAlbum([reading("silent", -70)]).medianTrackLufs).toBeNull();
    a.bands[0] = { lowHz: 19, highHz: 120, usableHighHz: 120, powerDb: -20, valid: true };
    expect(() => summarizeAlbum([a])).toThrow(/coverage/u);
  });
});
