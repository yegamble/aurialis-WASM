import { describe, expect, it } from "vitest";
import { composeSimpleDirection, prepareSimpleChange, restoredSimpleDirection, simpleGenreNames, simpleToneNames } from "../simple-directions";
import { normalizeHydratedState, reduceStoreState } from "../store";
import { testStore } from "./fixtures";
import type { SimpleDirection } from "../types";

const direction: SimpleDirection = { version: 2, genre: "Pop", tone: "Warm", intensity: 50, style: "precise", depth: false, presence: false };
const track = testStore.tracks[0];
if (!track) throw new Error("Missing source fixture");

describe("versioned Simple directions", () => {
  it("keeps all genre, tone, style and combined modifier choices bounded, finite and neutral at zero", () => {
    for (const genre of simpleGenreNames) for (const tone of simpleToneNames) for (const style of ["precise", "organic", "elevated"] as const)
      for (const depth of [false, true]) for (const presence of [false, true]) for (const intensity of [0, 50, 100]) {
        const settings = composeSimpleDirection({ ...direction, genre, tone, style, depth, presence, intensity });
        expect(settings.eqBands.every((band) => Number.isFinite(band.gainDb) && Math.abs(band.gainDb) <= 1.5)).toBe(true);
        expect(settings.compressor.ratio).toBeGreaterThanOrEqual(1);
        expect(settings.compressor.ratio).toBeLessThanOrEqual(2.2);
        expect(settings.compressor.makeup).toBe(0);
        expect(settings.input).toBe(0);
        expect(settings.saturationModule.drive).toBeLessThanOrEqual(9);
        if (intensity === 0) {
          expect(settings.eqBands.every((band) => band.gainDb === 0)).toBe(true);
          expect(settings.compressor.enabled || settings.saturationModule.enabled || settings.stereo.enabled).toBe(false);
        }
      }
  });
  it("composes Depth and Presence once regardless of edit order and reapply", () => {
    const first = prepareSimpleChange(track, { genre: "Jazz", depth: true });
    const depthFirst = prepareSimpleChange({ ...track, ...first }, { presence: true });
    const second = prepareSimpleChange(track, { genre: "Jazz", presence: true });
    const presenceFirst = prepareSimpleChange({ ...track, ...second }, { depth: true });
    expect(depthFirst.advanced).toEqual(presenceFirst.advanced);
    expect(prepareSimpleChange({ ...track, ...depthFirst }, { depth: true }).advanced).toEqual(depthFirst.advanced);
    expect(composeSimpleDirection({ ...direction, style: "organic" }).compressor.ratio).toBeLessThan(composeSimpleDirection(direction).compressor.ratio);
    expect(composeSimpleDirection({ ...direction, style: "organic" }).saturationModule.drive).toBeLessThan(composeSimpleDirection(direction).saturationModule.drive);
    expect(composeSimpleDirection({ ...direction, style: "elevated" }).compressor.threshold).toBeLessThan(composeSimpleDirection(direction).compressor.threshold);
  });
  it("preserves explicit gain/targets and manual processing on a target-only change", () => {
    const manual = { ...track, advanced: { ...track.advanced, input: -3, compressor: { ...track.advanced.compressor, threshold: -21 } }, simpleCustom: true };
    const targetOnly = prepareSimpleChange(manual, { target: "Dynamic" });
    expect(targetOnly.advanced.compressor).toEqual(manual.advanced.compressor);
    expect(targetOnly.advanced.input).toBe(-3);
    expect(targetOnly.simpleCustom).toBe(true);
    const selected = prepareSimpleChange(manual, { style: "organic" });
    expect(selected.advanced.input).toBe(-3);
    expect(selected.advanced.limiter.targetLufs).toBe(manual.advanced.limiter.targetLufs);
    expect(selected.advanced.limiter.ceiling).toBe(manual.advanced.limiter.ceiling);
  });
  it("rejects stale publication and never remaps legacy or valid saved audio during hydration", () => {
    const change = prepareSimpleChange(track, { genre: "Metal", style: "organic" });
    const action = { type: "APPLY_SIMPLE_DIRECTION" as const, expected: track, change };
    const changed = { ...testStore, tracks: [{ ...track }, ...testStore.tracks.slice(1)] };
    expect(reduceStoreState(changed, action).tracks[0]).toBe(changed.tracks[0]);
    const applied = reduceStoreState(testStore, action).tracks[0];
    if (!applied) throw new Error("Missing applied fixture");
    expect(applied.simpleDirection).toEqual(change.simpleDirection);
    expect(normalizeHydratedState({ ...testStore, tracks: [applied] })?.tracks[0]?.advanced).toEqual(applied.advanced);
    expect(normalizeHydratedState(testStore)?.tracks[0]?.advanced).toEqual(track.advanced);
    const corrupt = { ...applied, simpleDirection: { ...change.simpleDirection, version: 99 } };
    const restored = normalizeHydratedState({ ...testStore, tracks: [corrupt] })?.tracks[0];
    expect(restored?.simpleDirection).toBeUndefined();
    expect(restored?.simpleCustom).toBe(true);
    expect(restored?.advanced).toEqual(applied.advanced);
    expect(restoredSimpleDirection(direction)).toEqual(direction);
  });
});
