import { describe, expect, it } from "vitest";
import { clampAdvancedToSampleRate, mapSimpleToDSP } from "../audio-dsp";
import { normalizeHydratedState, reduceStoreState } from "../store";
import { testStore } from "./fixtures";

function source() { const track = testStore.tracks[0]; if (!track) throw new Error("Missing fixture"); return track; }
function selected() { return reduceStoreState(testStore, { type: "UPDATE_SIMPLE", id: source().id, patch: { genre: "Rock", tone: "Punchy", intensity: 72 } }); }
function trackOf(state: Parameters<typeof reduceStoreState>[0]) { const track = state.tracks[0]; if (!track) throw new Error("Missing track"); return track; }

describe("one canonical mastering snapshot", () => {
  it("writes explicit Simple directions to the persisted DSP snapshot, bounded by source rate", () => {
    const initial = { ...testStore, tracks: [{ ...source(), sampleRate: 8000 }] };
    const changed = reduceStoreState(initial, { type: "UPDATE_SIMPLE", id: source().id, patch: { genre: "Rock", tone: "Punchy", intensity: 72 } });
    expect(trackOf(changed).advanced).toEqual(clampAdvancedToSampleRate(mapSimpleToDSP("Rock", "Punchy", 72, "Streaming"), 8000));
    expect(trackOf(changed).simpleCustom).toBe(false);
  });

  it("preserves other bands, modules and retained gain when changing a filter type or bypass", () => {
    const initial = selected();
    const before = trackOf(initial);
    const typed = reduceStoreState(initial, { type: "UPDATE_EQ_BAND", trackId: before.id, bandId: "mid", patch: { type: "highpass" } });
    const bypassed = reduceStoreState(typed, { type: "UPDATE_EQ_BAND", trackId: before.id, bandId: "mid", patch: { enabled: false } });
    expect(trackOf(bypassed).advanced).toEqual({ ...before.advanced, eqBands: before.advanced.eqBands.map((band) => band.id === "mid" ? { ...band, type: "highpass", enabled: false } : band) });
    expect(trackOf(bypassed).simpleCustom).toBe(true);
    const restored = normalizeHydratedState(bypassed);
    expect(restored?.tracks[0]?.advanced).toEqual(trackOf(bypassed).advanced);
    const viewed = reduceStoreState(bypassed, { type: "UPDATE_TRACK", id: before.id, patch: { mode: "simple" } });
    expect(trackOf(viewed).advanced).toBe(trackOf(bypassed).advanced);
  });

  it("changes only the view when switching modes in either direction", () => {
    let state = selected(); const snapshot = trackOf(state).advanced;
    for (const mode of ["simple", "advanced", "simple", "advanced"] as const) {
      state = reduceStoreState(state, { type: "UPDATE_TRACK", id: source().id, patch: { mode } });
      expect(trackOf(state).advanced).toBe(snapshot); expect(trackOf(state).simpleCustom).toBe(false);
    }
  });

  it("marks every manual Advanced edit Custom without changing the last chosen direction metadata", () => {
    const state = selected(); const trackId = source().id;
    const actions: Parameters<typeof reduceStoreState>[1][] = [
      { type: "UPDATE_INPUT_GAIN", trackId, input: 6 }, { type: "TOGGLE_EQ_ENABLED", trackId, enabled: false },
      { type: "UPDATE_EQ_BAND", trackId, bandId: "mid", patch: { gainDb: 5 } }, { type: "UPDATE_COMPRESSOR", trackId, patch: { attack: 47 } },
      { type: "UPDATE_SATURATION", trackId, patch: { drive: 30 } }, { type: "UPDATE_STEREO", trackId, patch: { width: 130 } },
      { type: "UPDATE_LIMITER", trackId, patch: { ceiling: -2 } }, { type: "UPDATE_REPAIR", trackId, patch: { enabled: false } },
      { type: "RESET_ADVANCED", trackId }, { type: "UPDATE_TRACK", id: trackId, patch: { advanced: source().advanced } },
    ];
    for (const action of actions) {
      const track = trackOf(reduceStoreState(state, action));
      expect(track.simpleCustom).toBe(true); expect(track.genre).toBe("Rock"); expect(track.tone).toBe("Punchy");
    }
  });

  it("changes a custom output target without erasing EQ, input, modules or limiter enable state", () => {
    const initial = reduceStoreState(testStore, { type: "UPDATE_INPUT_GAIN", trackId: source().id, input: 6 });
    const before = trackOf(initial);
    const changed = trackOf(reduceStoreState(initial, { type: "UPDATE_SIMPLE", id: before.id, patch: { target: "Loud" } }));
    expect(changed.advanced).toEqual({ ...before.advanced, limiter: { ...before.advanced.limiter, targetLufs: -9, ceiling: -0.2 } });
    expect(changed.simpleCustom).toBe(true);
  });

  it("keeps the canonical target after reset or a custom profile when selecting a direction", () => {
    const loud = reduceStoreState(testStore, { type: "UPDATE_SIMPLE", id: source().id, patch: { target: "Loud" } });
    const reset = reduceStoreState(loud, { type: "RESET_ADVANCED", trackId: source().id });
    const rock = trackOf(reduceStoreState(reset, { type: "UPDATE_SIMPLE", id: source().id, patch: { genre: "Rock" } }));
    expect(rock.target).toBe("Loud"); expect(rock.advanced.limiter.targetLufs).toBe(-14); expect(rock.advanced.limiter.ceiling).toBe(-1);
    let custom = reduceStoreState(reset, { type: "UPDATE_LIMITER", trackId: source().id, patch: { targetLufs: -12, ceiling: -0.7 } });
    for (const patch of [{ tone: "Warm" }, { intensity: 80 }]) {
      custom = reduceStoreState(custom, { type: "UPDATE_SIMPLE", id: source().id, patch });
      expect(trackOf(custom).advanced.limiter.targetLufs).toBe(-12); expect(trackOf(custom).advanced.limiter.ceiling).toBe(-0.7);
    }
  });

  it("applies only measured input gain to the expected snapshot, preserving association across mode changes", () => {
    const initial = selected(); const expected = trackOf(initial).advanced;
    const modeChanged = reduceStoreState(initial, { type: "UPDATE_TRACK", id: source().id, patch: { mode: "simple" } });
    const measured = trackOf(reduceStoreState(modeChanged, { type: "APPLY_NORMALIZED_GAIN", id: source().id, expected, input: 4 }));
    expect(measured.advanced).toEqual({ ...expected, input: 4 }); expect(measured.simpleCustom).toBe(false);
    const edited = reduceStoreState(initial, { type: "UPDATE_EQ_BAND", trackId: source().id, bandId: "mid", patch: { gainDb: 5 } });
    expect(trackOf(reduceStoreState(edited, { type: "APPLY_NORMALIZED_GAIN", id: source().id, expected, input: 4 }))).toBe(trackOf(edited));
  });

  it("ignores corrupt optional source metadata without losing legacy mastering settings", () => {
    const original = source();
    const corrupted = { ...testStore, tracks: [{ ...original, sourceAudioId: 42, retiredSourceAudioIds: {}, sourceRevision: "bad", sourceIdentity: { pcmHash: "wrong", sampleRate: 1, frames: -1 } }] };
    const restored = normalizeHydratedState(corrupted)?.tracks[0];
    expect(restored?.advanced).toEqual(original.advanced); expect(restored?.sourceAudioId).toBeUndefined(); expect(restored?.retiredSourceAudioIds).toBeUndefined(); expect(restored?.sourceRevision).toBeUndefined(); expect(restored?.sourceIdentity).toBeUndefined(); expect(restored?.persistenceWarning).toContain("metadata was invalid");
  });

  it("restores legacy settings as Custom and retains only explicitly saved preset association", () => {
    expect(normalizeHydratedState(testStore)?.tracks[0]?.simpleCustom).toBe(true);
    expect(normalizeHydratedState(selected())?.tracks[0]?.simpleCustom).toBe(false);
    expect(trackOf(reduceStoreState({ ...testStore, tracks: [] }, { type: "ADD_TRACK", track: source() })).simpleCustom).toBe(true);
  });
});
