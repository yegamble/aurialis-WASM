import type { AdvancedParams } from "./types";

export function engineParams(advanced: AdvancedParams) {
  if (advanced.limiter.enabled && advanced.limiter.truePeak)
    throw new Error("True-peak limiting is unavailable. Use the sample-peak limiter.");
  if (advanced.repair.enabled)
    throw new Error("Audio repair is unavailable. Disable repair to render.");
  return {
    bypass: false,
    abOriginal: false,
    inputGainDb: advanced.input,
    eqEnabled: advanced.eqEnabled,
    bands: advanced.eqBands.map((band) => ({
      freqHz: band.freqHz,
      gainDb: band.gainDb,
      q: band.q,
      type:
        band.type === "lowshelf"
          ? "low_shelf"
          : band.type === "highshelf"
            ? "high_shelf"
            : band.type === "highpass" ? "high_pass" : "peaking",
      enabled: band.enabled,
    })),
    compressor: {
      enabled: advanced.compressor.enabled,
      thresholdDb: advanced.compressor.threshold,
      ratio: advanced.compressor.ratio,
      attackMs: advanced.compressor.attack,
      releaseMs: advanced.compressor.release,
      kneeDb: advanced.compressor.knee,
      makeupDb: advanced.compressor.makeup,
      sidechainHpfHz: advanced.compressor.sidechainHpfHz,
      autoRelease: advanced.compressor.autoRelease,
      topology: advanced.compressor.topology,
    },
    saturation: {
      enabled: advanced.saturationModule.enabled,
      amount: advanced.saturationModule.drive,
      character: advanced.saturationModule.character,
    },
    stereo: {
      enabled: advanced.stereo.enabled,
      widthPct: advanced.stereo.width,
      monoBass: advanced.stereo.monoBass,
      crossoverHz: advanced.stereo.crossoverHz,
      midGainDb: advanced.stereo.midGainDb,
      sideGainDb: advanced.stereo.sideGainDb,
    },
    limiter: {
      enabled: advanced.limiter.enabled,
      ceilingDbtp: advanced.limiter.ceiling,
      targetLufs: advanced.limiter.targetLufs,
      releaseMs: advanced.limiter.release,
      truePeak: false,
    },
    repair: { enabled: false, deEssDb: 0, transientDb: 0, deClip: false },
    deHarsh: advanced.deHarsh,
    multiband: advanced.multiband,
    ditherBits: 0,
  };
}

/** DSP algorithm for offline exports: the lookahead true-peak limiter, which
 * algorithm 2 selects with limiter.truePeak. Live playback stays on algorithm 1
 * because the worklet cannot absorb the limiter's latency. */
export const EXPORT_ALGORITHM_VERSION = 2;

function withExportLimiter<T extends { limiter: object }>(params: T): T & { algorithmVersion: number } {
  return { ...params, limiter: { ...params.limiter, truePeak: true }, algorithmVersion: EXPORT_ALGORITHM_VERSION };
}

export function exportParams(advanced: AdvancedParams) {
  return withExportLimiter(engineParams(advanced));
}

/** Copy of an applied script whose render uses the export algorithm. Dither
 * is left to the export's bit depth, as the Go prediction (exportScriptV2) renders. */
export function exportScript<T extends { chainParams: { limiter: object; ditherBits: number } }>(script: T): T {
  const copy = structuredClone(script);
  return { ...copy, chainParams: { ...withExportLimiter(copy.chainParams), ditherBits: 0 } };
}
