import { describe, expect, it } from "vitest";
import { clampAdvancedToSampleRate, createDefaultAdvancedParams, mapSimpleToDSP } from "../audio-dsp";

const genres = ["Pop", "Hip-hop", "Rock", "Electronic", "Acoustic", "R&B"];
const tones = ["Warm", "Open", "Punchy", "Intimate", "Wide", "Clean"];

describe("Simple direction determinism", () => {
  for (const genre of genres) {
    for (const tone of tones) {
      it(`${genre}/${tone} is independent of prior direction selections`, () => {
        for (const intensity of [0, 50, 100]) {
          const expected = mapSimpleToDSP(genre, tone, intensity, "Streaming");
          // Interleave every other tone; no direction retains mutable DSP state.
          for (const other of tones) {
            mapSimpleToDSP("Rock", other, 100, "Loud");
            expect(mapSimpleToDSP(genre, tone, intensity, "Streaming")).toEqual(expected);
          }
          expect(expected.eqBands.every((band) => Number.isFinite(band.gainDb))).toBe(true);
        }
      });
    }
  }
});

describe("Conservative mastering direction calibration", () => {
  it("leaves intensity zero tonally neutral while retaining the explicit limiter target", () => {
    for (const genre of genres) {
      for (const tone of tones) {
        const settings = mapSimpleToDSP(genre, tone, 0, "Dynamic");
        expect(settings.eqBands.map((band) => band.gainDb)).toEqual([0, 0, 0, 0, 0]);
        expect(settings.compressor.enabled).toBe(false);
        expect(settings.compressor.ratio).toBe(1);
        expect(settings.saturationModule.enabled).toBe(false);
        expect(settings.stereo).toMatchObject({ enabled: false, width: 100, monoBass: false, midGainDb: 0, sideGainDb: 0 });
        expect(settings.limiter).toMatchObject({ enabled: true, targetLufs: -16, ceiling: -1 });
      }
    }
  });
  it("uses gentle broad EQ, restrained dynamics and no automatic repair for every direction", () => {
    for (const genre of genres) {
      for (const tone of tones) {
        for (const intensity of [25, 50, 75, 100]) {
          const settings = mapSimpleToDSP(genre, tone, intensity, "Streaming");
          expect(Math.max(...settings.eqBands.map((band) => Math.abs(band.gainDb)))).toBeLessThanOrEqual(1.5);
          expect(settings.eqBands[1]).toMatchObject({ type: "peaking", freqHz: 250, q: 0.7 });
          expect(settings.compressor.ratio).toBeLessThanOrEqual(2.2);
          expect(settings.compressor.attack).toBeGreaterThanOrEqual(25);
          expect(settings.compressor.makeup).toBe(0);
          expect(settings.saturationModule.drive).toBeLessThanOrEqual(9);
          expect(settings.stereo.width).toBeLessThanOrEqual(118);
          expect(settings.deHarsh.enabled).toBe(false);
          expect(settings.multiband.enabled).toBe(false);
        }
      }
    }
  });
  it("keeps Clean free from saturation even for coloured genres", () => {
    for (const genre of genres) {
      expect(mapSimpleToDSP(genre, "Clean", 100, "Streaming").saturationModule)
        .toEqual({ character: "Clean", enabled: false, drive: 0 });
    }
  });
  it("preserves transient attack and protects the compressor detector from heavy bass", () => {
    const punch = mapSimpleToDSP("Hip-hop", "Punchy", 100, "Streaming");
    expect(punch.compressor).toMatchObject({ attack: 30, release: 150, sidechainHpfHz: 120, autoRelease: true });
    expect(punch.stereo).toMatchObject({ monoBass: true, crossoverHz: 110 });
    expect(mapSimpleToDSP("Acoustic", "Clean", 100, "Streaming").compressor)
      .toMatchObject({ attack: 40, ratio: 1.2, sidechainHpfHz: 60 });
  });
  it("handles invalid intensity as neutral and clamps out-of-range intensity", () => {
    expect(mapSimpleToDSP("Pop", "Warm", Number.NaN, "Streaming"))
      .toEqual(mapSimpleToDSP("Pop", "Warm", 0, "Streaming"));
    expect(mapSimpleToDSP("Pop", "Warm", 120, "Streaming"))
      .toEqual(mapSimpleToDSP("Pop", "Warm", 100, "Streaming"));
  });
});


describe("Frequency-dependent module defaults", () => {
  it("keeps new processors opt-in and caps high crossovers to the source bandwidth", () => {
    const settings = createDefaultAdvancedParams();
    const narrow = clampAdvancedToSampleRate(settings, 8000);
    expect(settings.deHarsh).toMatchObject({ enabled: false, frequencyHz: 4500 });
    expect(settings.multiband).toMatchObject({ enabled: false, midHighHz: 4000 });
    expect(narrow.deHarsh.frequencyHz).toBe(3760);
    expect(narrow.multiband.midHighHz).toBe(3760);
    expect(narrow.multiband.lowMidHz).toBeLessThan(narrow.multiband.midHighHz);
    expect(narrow.deHarsh.enabled).toBe(false);
    expect(narrow.multiband.enabled).toBe(false);
  });
});
