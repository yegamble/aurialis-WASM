import type { ScriptV2 } from "./deep-mastering";
import type { AdvancedParams, RenderQuality, Track } from "./types";

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

/** DSP algorithm for exports and live playback: the lookahead true-peak
 * limiter, which algorithm 2 selects with limiter.truePeak. The live worklet
 * compensates its latency (V1-10). */
export const EXPORT_ALGORITHM_VERSION = 2;
export const OVERSAMPLED_ALGORITHM_VERSION = 3;

/** Persisted per-track choice; absent values keep the classic sound. */
export function renderAlgorithm(quality?: RenderQuality): 2 | 3 {
  return quality === "oversampled" ? OVERSAMPLED_ALGORITHM_VERSION : EXPORT_ALGORITHM_VERSION;
}

function withExportLimiter<T extends { limiter: object; algorithmVersion?: number }>(params: T, quality?: RenderQuality): T & { algorithmVersion: number } {
  const algorithmVersion = quality === undefined && params.algorithmVersion === OVERSAMPLED_ALGORITHM_VERSION
    ? OVERSAMPLED_ALGORITHM_VERSION : renderAlgorithm(quality);
  return { ...params, limiter: { ...params.limiter, truePeak: true }, algorithmVersion };
}

/** What export and live playback both render (V1-10): what you hear is what
 * you export. Dither follows the export's bit depth after the render, and the
 * worklet mixes B Original and the equal-loudness offset outside the engine. */
export function exportParams(advanced: AdvancedParams) {
  return withExportLimiter(engineParams(advanced), advanced.renderQuality);
}

/** Engine settings as export renders them: the export algorithm, with dither
 * left to the export's bit depth, as the Go prediction (exportScriptV2) renders. */
export function exportChain<T extends { limiter: object; ditherBits: number; algorithmVersion?: number }>(params: T, quality?: RenderQuality): T & { algorithmVersion: number } {
  return { ...withExportLimiter(params, quality), ditherBits: 0 };
}

/** Copy of an applied script whose render uses the export algorithm; live
 * playback installs this same copy. */
export function exportScript<T extends { chainParams: { limiter: object; ditherBits: number; algorithmVersion?: number } }>(script: T, quality?: RenderQuality): T {
  const copy = structuredClone(script);
  return { ...copy, chainParams: exportChain(copy.chainParams, quality) };
}

/** What one master renders for delivery: its applied Deep script, else its settings. */
export function exportRender(track: Pick<Track, "advanced" | "deepMastering">): { params: ReturnType<typeof exportParams> } | { script: ScriptV2 } {
  const applied = track.deepMastering?.applied;
  return applied ? { script: exportScript(applied, track.advanced.renderQuality ?? "classic") } : { params: exportParams(track.advanced) };
}
