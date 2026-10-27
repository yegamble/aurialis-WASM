import { afterEach, describe, expect, it, vi } from "vitest";
import { clampAdvancedToSampleRate, createDefaultAdvancedParams } from "../audio-dsp";
import { engineParams } from "../browser-engine";
import { exportParams, exportScript, liveParams, liveScript } from "../engine-params";
import { loudnessMatchRequest, loudnessMatchText, matchGains, readMatchPreference, resolveLoudnessMatch, writeMatchPreference, type LoudnessReading } from "../loudness-match";
import type { ScriptV2 } from "../deep-mastering";
import type { Track } from "../types";
import { testStore } from "./fixtures";

const reading = (processedLufs: number, originalLufs: number, key = "k", scope = "s"): LoudnessReading => ({ key, scope, processedLufs, originalLufs });
const at = (key = "k", scope = "s") => ({ key, scope });
afterEach(() => { vi.unstubAllGlobals(); });

describe("static attenuate-only A/B loudness match (V1-11)", () => {
  // Fixtures with known integrated loudness: a mastered A louder than its
  // source, a quieter conservative A, equal loudness, and a large gap.
  it.each([
    [-9.2, -14.7], [-18.4, -14.1], [-14, -14], [-6.3, -31.8], [-23.05, -23.04],
  ])("matches A %f LUFS and B %f LUFS within ±0.5 LU without boosting either", (processedLufs, originalLufs) => {
    const gains = matchGains(processedLufs, originalLufs);
    expect(gains.processedDb).toBeLessThanOrEqual(0);
    expect(gains.originalDb).toBeLessThanOrEqual(0);
    expect(Math.min(gains.processedDb, gains.originalDb)).toBeCloseTo(-Math.abs(processedLufs - originalLufs), 9);
    expect(Math.max(gains.processedDb, gains.originalDb)).toBe(0);
    expect(Math.abs((processedLufs + gains.processedDb) - (originalLufs + gains.originalDb))).toBeLessThanOrEqual(0.5);
  });

  it("attenuates only the louder side", () => {
    const louderA = resolveLoudnessMatch(true, at(), reading(-9, -14.2));
    expect(louderA).toMatchObject({ state: "matched", attenuated: "A" });
    if (louderA.state !== "matched") throw new Error("unmatched");
    expect(louderA.processedDb).toBeCloseTo(-5.2, 9); expect(louderA.originalDb).toBe(0);
    expect(Object.keys(louderA).sort()).toEqual(["attenuated", "originalDb", "processedDb", "state"]);
    const louderB = resolveLoudnessMatch(true, at(), reading(-18.1, -13.9));
    expect(louderB).toMatchObject({ state: "matched", attenuated: "B", processedDb: 0 });
    if (louderB.state !== "matched") throw new Error("unmatched");
    expect(louderB.originalDb).toBeCloseTo(-4.2, 9);
  });

  it("is one static gain: identical inputs always give the identical offset", () => {
    const first = resolveLoudnessMatch(true, at(), reading(-10, -13));
    for (let index = 0; index < 5; index++) expect(resolveLoudnessMatch(true, at(), reading(-10, -13))).toEqual(first);
  });

  it("is off by default and applies nothing while off", () => {
    expect(resolveLoudnessMatch(false, at(), reading(-9, -14))).toEqual({ state: "off" });
    expect(loudnessMatchText({ state: "off" })).toBe("");
  });

  it("holds the last static offset while re-measuring edited settings, but never carries one to another source", () => {
    const held = resolveLoudnessMatch(true, at("new-settings"), reading(-18.1, -13.9, "old-settings"));
    expect(held).toMatchObject({ state: "measuring", held: { processedDb: 0, attenuated: "B" } });
    if (held.state !== "measuring" || !held.held) throw new Error("no held offset");
    expect(held.held.originalDb).toBeCloseTo(-4.2, 9);
    expect(loudnessMatchText(held)).toBe("Re-measuring (holding B −4.2 dB)");
    expect(loudnessMatchText(resolveLoudnessMatch(true, at("new"), reading(-14.02, -14, "old")))).toBe("Re-measuring (holding 0.0 dB)");
    // Another track or source: nothing to hold, unity while measuring.
    expect(resolveLoudnessMatch(true, at("other-source|k", "other-source"), reading(-9, -14))).toEqual({ state: "measuring", held: null });
    expect(resolveLoudnessMatch(true, at(), null)).toEqual({ state: "measuring", held: null });
    expect(resolveLoudnessMatch(true, at("new"), reading(-70, -14, "old"))).toEqual({ state: "measuring", held: null });
    expect(resolveLoudnessMatch(true, null, reading(-9, -14))).toMatchObject({ state: "unavailable" });
    expect(resolveLoudnessMatch(true, at(), null, { key: "k", message: "Audio measurement failed." })).toEqual({ state: "unavailable", reason: "Audio measurement failed." });
    expect(resolveLoudnessMatch(true, at(), null, { key: "old", message: "Audio measurement failed." })).toEqual({ state: "measuring", held: null });
  });

  it("refuses to match gated silence instead of applying an extreme offset", () => {
    expect(resolveLoudnessMatch(true, at(), reading(-70, -14))).toMatchObject({ state: "unavailable" });
    expect(resolveLoudnessMatch(true, at(), reading(-14, Number.NaN))).toMatchObject({ state: "unavailable" });
  });

  it("announces the applied offset in words with a typographic minus", () => {
    expect(loudnessMatchText(resolveLoudnessMatch(true, at(), reading(-18.1, -13.9)))).toBe("B −4.2 dB to match A");
    expect(loudnessMatchText(resolveLoudnessMatch(true, at(), reading(-9, -14.25)))).toBe("A −5.3 dB to match B");
    expect(loudnessMatchText(resolveLoudnessMatch(true, at(), reading(-14.02, -14)))).toBe("A and B already match");
    expect(loudnessMatchText({ state: "measuring", held: null })).toBe("Measuring A and B loudness…");
    expect(loudnessMatchText({ state: "unavailable", reason: "Restore the source." })).toBe("Match unavailable. Restore the source.");
  });
});

describe("export-path measurement request", () => {
  const track = (patch: Partial<Track> = {}): Track => {
    const base = testStore.tracks[0]; if (!base) throw new Error("Missing fixture");
    return { ...base, ...patch };
  };
  it("measures exactly what live playback plays, the export algorithm since V1-10, keyed by source and settings", () => {
    const request = loudnessMatchRequest(track());
    expect(request.render).toEqual({ params: liveParams(clampAdvancedToSampleRate(track().advanced, track().sampleRate)) });
    expect(request.render).toEqual({ params: exportParams(clampAdvancedToSampleRate(track().advanced, track().sampleRate)) });
    expect("params" in request.render && Reflect.get(request.render.params, "algorithmVersion")).toBe(2);
    const louder = createDefaultAdvancedParams(); louder.input = 4;
    expect(loudnessMatchRequest(track({ advanced: louder })).key).not.toBe(request.key);
    // Same track and source: a held offset may bridge the re-measurement.
    expect(loudnessMatchRequest(track({ advanced: louder })).scope).toBe(request.scope);
    expect(loudnessMatchRequest(track({ sourceRevision: 7 })).scope).not.toBe(request.scope);
    expect(loudnessMatchRequest(track()).key).toBe(request.key);
  });
  it("measures the applied Deep revision as live playback plays it, through the export transform", () => {
    const base = track();
    const applied: ScriptV2 = { version: "2.0", source: { pcmHash: "a".repeat(64), sampleRate: 48000, frames: 48000 }, revision: 3, profile: "Warm Analog", summary: "s", chainParams: engineParams(createDefaultAdvancedParams()), sections: [], moves: [], findings: [], beforeMetrics: { integratedLufs: -18, shortTermLufs: -18, truePeakDbtp: -6, samplePeakDbfs: -6, dynamicRangeDb: 12, correlation: 0.5, lowBassCorrelation: 1, dcLeftDbfs: -100, dcRightDbfs: -100, clippingSamples: 0, gainReductionDb: 0 } };
    const deep = { sourceRevision: 0, proposal: applied, targets: [], applied };
    const request = loudnessMatchRequest(track({ deepMastering: deep }));
    expect(request.render).toEqual({ script: exportScript(applied) });
    expect(request.render).toEqual({ script: liveScript(applied) });
    expect(request.key).not.toBe(loudnessMatchRequest(base).key);
    expect(loudnessMatchRequest(track({ deepMastering: { ...deep, applied: { ...applied, revision: 4 } } })).key).not.toBe(request.key);
  });
});

describe("per-browser preference", () => {
  it("persists the opt-in in localStorage and defaults to off", () => {
    const storage = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value); } });
    expect(readMatchPreference()).toBe(false);
    writeMatchPreference(true); expect(readMatchPreference()).toBe(true);
    writeMatchPreference(false); expect(readMatchPreference()).toBe(false);
  });
  it("treats unavailable storage as off without throwing", () => {
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } });
    expect(readMatchPreference()).toBe(false);
    expect(() => { writeMatchPreference(true); }).not.toThrow();
  });
});
