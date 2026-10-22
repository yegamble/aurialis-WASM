import { clampAdvancedToSampleRate } from "./audio-dsp";
import type { AdvancedParams } from "./types";

export type MasteringShortcut = "air" | "mud" | "tape" | "glue";

/** Explicit, idempotent starting points. Only the named module parameters change. */
export function applyMasteringShortcut(advanced: AdvancedParams, shortcut: MasteringShortcut, sampleRate: number): AdvancedParams {
  const next = { ...advanced };
  if (shortcut === "air" || shortcut === "mud") {
    next.eqEnabled = true;
    next.eqBands = advanced.eqBands.map((band) => {
      if (shortcut === "air" && band.id === "air") return { ...band, enabled: true, type: "highshelf" as const, freqHz: 12000, gainDb: 1, q: 0.707 };
      if (shortcut === "mud" && band.id === "low") return { ...band, enabled: true, type: "peaking" as const, freqHz: 250, gainDb: -1.5, q: 0.8 };
      return band;
    }) as AdvancedParams["eqBands"];
  } else if (shortcut === "tape") {
    next.saturation = 10;
    next.saturationModule = { enabled: true, character: "Tape", drive: 10 };
  } else {
    next.compressor = { ...advanced.compressor, enabled: true, threshold: -18, ratio: 2, attack: 30, release: 200, autoRelease: true, sidechainHpfHz: 90, knee: 6, makeup: 0 };
    next.threshold = next.compressor.threshold;
    next.ratio = next.compressor.ratio;
    next.attack = next.compressor.attack;
    next.release = next.compressor.release;
  }
  return clampAdvancedToSampleRate(next, sampleRate);
}
