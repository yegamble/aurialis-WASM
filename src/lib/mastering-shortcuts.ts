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

/** Selection follows the audible settings, including sample-rate-limited EQ. */
export function isMasteringShortcutActive(advanced: AdvancedParams, shortcut: MasteringShortcut, sampleRate: number): boolean {
  const expected = applyMasteringShortcut(advanced, shortcut, sampleRate);
  if (shortcut === "air" || shortcut === "mud") {
    const id = shortcut === "air" ? "air" : "low";
    const actualBand = advanced.eqBands.find((band) => band.id === id);
    const expectedBand = expected.eqBands.find((band) => band.id === id);
    return advanced.eqEnabled && !!actualBand && !!expectedBand &&
      actualBand.enabled === expectedBand.enabled && actualBand.type === expectedBand.type &&
      actualBand.freqHz === expectedBand.freqHz && actualBand.gainDb === expectedBand.gainDb && actualBand.q === expectedBand.q;
  }
  if (shortcut === "tape") {
    const actual = advanced.saturationModule;
    return actual.enabled && actual.character === expected.saturationModule.character && actual.drive === expected.saturationModule.drive;
  }
  // Manual release is retained but inaudible while automatic release is enabled.
  const actual = advanced.compressor;
  const target = expected.compressor;
  return actual.enabled && actual.autoRelease && actual.threshold === target.threshold &&
    actual.ratio === target.ratio && actual.attack === target.attack &&
    actual.sidechainHpfHz === target.sidechainHpfHz && actual.knee === target.knee && actual.makeup === target.makeup;
}
