import { clampAdvancedToSampleRate, mapSimpleToDSP } from "./audio-dsp";
import { masteringTargets } from "./mastering-targets";
import type { AdvancedParams, SimpleDirection, Track } from "./types";

export const simpleGenreNames: readonly SimpleDirection["genre"][] = ["Pop", "Hip-hop", "Rock", "Electronic", "Acoustic", "R&B", "Metal", "Jazz"];
export const simpleToneNames: readonly SimpleDirection["tone"][] = ["Warm", "Open", "Punchy", "Intimate", "Wide", "Clean"];
export type SimplePatch = Partial<Pick<Track, "genre" | "tone" | "intensity" | "target">> & Partial<Pick<SimpleDirection, "style" | "depth" | "presence">>;
export type SimpleChange = Pick<Track, "genre" | "tone" | "intensity" | "target" | "advanced"> & {
  simpleDirection: SimpleDirection; simpleCustom: boolean;
};

const round = (value: number) => Math.round(value * 100) / 100 + 0;

/** Creative starting points, never source-adaptive or proprietary plugin coefficients. */
export function composeSimpleDirection(direction: SimpleDirection): AdvancedParams {
  const k = Number.isFinite(direction.intensity) ? Math.max(0, Math.min(100, direction.intensity)) / 100 : 0;
  const genre = direction.genre === "Metal" ? "Rock" : direction.genre === "Jazz" ? "Acoustic" : direction.genre;
  const base = mapSimpleToDSP(genre, direction.tone, k * 100, "Streaming");
  const eq = direction.genre === "Metal" ? [-0.2, -0.1, 0, -0.25, -0.1] : direction.genre === "Jazz" ? [0.1, 0.1, -0.1, 0, -0.1] : [0, 0, 0, 0, 0];
  let ratio = base.compressor.ratio;
  let threshold = base.compressor.threshold;
  let drive = base.saturationModule.drive;
  if (direction.genre === "Jazz") ratio = Math.max(1, ratio - 0.2 * k);
  if (direction.style === "organic") {
    ratio = 1 + (ratio - 1) * 0.65;
    threshold += 2 * k;
    drive *= 0.5;
  } else if (direction.style === "elevated") {
    // More gain reduction, with no added makeup, input gain or saturation.
    // The product measures the complete candidate before accepting this style.
    ratio = Math.min(2.2, ratio + 0.15 * k);
    threshold -= 2 * k;
  }
  const depth = direction.depth ? [0.35, 0.15, 0, 0, 0] : [0, 0, 0, 0, 0];
  const presence = direction.presence ? [0, 0, 0.1, 0.35, 0.25] : [0, 0, 0, 0, 0];
  const bands = base.eqBands.map((band, index) => ({ ...band,
    gainDb: round(Math.max(-1.5, Math.min(1.5, band.gainDb + ((eq.at(index) ?? 0) + (depth.at(index) ?? 0) + (presence.at(index) ?? 0)) * k))),
  })) as AdvancedParams["eqBands"];
  const attack = direction.genre === "Jazz" ? 45 : base.compressor.attack;
  const release = direction.genre === "Jazz" ? 350 : direction.genre === "Metal" ? 180 : base.compressor.release;
  drive = round(drive); ratio = round(ratio); threshold = round(threshold);
  return { ...base, threshold, ratio, attack, release, saturation: drive, eqBands: bands,
    compressor: { ...base.compressor, enabled: k > 0 && ratio > 1, ratio, threshold, attack, release },
    saturationModule: { ...base.saturationModule, drive, enabled: drive > 0 },
  };
}

export function prepareSimpleChange(track: Track, patch: SimplePatch): SimpleChange {
  const genre = simpleGenreNames.find((name) => name === (patch.genre ?? track.genre)) ?? "Pop";
  const tone = simpleToneNames.find((name) => name === (patch.tone ?? track.tone)) ?? "Clean";
  const rawIntensity = patch.intensity ?? track.intensity;
  const intensity = Number.isFinite(rawIntensity) ? Math.max(0, Math.min(100, rawIntensity)) : 0;
  const direction: SimpleDirection = { version: 2, genre, tone, intensity,
    style: patch.style ?? track.simpleDirection?.style ?? "precise",
    depth: patch.depth ?? track.simpleDirection?.depth ?? false,
    presence: patch.presence ?? track.simpleDirection?.presence ?? false,
  };
  const changed = patch.genre !== undefined || patch.tone !== undefined || patch.intensity !== undefined || patch.style !== undefined || patch.depth !== undefined || patch.presence !== undefined;
  const target = patch.target === undefined ? track.advanced.limiter : masteringTargets.find((item) => item.name === patch.target) ?? track.advanced.limiter;
  const base = changed ? composeSimpleDirection(direction) : track.advanced;
  const advanced = clampAdvancedToSampleRate({ ...base, input: track.advanced.input,
    limiter: { ...base.limiter, targetLufs: target.targetLufs, ceiling: target.ceiling },
  }, track.sampleRate);
  return { genre, tone, intensity, target: patch.target ?? track.target, advanced,
    simpleDirection: direction, simpleCustom: changed ? false : track.simpleCustom ?? true };
}

/** Restore metadata only; never remap saved processing settings. */
export function restoredSimpleDirection(value: unknown): SimpleDirection | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Partial<SimpleDirection>;
  if (Object.keys(raw).length !== 7 || raw.version !== 2 || !simpleGenreNames.some((name) => name === raw.genre)
    || !simpleToneNames.some((name) => name === raw.tone) || !["precise", "organic", "elevated"].some((name) => name === raw.style)
    || typeof raw.depth !== "boolean" || typeof raw.presence !== "boolean" || typeof raw.intensity !== "number"
    || !Number.isFinite(raw.intensity) || raw.intensity < 0 || raw.intensity > 100) return undefined;
  return { version: 2, genre: raw.genre as SimpleDirection["genre"], tone: raw.tone as SimpleDirection["tone"], style: raw.style as SimpleDirection["style"], depth: raw.depth, presence: raw.presence, intensity: raw.intensity };
}
