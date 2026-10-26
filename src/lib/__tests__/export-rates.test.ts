import { describe, expect, it } from "vitest";
import { MAX_SOURCE_FRAMES } from "../audio-limits";
import { convertedFrames, exportRateChoices, unavailableRateNote } from "../export-rates";

describe("export rate choices", () => {
  it("offers a listed source rate once, as the source choice", () => {
    const choices = exportRateChoices(48000, 48000);
    expect(choices).toEqual([
      { value: 44100, hz: 44100 },
      { value: "source", hz: 48000 },
      { value: 88200, hz: 88200 },
      { value: 96000, hz: 96000 },
    ]);
    expect(unavailableRateNote(choices, 48000)).toBe("");
  });

  it("puts an unlisted source rate first, ahead of every delivery rate", () => {
    expect(exportRateChoices(32000, 32000).map((choice) => choice.value)).toEqual(["source", 44100, 48000, 88200, 96000]);
  });

  it("rounds converted length up and disables only rates past the frame limit", () => {
    expect(convertedFrames(48001, 48000, 44100)).toBe(44101);
    // Exactly at the limit at 96 kHz from 48 kHz is allowed; one more frame is not.
    const atLimit = exportRateChoices(48000, MAX_SOURCE_FRAMES / 2);
    expect(atLimit.every((choice) => choice.unavailable === undefined)).toBe(true);
    const past = exportRateChoices(48000, MAX_SOURCE_FRAMES / 2 + 1);
    expect(past.filter((choice) => choice.unavailable).map((choice) => choice.value)).toEqual([96000]);
    expect(unavailableRateNote(past, 48000)).toBe("96 kHz is unavailable: this track would exceed the 33,554,432-frame limit for a converted export.");
    const long = exportRateChoices(48000, 20_000_000);
    expect(long.filter((choice) => choice.unavailable === "too-long").map((choice) => choice.value)).toEqual([88200, 96000]);
    expect(unavailableRateNote(long, 48000)).toContain("88.2 kHz and 96 kHz are unavailable");
  });

  it("disables conversions the Go resampler cannot represent exactly", () => {
    // gcd(44101, 48000) = 1, so the 48000/44101 ratio exceeds 4096 phases.
    const odd = exportRateChoices(44101, 44101);
    expect(odd.filter((choice) => choice.unavailable === "unsupported").map((choice) => choice.value)).toEqual([44100, 48000, 88200, 96000]);
    expect(unavailableRateNote(odd, 44101)).toBe("44.1 kHz, 48 kHz, 88.2 kHz and 96 kHz are unavailable: 44.101 kHz cannot be converted to them exactly.");
    expect(exportRateChoices(47952, 47952).every((choice) => choice.unavailable === undefined)).toBe(true);
  });
});
