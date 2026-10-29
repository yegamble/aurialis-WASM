import { afterEach, describe, expect, it, vi } from "vitest";
import { clampAdvancedToSampleRate, createDefaultAdvancedParams } from "../audio-dsp";
import { engineParams } from "../browser-engine";
import { advancedFromScript, analyzeDeep, appliedRevisionKey, automationTargets, compileScript, readDeepMasteringState, readScriptV2, type DeepMasteringState, type ScriptV2, type TargetMetadata } from "../deep-mastering";
import { normalizeHydratedState, reduceStoreState } from "../store";
import { testStore } from "./fixtures";

const identity = { pcmHash: "a".repeat(64), sampleRate: 48000, frames: 48000 };
function script(): ScriptV2 {
  return { version: "2.0", source: identity, revision: 1, profile: "Warm Analog", summary: "Measured proposal", chainParams: engineParams(createDefaultAdvancedParams()), sections: [{ id: "section-1", name: "Section 1", roleHint: "unknown", startFrame: 0, endFrame: 48000, confidence: 0 }], moves: [{ id: "gain", sectionId: "section-1", reason: "Measured headroom", target: "inputGainDb", operation: "add", points: [{ frame: 12000, value: -0.5 }, { frame: 36000, value: -0.5 }], fadeFrames: 480, muted: false }], findings: [], beforeMetrics: { integratedLufs: -18, shortTermLufs: -18, truePeakDbtp: -6, samplePeakDbfs: -6, dynamicRangeDb: 12, correlation: 0.5, lowBassCorrelation: 1, dcLeftDbfs: -100, dcRightDbfs: -100, clippingSamples: 0, gainReductionDb: 0 } };
}
const targets: TargetMetadata[] = automationTargets.map((name) => ({ name, minimum: -80, maximum: 200, cellTolerance: 0.1, sampleAccurate: name === "inputGainDb" || name === "stereo.widthPct" }));
const state = (): DeepMasteringState => ({ sourceRevision: 0, proposal: script(), targets });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const queued = { jobId: "deep-job-1", kind: "analyze_deep_v2", status: "queued", progress: 0, stage: "Queued" };
afterEach(() => { vi.unstubAllGlobals(); });

describe("source-bound Deep DTO and jobs", () => {
  it.each([0, 1, 2, 3])("reads authored algorithm %s without enabling the retired UI true-peak switch", (algorithmVersion) => {
    const original = script(), modern = algorithmVersion >= 2;
    const authored = { ...original, chainParams: { ...original.chainParams, algorithmVersion, limiter: { ...original.chainParams.limiter, enabled: true, truePeak: modern } } };
    const parsed = readScriptV2(authored, identity);
    expect(parsed.chainParams.algorithmVersion).toBe(algorithmVersion);
    expect(advancedFromScript(parsed).limiter.truePeak).toBe(false);
    expect(() => engineParams(advancedFromScript(parsed))).not.toThrow();
    if (!modern) expect(() => readScriptV2({ ...authored, chainParams: { ...authored.chainParams, limiter: { ...authored.chainParams.limiter, truePeak: true } } })).toThrow();
  });
  it("keeps exported status for an unapplied draft but invalidates applied and detached audio", () => {
    const original = testStore.tracks[0]; if (!original) throw new Error("Missing source");
    const track = { ...original, status: "mastered" as const, sourceIdentity: identity, sourceRevision: 0, deepMastering: state() };
    const initial = { ...testStore, tracks: [track] };
    const draft = reduceStoreState(initial, { type: "SAVE_DEEP_PROPOSAL", id: track.id, expectedSourceRevision: 0, expectedAudioKey: track.id, expectedProposalRevision: 1, deep: { ...state(), proposal: { ...script(), revision: 2 } } });
    expect(draft.tracks[0]?.status).toBe("mastered");
    const before = { advanced: original.advanced, profile: original.profile, genre: original.genre, tone: original.tone, intensity: original.intensity, target: original.target, simpleCustom: true, shortcutUndo: {} };
    const applied = reduceStoreState(initial, { type: "COMMIT_DEEP_APPLIED", id: track.id, expectedSourceRevision: 0, expectedAudioKey: track.id, expectedAppliedRevision: null, expectedAdvanced: track.advanced, script: script(), advanced: track.advanced, before });
    expect(applied.tracks[0]?.status).toBe("ready");
    const exported = reduceStoreState(applied, { type: "COMPLETE_EXPORT", expected: applied.tracks[0] ?? track });
    expect(exported.tracks[0]?.status).toBe("mastered");
    const detached = reduceStoreState(exported, { type: "DETACH_DEEP_APPLIED", id: track.id, expectedSourceRevision: 0, expectedAudioKey: track.id, expectedAppliedRevision: 1, expectedAdvanced: track.advanced, snapshot: before });
    expect(detached.tracks[0]?.status).toBe("ready");
  });

  it("initializes disabled zero modules only on their first explicit Advanced edit", () => {
    const original = testStore.tracks[0]; if (!original) throw new Error("Missing source");
    const advanced = createDefaultAdvancedParams();
    advanced.deHarsh = { enabled: false, frequencyHz: 0, thresholdDb: 0, rangeDb: 0 };
    advanced.multiband = { enabled: false, lowMidHz: 0, midHighHz: 0, bands: advanced.multiband.bands.map(() => ({ thresholdDb: 0, ratio: 0, attackMs: 0, releaseMs: 0, makeupDb: 0 })) as typeof advanced.multiband.bands };
    const initial = { ...testStore, tracks: [{ ...original, sampleRate: 8000, advanced }] };
    const enabled = reduceStoreState(initial, { type: "UPDATE_MULTIBAND", trackId: original.id, patch: { enabled: true } }).tracks[0];
    const defaults = clampAdvancedToSampleRate(createDefaultAdvancedParams(), 8000);
    expect(enabled?.advanced.multiband).toEqual({ ...defaults.multiband, enabled: true });
    expect(enabled?.advanced.deHarsh).toEqual(advanced.deHarsh);
    const edited = reduceStoreState(initial, { type: "UPDATE_DE_HARSH", trackId: original.id, patch: { rangeDb: 5 } }).tracks[0];
    expect(edited?.advanced.deHarsh).toEqual({ ...defaults.deHarsh, rangeDb: 5 });
    expect(edited?.advanced.multiband).toEqual(advanced.multiband);
    const band = reduceStoreState(initial, { type: "UPDATE_MULTIBAND_BAND", trackId: original.id, index: 1, patch: { thresholdDb: -30 } }).tracks[0];
    expect(band?.advanced.multiband.bands[1]).toEqual({ ...defaults.multiband.bands[1], thresholdDb: -30 });
    expect(initial.tracks[0]?.advanced).toBe(advanced);
  });
  it("reads scripts saved before V1-11 by dropping the retired engine loudness match only when false", () => {
    const authored = script();
    expect(Object.hasOwn(authored.chainParams, "loudnessMatchAb")).toBe(false);
    const legacy = { ...authored, chainParams: { ...authored.chainParams, loudnessMatchAb: false } };
    expect(readScriptV2(legacy, identity)).toEqual(authored);
    expect(() => readScriptV2({ ...authored, chainParams: { ...authored.chainParams, loudnessMatchAb: true } }, identity)).toThrow("script");
  });
  it("retains the explicit baseline and authored additive moves without evaluating them", () => {
    const authored = script(); const decoded = readScriptV2(authored, identity);
    expect(decoded).toEqual(authored); expect(decoded.moves[0]?.operation).toBe("add"); expect(decoded.chainParams.inputGainDb).toBe(0);
    expect(() => readScriptV2(authored, { ...identity, pcmHash: "b".repeat(64) })).toThrow("script");
  });
  it("rejects unknown fields, malformed bounds and unsupported public processing without stripping flags", () => {
    const authored = script();
    for (const value of [undefined, { ...authored, extra: true }, { ...authored, revision: 0 }, { ...authored, profile: "indie_warmth" }, { ...authored, source: { ...identity, frames: 0 } }, { ...authored, sections: [{ ...authored.sections[0], roleHint: "chorus" }] }, { ...authored, moves: [{ ...authored.moves[0], target: "__proto__.gain" }] }, { ...authored, chainParams: { ...authored.chainParams, repair: { ...authored.chainParams.repair, enabled: true } } }, { ...authored, chainParams: { ...authored.chainParams, limiter: { ...authored.chainParams.limiter, enabled: true, truePeak: true } } }]) expect(() => readScriptV2(value)).toThrow("script");
    expect(authored.chainParams.repair.enabled).toBe(false);
  });
  it("keys accepted processing independently of draft size and pending static settings", () => {
    const original = testStore.tracks[0]; if (!original) throw new Error("Missing source");
    const track = { ...original, sourceIdentity: identity, sourceRevision: 0, deepMastering: { ...state(), applied: script() } };
    const key = appliedRevisionKey(track);
    expect(appliedRevisionKey({ ...track, advanced: { ...track.advanced, input: 4 }, deepMastering: { ...track.deepMastering, proposal: { ...script(), revision: 2, summary: "Edited draft" } } })).toBe(key);
    expect(appliedRevisionKey({ ...track, sourceRevision: 1 })).not.toBe(key);
    expect(appliedRevisionKey({ ...track, deepMastering: { ...track.deepMastering, applied: { ...script(), revision: 2 } } })).not.toBe(key);
    expect(appliedRevisionKey(original)).toBeNull();
  });
  it.each([undefined, "classic", "oversampled"] as const)("receives and deletes an admitted ScriptV2 job after cancellation (quality=%s)", async (quality) => {
    let accept: ((response: Response) => void) | undefined;
    const fetch = vi.fn().mockReturnValueOnce(new Promise<Response>((resolve) => { accept = resolve; })).mockResolvedValueOnce(json({})); vi.stubGlobal("fetch", fetch);
    const controller = new AbortController(); const pending = analyzeDeep(new Blob(["canonical"]), "Warm Analog", identity, controller.signal, vi.fn(), quality); controller.abort(); accept?.(json(queued, 202));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" }); expect(fetch.mock.calls[1]?.[0]).toBe("/api/jobs/deep-job-1"); expect(fetch.mock.calls[1]?.[1]).toMatchObject({ method: "DELETE" });
    const body = (fetch.mock.calls[0]?.[1] as { body: FormData }).body; expect(body.get("scriptVersion")).toBe("2.0"); expect(body.get("profile")).toBe("Warm Analog"); expect(body.get("renderQuality")).toBe(quality ?? null);
  });
  it("rejects a completed proposal without its export prediction", async () => {
    for (const prediction of [undefined, {}, { afterMetrics: { integratedLufs: -14 } }, { afterMetrics: script().beforeMetrics }, { afterMetrics: script().beforeMetrics, levelMatch: { gainDb: 1, neededDb: 1, limiterCapped: false }, compressorAverageGainReductionDb: 1.5, limiterPeakGainReductionDb: "0" }]) {
      const fetch = vi.fn().mockResolvedValueOnce(json({ ...queued, status: "done", scriptV2: script(), prediction }, 202)).mockResolvedValueOnce(json({})); vi.stubGlobal("fetch", fetch);
      await expect(analyzeDeep(new Blob(), "Warm Analog", identity, new AbortController().signal, vi.fn())).rejects.toThrow("script");
    }
  });
  it("validates the completed source identity and releases retained successful or rejected jobs", async () => {
    for (const source of [identity, { ...identity, frames: 1 }]) {
      const prediction = { afterMetrics: script().beforeMetrics, levelMatch: { gainDb: 1.2, neededDb: 1.24, limiterCapped: false }, compressorAverageGainReductionDb: 1.5, limiterPeakGainReductionDb: 0 };
      const fetch = vi.fn().mockResolvedValueOnce(json({ ...queued, status: "done", scriptV2: { ...script(), source }, prediction }, 202)).mockResolvedValueOnce(json({})); vi.stubGlobal("fetch", fetch);
      const pending = analyzeDeep(new Blob(), "Warm Analog", identity, new AbortController().signal, vi.fn());
      if (source === identity) expect(await pending).toEqual({ proposal: script(), prediction }); else await expect(pending).rejects.toThrow("script");
      expect(fetch.mock.calls[1]?.[1]).toMatchObject({ method: "DELETE" });
    }
  });
  it("consumes an authoritative absolute numeric packet without altering the authored script", async () => {
    const authored = script(); const packet = { version: "1.0", source: identity, revision: 1, deviceRate: 44100, quantumFrames: 44, baseline: authored.chainParams, moves: [{ target: 0, fadeFrames: 480, muted: false, points: [{ frame: 12000, value: -0.5 }, { frame: 36000, value: -0.5 }] }], targets, sourceVerified: false };
    const fetch = vi.fn().mockResolvedValueOnce(json(packet)); vi.stubGlobal("fetch", fetch);
    expect(await compileScript(authored, 44100)).toEqual(packet); expect(authored.moves[0]?.operation).toBe("add");
    expect(fetch.mock.calls[0]?.[0]).toBe("/api/automation/compile?deviceRate=44100"); expect(JSON.parse((fetch.mock.calls[0]?.[1] as { body: string }).body)).toEqual(authored);
    for (const invalid of [{ ...packet, revision: 2 }, { ...packet, deviceRate: 48000 }, { ...packet, sourceVerified: true }, { ...packet, baseline: { ...packet.baseline, inputGainDb: 2 } }]) { fetch.mockResolvedValueOnce(json(invalid)); await expect(compileScript(authored, 44100)).rejects.toThrow("script"); }
  });
  it("persists only source-bound drafts and preserves legacy settings when saved Deep metadata is corrupt", () => {
    const original = testStore.tracks[0]; if (!original) throw new Error("Missing source");
    const valid = { ...original, sourceIdentity: identity, sourceRevision: 0, mode: "deep" as const, deepMastering: state() };
    expect(normalizeHydratedState({ ...testStore, tracks: [valid] })?.tracks[0]?.deepMastering).toEqual(state());
    expect(normalizeHydratedState({ ...testStore, tracks: [valid] })?.tracks[0]?.mode).toBe("deep");
    const restored = normalizeHydratedState({ ...testStore, tracks: [{ ...valid, deepMastering: { ...state(), sourceRevision: 1 } }] })?.tracks[0];
    expect(restored?.deepMastering).toBeUndefined(); expect(restored?.advanced).toEqual(original.advanced); expect(restored?.persistenceWarning).toContain("metadata was invalid");
  });
  it("rejects stale source, draft and settings writes while draft edits cannot overwrite applied audio", () => {
    const original = testStore.tracks[0]; if (!original) throw new Error("Missing source");
    const before = { advanced: original.advanced, profile: original.profile, genre: original.genre, tone: original.tone, intensity: original.intensity, target: original.target, simpleCustom: true, shortcutUndo: {} };
    const track = { ...original, sourceIdentity: identity, sourceRevision: 0, deepMastering: { ...state(), applied: script(), before } };
    const pending = { ...testStore, tracks: [track] };
    const changed = { ...state(), proposal: { ...script(), revision: 2 }, applied: { ...script(), summary: "Must not install" } };
    const action = { type: "SAVE_DEEP_PROPOSAL" as const, id: track.id, expectedSourceRevision: 0, expectedAudioKey: track.id, expectedProposalRevision: 1, expectedAdvanced: track.advanced, deep: changed };
    const saved = reduceStoreState(pending, action).tracks[0]; expect(saved?.deepMastering?.proposal.revision).toBe(2); expect(saved?.deepMastering?.applied).toBe(track.deepMastering.applied); expect(saved?.advanced).toBe(track.advanced); expect(saved?.deepMastering?.before).toBe(before);
    for (const patch of [{ expectedSourceRevision: 1 }, { expectedAudioKey: "source-stale" }, { expectedProposalRevision: 2 }, { expectedAdvanced: structuredClone(track.advanced) }]) expect(reduceStoreState(pending, { ...action, ...patch }).tracks[0]).toBe(track);
    expect(readDeepMasteringState(track.deepMastering, identity, 0).before).toEqual(before);
  });
});
