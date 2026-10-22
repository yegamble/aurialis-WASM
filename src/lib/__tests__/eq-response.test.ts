import { describe, expect, it } from "vitest";
import { computeEqMagnitudeDb, createDefaultAdvancedParams } from "../audio-dsp";
import type { EQBandParams } from "../types";
import nativeFixtures from "./fixtures/eq-response-native.json";

const filterTypes: Record<string, EQBandParams["type"]> = {
  high_pass: "highpass", low_shelf: "lowshelf", peaking: "peaking", high_shelf: "highshelf",
};
function band(patch: Partial<EQBandParams> = {}): EQBandParams {
  return { ...createDefaultAdvancedParams().eqBands[2], ...patch };
}

describe("EQ response prediction of the shared Go engine", () => {
  // Generated and independently remeasured by TestNativeEQResponseFixtures.
  // These are actual Float32 sine renders, not values from the display formula.
  it.each(nativeFixtures)("matches native sine renders at $rate Hz for $bands", (fixture) => {
    const bands = fixture.bands.map((native) => {
      const type = filterTypes[native.type];
      if (!type) throw new Error("Unknown native filter type");
      return band({ type, freqHz: native.freqHz, gainDb: native.gainDb, q: native.q, enabled: native.enabled });
    });
    fixture.probes.forEach((frequency, index) => {
      const measured = fixture.measuredDb.at(index);
      if (measured === undefined) throw new Error("Missing native measurement");
      expect(Math.abs(computeEqMagnitudeDb(frequency, bands, fixture.rate) - measured)).toBeLessThan(0.01);
    });
  });

  it("keeps disabled and neutral bands flat at the engine's activation threshold", () => {
    expect(computeEqMagnitudeDb(1000, [band({ gainDb: 12, enabled: false })])).toBe(0);
    expect(computeEqMagnitudeDb(1000, [band({ gainDb: 0.00000009 })])).toBe(0);
    expect(computeEqMagnitudeDb(1000, [band({ gainDb: 0.0000001 })])).toBeGreaterThan(0);
    expect(computeEqMagnitudeDb(1000, [band({ type: "highpass", freqHz: 1000, gainDb: 0, q: Math.SQRT1_2 })])).toBeCloseTo(-3.0103, 4);
  });

  it("returns finite endpoint responses, including a high-pass zero at DC", () => {
    for (const rate of [8000, 44100, 48000, 96000, 192000]) {
      for (const type of ["highpass", "lowshelf", "peaking", "highshelf"] as const) {
        for (const gainDb of [-24, 24]) {
          for (const q of [0.1, 20]) {
            const bands = [band({ type, gainDb, q, freqHz: 40000 })];
            for (const frequency of [-100, 0, 10, rate * 0.485, rate / 2, rate]) {
              expect(Number.isFinite(computeEqMagnitudeDb(frequency, bands, rate))).toBe(true);
            }
          }
        }
      }
      expect(computeEqMagnitudeDb(0, [band({ type: "highpass" })], rate)).toBe(-240);
      expect(computeEqMagnitudeDb(rate / 2, [band({ type: "highshelf", gainDb: 6 })], rate)).toBeCloseTo(6, 8);
      expect(computeEqMagnitudeDb(rate / 2, [band({ type: "lowshelf", gainDb: 6 })], rate)).toBeCloseTo(0, 8);
    }
  });

  it("fails flat for non-finite probes or unsupported sample rates", () => {
    for (const frequency of [NaN, Infinity, -Infinity]) {
      expect(computeEqMagnitudeDb(frequency, [band({ gainDb: 6 })])).toBe(0);
    }
    for (const rate of [NaN, Infinity, 0, 7999, 192001]) {
      expect(computeEqMagnitudeDb(1000, [band({ gainDb: 6 })], rate)).toBe(0);
    }
  });
});
