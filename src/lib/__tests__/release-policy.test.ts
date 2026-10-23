import { describe, expect, it } from "vitest";
import { releaseChecks, releaseProfiles, type EncodedInspection, type ReleasePlatform } from "../release-policy";
import type { MeasuredAudioMetrics } from "../types";

const metrics: MeasuredAudioMetrics = { integratedLufs: -14, shortTermLufs: -14, truePeakDbtp: -1.1, samplePeakDbfs: -1.5, dynamicRangeDb: 5, correlation: 0.8, lowBassCorrelation: 1, dcLeftDbfs: -120, dcRightDbfs: -120, clippingSamples: 0, gainReductionDb: 0 };
const output: EncodedInspection = { sampleRate: 48000, frames: 48000, channels: 2, bitDepth: 24, fullScaleFrames: 0, leadingSilenceFrames: 0, trailingSilenceFrames: 0, silenceThresholdDbfs: -60 };
function check(platform: ReleasePlatform, name: string, patch: Partial<MeasuredAudioMetrics> = {}, encoding: Partial<EncodedInspection> = {}) {
  const item = releaseChecks(platform, { ...metrics, ...patch }, { ...output, ...encoding }).find((row) => row.name === name);
  if (!item) throw new Error("Missing release check");
  return item;
}
describe("source-specific delivery guidance", () => {
  it("offers the six planned named profiles with primary-source links", () => {
    expect(releaseProfiles.map((item) => item.name)).toEqual(["Spotify", "Apple Music", "YouTube", "SoundCloud", "CD", "Podcast"]);
    expect(releaseProfiles.every((item) => item.source.startsWith("https://"))).toBe(true);
  });
  it("tightens streaming peak guidance for louder masters, including exact boundaries", () => {
    for (const platform of ["Spotify", "SoundCloud"] as const) {
      expect(check(platform, "Reconstructed peak estimate").status).toBe("pass");
      expect(check(platform, "Reconstructed peak estimate", { truePeakDbtp: -1 }).status).toBe("review");
      expect(check(platform, "Reconstructed peak estimate", { integratedLufs: -13.999, truePeakDbtp: -1.99 }).status).toBe("review");
      expect(check(platform, "Reconstructed peak estimate", { integratedLufs: -13, truePeakDbtp: -2.01 }).status).toBe("pass");
    }
  });
  it("does not invent stereo LUFS mandates or genre-independent crest requirements", () => {
    for (const platform of ["Apple Music", "YouTube", "CD"] as const) {
      expect(check(platform, "Integrated loudness", { integratedLufs: -8 }).status).toBe("info");
      expect(check(platform, "Peak-to-RMS crest factor", { dynamicRangeDb: 2 }).status).toBe("info");
    }
    expect(check("Podcast", "Integrated loudness", { integratedLufs: -17 }).status).toBe("pass");
    expect(check("Podcast", "Integrated loudness", { integratedLufs: -17.01 }).status).toBe("review");
    expect(check("Podcast", "Metadata and delivery").guidance).toContain("ISRC");
  });
  it("checks actual PCM encoding while preserving accepted higher YouTube rates", () => {
    expect(check("CD", "Output format", {}, { sampleRate: 44100, bitDepth: 16 }).status).toBe("pass");
    expect(check("CD", "Output format", {}, { sampleRate: 48000, bitDepth: 16 }).status).toBe("review");
    expect(check("Apple Music", "Output format", {}, { bitDepth: 32 }).status).toBe("review");
    expect(check("YouTube", "Output format", {}, { sampleRate: 96000 }).status).toBe("pass");
    expect(check("YouTube", "Output format", {}, { sampleRate: 44100 }).status).toBe("review");
    expect(check("Spotify", "Output format").status).toBe("info");
  });
  it("uses actual encoded full-scale and quiet frames without changing audio or settings", () => {
    const before = JSON.stringify([metrics, output]);
    expect(check("CD", "Encoded full-scale frames", {}, { fullScaleFrames: 1 }).status).toBe("review");
    expect(check("CD", "Leading / trailing quiet", {}, { leadingSilenceFrames: 24001 }).status).toBe("review");
    expect(check("CD", "Leading / trailing quiet", {}, { trailingSilenceFrames: 96000 }).status).toBe("pass");
    expect(check("CD", "DC level", { dcRightDbfs: -40 }).status).toBe("review");
    expect(JSON.stringify([metrics, output])).toBe(before);
  });
});
