import { createDefaultAdvancedParams } from "../audio-dsp";
import type { StereoPCM } from "../browser-engine";
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

/** Canonical stereo 32-bit float WAV, the layout the app stores, for test sources. */
export function canonicalWAV(pcm: StereoPCM): Blob {
  const data = new ArrayBuffer(44 + pcm.left.length * 8),
    view = new DataView(data);
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++)
      view.setUint8(offset + i, value.charCodeAt(i));
  };
  text(0, "RIFF");
  view.setUint32(4, data.byteLength - 8, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 3, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, pcm.sampleRate, true);
  view.setUint32(28, pcm.sampleRate * 8, true);
  view.setUint16(32, 8, true);
  view.setUint16(34, 32, true);
  text(36, "data");
  view.setUint32(40, pcm.left.length * 8, true);
  for (let i = 0; i < pcm.left.length; i++) {
    view.setFloat32(44 + i * 8, pcm.left.at(i) ?? 0, true);
    view.setFloat32(48 + i * 8, pcm.right.at(i) ?? 0, true);
  }
  return new Blob([data], { type: "audio/wav" });
}
