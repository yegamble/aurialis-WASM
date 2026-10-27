import { describe, expect, it } from "vitest";
import * as dsp from "../audio-dsp";
import { createDefaultAdvancedParams, mapSimpleToDSP, MAX_LIMITER_CEILING_DB } from "../audio-dsp";
import { engineParams } from "../browser-engine";
import { automationTargets, deepSettingsSnapshot, readDeepMasteringState, type ScriptV2 } from "../deep-mastering";
import { masteringTargets } from "../mastering-targets";
import { proposalChanges } from "../proposal-changes";
import { normalizeHydratedState, reduceStoreState } from "../store";
import { testStore } from "./fixtures";

const identity = { pcmHash: "b".repeat(64), sampleRate: 48000, frames: 48000 };
const metrics = { integratedLufs: -14.2, shortTermLufs: -14, truePeakDbtp: -1.03, samplePeakDbfs: -1.2, dynamicRangeDb: 11.2, correlation: 0.9, lowBassCorrelation: 1, dcLeftDbfs: -100, dcRightDbfs: -100, clippingSamples: 0, gainReductionDb: 0 };
function script(chainParams: ScriptV2["chainParams"] = engineParams(createDefaultAdvancedParams())): ScriptV2 {
  return { version: "2.0", source: identity, revision: 1, profile: "Warm Analog", summary: "Measured", chainParams, sections: [{ id: "s", name: "Section 1", roleHint: "unknown", startFrame: 0, endFrame: 48000, confidence: 0 }], moves: [], findings: [], beforeMetrics: metrics };
}
const targets = automationTargets.map((name) => ({ name, minimum: -80, maximum: 200, cellTolerance: 0.1, sampleAccurate: false }));
function source() { const track = testStore.tracks[0]; if (!track) throw new Error("Missing fixture"); return track; }

describe("V1-09 honest starting points", () => {
  it("never starts any target or Simple preset above −1 dBTP", () => {
    expect(MAX_LIMITER_CEILING_DB).toBe(-1);
    for (const target of masteringTargets) expect(target.ceiling, target.name).toBeLessThanOrEqual(-1);
    expect(masteringTargets.find((target) => target.name === "Loud")).toEqual({ name: "Loud", targetLufs: -9, ceiling: -1 });
    for (const genre of ["Pop", "Hip-hop", "Rock", "Electronic", "Acoustic", "R&B"])
      for (const tone of ["Warm", "Open", "Punchy", "Intimate", "Wide", "Clean"])
        for (const target of ["Streaming", "Loud", "Dynamic", "Podcast"])
          expect(mapSimpleToDSP(genre, tone, 100, target).limiter.ceiling).toBeLessThanOrEqual(-1);
  });

  it("removes the legacy static profile recipes", () => {
    expect("mapProfileToDSP" in dsp).toBe(false);
  });

  it("clamps an edited limiter ceiling to −1 dBTP", () => {
    const changed = reduceStoreState(testStore, { type: "UPDATE_LIMITER", trackId: source().id, patch: { ceiling: -0.3 } });
    expect(changed.tracks[0]?.advanced.limiter.ceiling).toBe(-1);
    const lower = reduceStoreState(testStore, { type: "UPDATE_LIMITER", trackId: source().id, patch: { ceiling: -2.5 } });
    expect(lower.tracks[0]?.advanced.limiter.ceiling).toBe(-2.5);
  });

  it("migrates saved ceilings above −1 dBTP with a visible note, including Deep snapshots", () => {
    const original = source();
    const loud = { ...original.advanced, limiter: { ...original.advanced.limiter, enabled: true, targetLufs: -9, ceiling: -0.2 } };
    const before = { ...deepSettingsSnapshot(original), advanced: { ...original.advanced, limiter: { ...original.advanced.limiter, ceiling: -0.5 } } };
    const applied = script(engineParams(loud));
    const saved = { ...testStore, tracks: [{ ...original, target: "Loud", advanced: loud, sourceIdentity: identity, sourceRevision: 0, deepMastering: { sourceRevision: 0, proposal: script(), targets, applied, before } }, { ...original, id: "kept", advanced: { ...original.advanced, limiter: { ...original.advanced.limiter, ceiling: -1.5 } } }] };
    const restored = normalizeHydratedState(JSON.parse(JSON.stringify(saved)));
    const migrated = restored?.tracks[0];
    expect(migrated?.advanced.limiter).toEqual({ ...loud.limiter, ceiling: -1 });
    expect(migrated?.deepMastering?.applied?.chainParams.limiter.ceilingDbtp).toBe(-1);
    expect(migrated?.deepMastering?.before?.advanced.limiter.ceiling).toBe(-1);
    expect(migrated?.limiterNotice).toBe("This project's saved limiter ceiling of −0.2 dBFS was lowered to −1 dBFS, the highest ceiling Aurialis offers. Set target loudness or export again to re-measure.");
    expect(restored?.tracks[1]?.advanced.limiter.ceiling).toBe(-1.5);
    expect(restored?.tracks[1]?.limiterNotice).toBeUndefined();
    // A migrated project saves at −1 and does not repeat the migration.
    const again = normalizeHydratedState(JSON.parse(JSON.stringify({ ...restored, tracks: restored?.tracks.map((track) => ({ ...track, limiterNotice: "" })) })));
    expect(again?.tracks[0]?.limiterNotice).toBe("");
  });

  it("persists the export prediction beside its draft revision", () => {
    const deep = { sourceRevision: 0, proposal: script(), targets, prediction: { revision: 1, afterMetrics: metrics } };
    expect(readDeepMasteringState(deep, identity, 0)).toEqual(deep);
    expect(() => readDeepMasteringState({ ...deep, prediction: { revision: 1 } }, identity, 0)).toThrow("script");
    expect(() => readDeepMasteringState({ ...deep, prediction: { revision: 1, afterMetrics: { ...metrics, integratedLufs: "loud" } } }, identity, 0)).toThrow("script");
  });

  it("lists every static field a proposal changes with readable labels and values", () => {
    const current = createDefaultAdvancedParams();
    const next = structuredClone(current);
    next.eqBands[0].gainDb = 0.5; next.compressor.threshold = -16; next.compressor.ratio = 1.7; next.compressor.autoRelease = true;
    next.saturationModule.character = "Tube"; next.stereo.monoBass = true; next.limiter.enabled = true; next.limiter.targetLufs = -9;
    next.multiband.bands[2].makeupDb = 1;
    const changes = proposalChanges(current, script(engineParams(next)));
    expect(changes).toEqual([
      { field: "bands.0.gainDb", label: "EQ Sub gain", from: "0 dB", to: "0.5 dB" },
      { field: "compressor.thresholdDb", label: "Compressor threshold", from: "0 dB", to: "−16 dB" },
      { field: "compressor.ratio", label: "Compressor ratio", from: "1:1", to: "1.7:1" },
      { field: "compressor.autoRelease", label: "Compressor auto release", from: "off", to: "on" },
      { field: "saturation.character", label: "Saturation character", from: "Warm", to: "Tube" },
      { field: "stereo.monoBass", label: "Mono bass", from: "off", to: "on" },
      { field: "limiter.enabled", label: "Limiter", from: "off", to: "on" },
      { field: "limiter.targetLufs", label: "Loudness target", from: "−14 LUFS", to: "−9 LUFS" },
      { field: "multiband.bands.2.makeupDb", label: "Multiband high makeup", from: "0 dB", to: "1 dB" },
    ]);
    expect(proposalChanges(next, script(engineParams(next)))).toEqual([]);
    // The export algorithm flag and true-peak selection are not static settings.
    expect(proposalChanges(current, script({ ...engineParams(current), algorithmVersion: 1 }))).toEqual([]);
  });
});
