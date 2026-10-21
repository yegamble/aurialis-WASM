import { createDefaultAdvancedParams } from "../audio-dsp";
import type { Track } from "../types";

function fixtureTrack(id: string): Track {
  return {
    id, title: "Test source", filename: "test.wav", duration: 1,
    size: 384044, format: "WAV", sampleRate: 48000, status: "ready",
    updatedAt: "2026-10-21T00:00:00Z", createdAt: "2026-10-21T00:00:00Z",
    seed: 0, source: "upload", mode: "advanced", genre: "Pop", tone: "Clean",
    intensity: 50, target: "Streaming", profile: "modern_pop_polish",
    metrics: { lufs: -20, peak: -12, range: 3, dynamics: 3, correlation: 0.5 },
    advanced: createDefaultAdvancedParams(),
  };
}
export const testStore = {
  tracks: [fixtureTrack("demo-1"), fixtureTrack("test-2")], albums: [], stems: [],
};
