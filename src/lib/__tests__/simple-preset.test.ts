import { describe, expect, it } from "vitest";
import { mapSimpleToDSP } from "../audio-dsp";

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
