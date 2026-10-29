import { availableDelivery, deliveryRequest, readDeliveryFormat } from "./delivery-format";
import { exportRateChoices } from "./export-rates";
import type { ScriptV2 } from "./deep-mastering";
import type { AdvancedParams, Track } from "./types";

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

function withExportLimiter<T extends { limiter: object }>(params: T): T & { algorithmVersion: number } {
  return { ...params, limiter: { ...params.limiter, truePeak: true }, algorithmVersion: EXPORT_ALGORITHM_VERSION };
}

/** What export and live playback both render (V1-10): what you hear is what
 * you export. Dither follows the export's bit depth after the render, and the
 * worklet mixes B Original and the equal-loudness offset outside the engine. */
export function exportParams(advanced: AdvancedParams) {
  return withExportLimiter(engineParams(advanced));
}

/** Engine settings as export renders them: the export algorithm, with dither
 * left to the export's bit depth, as the Go prediction (exportScriptV2) renders. */
export function exportChain<T extends { limiter: object; ditherBits: number }>(params: T): T & { algorithmVersion: number } {
  return { ...withExportLimiter(params), ditherBits: 0 };
}

/** Copy of an applied script whose render uses the export algorithm; live
 * playback installs this same copy. */
export function exportScript<T extends { chainParams: { limiter: object; ditherBits: number } }>(script: T): T {
  const copy = structuredClone(script);
  return { ...copy, chainParams: exportChain(copy.chainParams) };
}

/** What one master renders for delivery: its applied Deep script, else its settings. */
export function exportRender(track: Pick<Track, "advanced" | "deepMastering">): { params: ReturnType<typeof exportParams> } | { script: ScriptV2 } {
  const applied = track.deepMastering?.applied;
  return applied ? { script: exportScript(applied) } : { params: exportParams(track.advanced) };
}

/** Source and canonical export payload identity, independent of labels and draft proposals. */
export function exportTrackKey(track: Track): string {
  const format = availableDelivery(readDeliveryFormat(track.exportDelivery), exportRateChoices(track.sampleRate, track.sourceIdentity?.frames ?? Math.round(track.duration * track.sampleRate)));
  return JSON.stringify([deliveryRequest(format), format.bitDepth, track.id, track.sourceAudioId ?? track.id, track.sourceRevision ?? 0,
    track.sourceIdentity ?? null, track.sampleRate, track.duration, exportRender(track)]);
}
