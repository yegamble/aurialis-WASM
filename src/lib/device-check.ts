import { createDefaultAdvancedParams } from "./audio-dsp";
import type { AdvancedParams, RenderQuality } from "./types";
/** The exact heavy chain used by the bounded real-device qualification route. */
export function deviceCheckSettings(renderQuality: RenderQuality): AdvancedParams {
  const base = createDefaultAdvancedParams();
  return { ...base, renderQuality, input: 6,
    eqBands: base.eqBands.map((band) => ({ ...band, enabled: true, gainDb: 2 })) as AdvancedParams["eqBands"],
    deHarsh: { ...base.deHarsh, enabled: true, thresholdDb: -30, rangeDb: 6 },
    multiband: { ...base.multiband, enabled: true, bands: base.multiband.bands.map((band) => ({ ...band, thresholdDb: -24, ratio: 3 })) as AdvancedParams["multiband"]["bands"] },
    compressor: { ...base.compressor, enabled: true, threshold: -20, ratio: 3, autoRelease: true },
    saturationModule: { enabled: true, drive: 60, character: "Tube" },
    stereo: { ...base.stereo, enabled: true, width: 130, monoBass: true, midGainDb: 1, sideGainDb: -1 },
    limiter: { ...base.limiter, enabled: true, ceiling: -1 },
  };
}
/** A deterministic twenty-second source, then the normal Go CDR import path validates it. */
export function deviceCheckWAV(rate: 48000 | 96000): ArrayBuffer {
  const frames = rate * 20, bytes = new ArrayBuffer(44 + frames * 8), view = new DataView(bytes);
  const text = (offset: number, value: string) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
  text(0, "RIFF"); view.setUint32(4, bytes.byteLength - 8, true); text(8, "WAVEfmt "); view.setUint32(16, 16, true);
  view.setUint16(20, 3, true); view.setUint16(22, 2, true); view.setUint32(24, rate, true); view.setUint32(28, rate * 8, true);
  view.setUint16(32, 8, true); view.setUint16(34, 32, true); text(36, "data"); view.setUint32(40, frames * 8, true);
  for (let frame = 0; frame < frames; frame++) {
    const t = frame / rate, mid = .2 * Math.sin(2 * Math.PI * 997 * t) + .08 * Math.sin(2 * Math.PI * 60 * t) + .07 * Math.sin(2 * Math.PI * 4000 * t), side = .03 * Math.sin(2 * Math.PI * 3001 * t);
    view.setFloat32(44 + frame * 8, mid + side, true); view.setFloat32(48 + frame * 8, mid - side, true);
  }
  return bytes;
}
