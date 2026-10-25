import { describe, expect, it } from "vitest";
import { createDefaultAdvancedParams } from "../audio-dsp";
import { applyMasteringShortcut, isMasteringShortcutActive } from "../mastering-shortcuts";
import { normalizeHydratedState, reduceStoreState } from "../store";
import { engineParams } from "../engine-params";
import type { ShortcutUndo } from "../types";
import { testStore } from "./fixtures";

const track = testStore.tracks[0];
if (!track) throw new Error("Missing fixture");
const trackId = track.id;

function first(state: Parameters<typeof reduceStoreState>[0]) {
  const value = state.tracks[0];
  if (!value) throw new Error("Missing track");
  return value;
}

describe("expanded Advanced settings", () => {
  it("persists the chosen compressor type and sends it to the engine", () => {
    const changed = reduceStoreState(testStore, { type: "UPDATE_COMPRESSOR", trackId, patch: { topology: "fet" } });
    expect(engineParams(first(changed).advanced).compressor.topology).toBe("fet");
    expect(normalizeHydratedState(changed)?.tracks[0]?.advanced.compressor.topology).toBe("fet");
    const corrupt = JSON.parse(JSON.stringify(changed)) as typeof testStore;
    Reflect.set(first(corrupt).advanced.compressor, "topology", "tube");
    expect(normalizeHydratedState(corrupt)?.tracks[0]?.advanced.compressor.topology).toBe("optical");
  });

  it("keeps the current compressor type when undoing Glue Comp saved before types existed", () => {
    const vca = reduceStoreState(testStore, { type: "UPDATE_COMPRESSOR", trackId, patch: { topology: "vca" } });
    const glued = { ...first(vca), advanced: applyMasteringShortcut(first(vca).advanced, "glue", track.sampleRate) };
    const legacyUndo: NonNullable<ShortcutUndo["glue"]> = { ...first(vca).advanced.compressor };
    delete legacyUndo.topology;
    const state = { ...vca, tracks: [{ ...glued, shortcutUndo: { glue: legacyUndo } }] };
    const undone = reduceStoreState(state, { type: "TOGGLE_MASTERING_SHORTCUT", trackId, shortcut: "glue" });
    expect(first(undone).advanced.compressor.topology).toBe("vca");
  });

  it("restores legacy sessions with neutral additions and keeps their existing audio settings", () => {
    const legacy = JSON.parse(JSON.stringify(testStore)) as typeof testStore;
    const original = first(legacy).advanced;
    const before = structuredClone(original);
    for (const key of ["deHarsh", "multiband"]) Reflect.deleteProperty(original, key);
    for (const key of ["sidechainHpfHz", "autoRelease", "topology"]) Reflect.deleteProperty(original.compressor, key);
    for (const key of ["crossoverHz", "midGainDb", "sideGainDb"]) Reflect.deleteProperty(original.stereo, key);
    const restored = normalizeHydratedState(legacy);
    expect(restored?.tracks[0]?.advanced).toEqual(before);
  });

  it("persists independent new module edits without changing other bands or the loudness target", () => {
    const selected = reduceStoreState(testStore, { type: "UPDATE_SIMPLE", id: trackId, patch: { tone: "Warm" } });
    const before = first(selected).advanced;
    const changed = reduceStoreState(selected, { type: "UPDATE_MULTIBAND_BAND", trackId, index: 1, patch: { ratio: 3, thresholdDb: -30 } });
    const advanced = first(changed).advanced;
    expect(advanced.multiband.bands[0]).toEqual(before.multiband.bands[0]);
    expect(advanced.multiband.bands[2]).toEqual(before.multiband.bands[2]);
    expect(advanced.multiband.bands[1]).toEqual({ ...before.multiband.bands[1], ratio: 3, thresholdDb: -30 });
    expect(advanced.limiter).toEqual(before.limiter);
    expect(first(changed).simpleCustom).toBe(true);
    expect(normalizeHydratedState(changed)?.tracks[0]?.advanced).toEqual(advanced);
  });

  it("clears Simple association for dynamics toggles and retains edits across mode changes", () => {
    const actions: Parameters<typeof reduceStoreState>[1][] = [
      { type: "UPDATE_DE_HARSH", trackId, patch: { enabled: true, rangeDb: 6 } },
      { type: "UPDATE_MULTIBAND", trackId, patch: { enabled: true, lowMidHz: 350 } },
      { type: "UPDATE_COMPRESSOR", trackId, patch: { autoRelease: true, sidechainHpfHz: 140 } },
      { type: "UPDATE_STEREO", trackId, patch: { midGainDb: -2, sideGainDb: 1, crossoverHz: 200 } },
    ];
    for (const action of actions) {
      const selected = reduceStoreState(testStore, { type: "UPDATE_SIMPLE", id: trackId, patch: { tone: "Warm" } });
      const changed = reduceStoreState(selected, action);
      expect(first(changed).simpleCustom).toBe(true);
      const viewChanged = reduceStoreState(changed, { type: "UPDATE_TRACK", id: trackId, patch: { mode: "simple" } });
      expect(first(viewChanged).advanced).toBe(first(changed).advanced);
    }
  });

  it("defaults missing multiband bands in partial saved settings", () => {
    const raw = { ...testStore, tracks: [{ ...track, advanced: { ...track.advanced, multiband: { enabled: true } } }] };
    expect(normalizeHydratedState(raw)?.tracks[0]?.advanced.multiband).toEqual({ ...createDefaultAdvancedParams().multiband, enabled: true });
  });

  it("migrates partial multiband records without sharing mutable bands", () => {
    const raw = { ...testStore, tracks: [{ ...track, advanced: { ...track.advanced, multiband: { enabled: true, bands: [{ ratio: 3 }] } } }] };
    const restored = normalizeHydratedState(raw)?.tracks[0]?.advanced.multiband;
    const defaults = createDefaultAdvancedParams().multiband;
    expect(restored).toEqual({ ...defaults, enabled: true, bands: [{ ...defaults.bands[0], ratio: 3 }, defaults.bands[1], defaults.bands[2]] });
    expect(restored?.bands[1]).not.toBe(restored?.bands[2]);
  });
});

describe("transparent mastering shortcuts", () => {
  it.each(["air", "mud", "tape", "glue"] as const)("%s is idempotent and keeps input, stereo and output target", (shortcut) => {
    const before = { ...createDefaultAdvancedParams(), input: 2 };
    const once = applyMasteringShortcut(before, shortcut, 48000);
    expect(applyMasteringShortcut(once, shortcut, 48000)).toEqual(once);
    expect(once.input).toBe(2);
    expect(once.stereo).toEqual(before.stereo);
    expect(once.limiter).toEqual(before.limiter);
    expect(before.eqBands.every((band) => band.gainDb === 0)).toBe(true);
  });

  it("cuts mud with a broad bell rather than silently cutting all bass", () => {
    const changed = applyMasteringShortcut(createDefaultAdvancedParams(), "mud", 48000);
    expect(changed.eqBands[1]).toMatchObject({ type: "peaking", freqHz: 250, gainDb: -1.5, q: 0.8, enabled: true });
    expect(changed.eqBands[0].gainDb).toBe(0);
  });

  it("limits air frequency on low-rate audio and exposes glue through canonical compressor values", () => {
    expect(applyMasteringShortcut(createDefaultAdvancedParams(), "air", 8000).eqBands[4].freqHz).toBeLessThan(4000);
    expect(applyMasteringShortcut(createDefaultAdvancedParams(), "glue", 48000).compressor).toMatchObject({ enabled: true, threshold: -18, ratio: 2, attack: 30, autoRelease: true, sidechainHpfHz: 90, knee: 6, makeup: 0 });
  });
});


describe("shortcut selection reflects processing", () => {
  it.each([8000, 48000, 192000])("keeps all four independent shortcuts selected at %i Hz", (sampleRate) => {
    const shortcuts = ["air", "mud", "tape", "glue"] as const;
    let advanced = createDefaultAdvancedParams();
    for (const shortcut of shortcuts) {
      expect(isMasteringShortcutActive(advanced, shortcut, sampleRate)).toBe(false);
      advanced = applyMasteringShortcut(advanced, shortcut, sampleRate);
      expect(isMasteringShortcutActive(advanced, shortcut, sampleRate)).toBe(true);
    }
    for (const shortcut of shortcuts) expect(isMasteringShortcutActive(advanced, shortcut, sampleRate)).toBe(true);
    advanced.input = 3;
    for (const shortcut of shortcuts) expect(isMasteringShortcutActive(advanced, shortcut, sampleRate)).toBe(true);
    advanced.eqBands[4].gainDb = 0;
    expect(isMasteringShortcutActive(advanced, "air", sampleRate)).toBe(false);
    expect(isMasteringShortcutActive(advanced, "mud", sampleRate)).toBe(true);
    advanced.eqEnabled = false;
    expect(isMasteringShortcutActive(advanced, "mud", sampleRate)).toBe(false);
    advanced.saturationModule.drive = 11;
    expect(isMasteringShortcutActive(advanced, "tape", sampleRate)).toBe(false);
    advanced.compressor.release = 500;
    expect(isMasteringShortcutActive(advanced, "glue", sampleRate)).toBe(true);
    advanced.compressor.autoRelease = false;
    expect(isMasteringShortcutActive(advanced, "glue", sampleRate)).toBe(false);
  });
});

describe("independent starting-point toggles", () => {
  function toggle(state: Parameters<typeof reduceStoreState>[0], shortcut: "air" | "mud" | "tape" | "glue") {
    return reduceStoreState(state, { type: "TOGGLE_MASTERING_SHORTCUT", trackId, shortcut });
  }
  it.each(["air", "mud", "tape", "glue"] as const)("%s restores exact prior settings after reload and retains other edits", (shortcut) => {
    const initial = { ...testStore, tracks: [{ ...track, advanced: createDefaultAdvancedParams() }] };
    const on = toggle(initial, shortcut);
    expect(isMasteringShortcutActive(first(on).advanced, shortcut, track.sampleRate)).toBe(true);
    const restored = normalizeHydratedState(JSON.parse(JSON.stringify(on)));
    if (!restored) throw new Error("Missing restored state");
    const changed = reduceStoreState(restored, { type: "UPDATE_INPUT_GAIN", trackId, input: 3 });
    const off = toggle(changed, shortcut);
    expect(isMasteringShortcutActive(first(off).advanced, shortcut, track.sampleRate)).toBe(false);
    expect(first(off).advanced).toEqual({ ...first(initial).advanced, input: 3 });
  });

  it.each(["air", "mud"] as const)("restores shared disabled EQ after %s is disabled first", (firstOff) => {
    const advanced = createDefaultAdvancedParams();
    advanced.eqEnabled = false;
    advanced.eqBands[2].gainDb = 2;
    const initial = { ...testStore, tracks: [{ ...track, advanced }] };
    const both = toggle(toggle(initial, "air"), "mud");
    const one = toggle(both, firstOff);
    expect(first(one).advanced.eqEnabled).toBe(true);
    const lastOff = firstOff === "air" ? "mud" : "air";
    expect(isMasteringShortcutActive(first(one).advanced, lastOff, track.sampleRate)).toBe(true);
    expect(first(toggle(one, lastOff)).advanced).toEqual(advanced);
  });

  it("keeps an unrelated manual EQ change audible after both shortcuts turn off", () => {
    const advanced = createDefaultAdvancedParams();
    advanced.eqEnabled = false;
    const initial = { ...testStore, tracks: [{ ...track, advanced }] };
    let changed = toggle(toggle(initial, "air"), "mud");
    changed = reduceStoreState(changed, { type: "UPDATE_EQ_BAND", trackId, bandId: "mid", patch: { gainDb: 2 } });
    changed = toggle(toggle(changed, "mud"), "air");
    expect(first(changed).advanced.eqEnabled).toBe(true);
    expect(first(changed).advanced.eqBands[2].gainDb).toBe(2);
  });

  it("reapplies over a manual edit, then restores that edit rather than an older snapshot", () => {
    const initial = { ...testStore, tracks: [{ ...track, advanced: createDefaultAdvancedParams() }] };
    let changed = toggle(initial, "air");
    changed = reduceStoreState(changed, { type: "UPDATE_EQ_BAND", trackId, bandId: "air", patch: { gainDb: 3 } });
    expect(first(changed).shortcutUndo?.air).toBeUndefined();
    const edited = first(changed).advanced;
    changed = toggle(toggle(changed, "air"), "air");
    expect(first(changed).advanced).toEqual(edited);
  });

  it.each(["air", "mud", "tape", "glue"] as const)("turns off an existing matching %s preset without an undo record", (shortcut) => {
    const advanced = applyMasteringShortcut(createDefaultAdvancedParams(), shortcut, track.sampleRate);
    const initial = { ...testStore, tracks: [{ ...track, advanced }] };
    const off = toggle(initial, shortcut);
    expect(isMasteringShortcutActive(first(off).advanced, shortcut, track.sampleRate)).toBe(false);
    expect(first(off).advanced).toEqual(createDefaultAdvancedParams());
  });

  it("discards malformed saved restore records instead of injecting invalid settings", () => {
    const initial = { ...testStore, tracks: [{ ...track, shortcutUndo: { air: { id: "air", gainDb: 999 }, tape: { enabled: true, drive: 999, character: "Tape" }, glue: null, eqBaseline: { enabled: false, bands: [] } } }] };
    const restored = normalizeHydratedState(initial);
    if (!restored) throw new Error("Missing restored state");
    expect(first(restored).shortcutUndo).toEqual({});
  });
});


it.each(["air", "mud"] as const)("disables a latent matching band with %s turned off first", (firstOff) => {
  for (const latent of ["air", "mud"] as const) {
    const advanced = { ...applyMasteringShortcut(createDefaultAdvancedParams(), latent, track.sampleRate), eqEnabled: false };
    let state: Parameters<typeof reduceStoreState>[0] = { ...testStore, tracks: [{ ...track, advanced }] };
    const toggle = (shortcut: "air" | "mud") => { state = reduceStoreState(state, { type: "TOGGLE_MASTERING_SHORTCUT", trackId, shortcut }); };
    toggle(latent);
    toggle(latent === "air" ? "mud" : "air");
    toggle(firstOff);
    expect(isMasteringShortcutActive(first(state).advanced, firstOff, track.sampleRate)).toBe(false);
    const lastOff = firstOff === "air" ? "mud" : "air";
    expect(isMasteringShortcutActive(first(state).advanced, lastOff, track.sampleRate)).toBe(true);
    toggle(lastOff);
    expect(first(state).advanced).toEqual(advanced);
  }
});


it("disables the final latent shortcut while preserving unrelated live EQ edits", () => {
  const advanced = { ...applyMasteringShortcut(createDefaultAdvancedParams(), "air", track.sampleRate), eqEnabled: false };
  let state: Parameters<typeof reduceStoreState>[0] = { ...testStore, tracks: [{ ...track, advanced }] };
  state = reduceStoreState(state, { type: "TOGGLE_MASTERING_SHORTCUT", trackId, shortcut: "air" });
  state = reduceStoreState(state, { type: "UPDATE_EQ_BAND", trackId, bandId: "mid", patch: { gainDb: 2 } });
  state = reduceStoreState(state, { type: "TOGGLE_MASTERING_SHORTCUT", trackId, shortcut: "air" });
  expect(isMasteringShortcutActive(first(state).advanced, "air", track.sampleRate)).toBe(false);
  expect(first(state).advanced.eqBands[4].enabled).toBe(false);
  expect(first(state).advanced.eqEnabled).toBe(true);
  expect(first(state).advanced.eqBands[2].gainDb).toBe(2);
});
