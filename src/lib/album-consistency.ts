import type { FeatureMeasurements } from "./feature-analysis";
import type { MeasuredAudioMetrics } from "./types";

export const albumTargets = [-23, -18, -16, -14, -12, -9] as const;
export type AlbumGainMode = "relationships" | "normalize";
export interface AlbumReading {
  id: string; title: string; duration: number; metrics: MeasuredAudioMetrics;
  bands: FeatureMeasurements["bands"];
}
export interface AlbumGainPlan {
  medianTrackLufs: number; commonGainDb: number | null;
  tracks: { id: string; gainDb: number; requestedLufs: number | null; headroomLimited: boolean; measurable: boolean }[];
}
const peakCeiling = -1;
// Reserve a disclosed 0.01 dB for final encoding; this is not an ideal-sinc guarantee.
const encodingMargin = 0.01;
const edges = [20, 120, 500, 2000, 6000, 20000];

function median(values: number[]): number {
  if (!values.length) throw new Error("No measurable tracks are available.");
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  const upper = sorted.at(middle);
  if (upper === undefined) throw new Error("No measurable tracks are available.");
  return sorted.length % 2 ? upper : ((sorted.at(middle - 1) ?? upper) + upper) / 2;
}
function measurable(reading: AlbumReading): boolean {
  return reading.duration >= 0.4 && reading.metrics.integratedLufs > -69.9;
}
function validate(readings: readonly AlbumReading[]): void {
  if (!readings.length || readings.length > 64 || new Set(readings.map((item) => item.id)).size !== readings.length)
    throw new Error("Choose between one and 64 different album tracks.");
  for (const reading of readings) {
    if (!reading.id || !Number.isFinite(reading.duration) || reading.duration <= 0
      || !Object.values(reading.metrics).every(Number.isFinite)) throw new Error("The album contains invalid measurements.");
  }
}

/** Explicit post-chain gain only. A median of tracks is not album-integrated loudness. */
export function planAlbumGain(readings: readonly AlbumReading[], target: number, mode: AlbumGainMode, offsets: readonly number[]): AlbumGainPlan {
  validate(readings);
  if (!albumTargets.some((value) => value === target) || !["relationships", "normalize"].includes(mode)
    || offsets.length !== readings.length || !offsets.every((value) => Number.isFinite(value) && Math.abs(value) <= 6))
    throw new Error("Choose a supported album target, gain mode and offsets within six dB.");
  const center = median(readings.filter(measurable).map((item) => item.metrics.integratedLufs));
  const headroom = readings.map((item) => peakCeiling - encodingMargin - item.metrics.truePeakDbtp);
  let common: number | null = null;
  if (mode === "relationships") {
    common = Math.min(target - center, ...headroom.map((available, index) => available - (offsets.at(index) ?? 0)),
      ...offsets.map((offset) => 36 - offset));
    if (offsets.some((offset) => (common ?? 0) + offset < -36))
      throw new Error("This sequence requires more attenuation than the gain stage supports.");
  }
  const tracks = readings.map((item, index) => {
    const offset = offsets.at(index) ?? 0, available = headroom.at(index) ?? 0;
    const valid = measurable(item), wanted = valid ? target + offset : null;
    const requestedGain = wanted === null ? 0 : wanted - item.metrics.integratedLufs;
    const gain = common === null ? Math.min(36, requestedGain, available) : common + offset;
    if (gain < -36) throw new Error("A track requires more attenuation than the gain stage supports.");
    return { id: item.id, gainDb: gain, requestedLufs: mode === "relationships" ? null : wanted,
      headroomLimited: mode === "relationships" ? common !== target - center : gain < requestedGain - 1e-8,
      measurable: valid };
  });
  return { medianTrackLufs: center, commonGainDb: common, tracks };
}

/** Descriptive outliers, never quality scores or instructions to flatten a sequence. */
export function summarizeAlbum(readings: readonly AlbumReading[]) {
  validate(readings);
  const cohort = readings.filter(measurable);
  if (!cohort.length) return { medianTrackLufs: null, loudnessSpreadLu: null, commonBands: [], tracks: readings.map((item) => ({ id: item.id, loudnessDeltaLu: null, crestDeltaDb: null, tonalDeviationDb: null, findings: ["Too quiet or short for a reliable loudness comparison."] })) };
  const center = median(cohort.map((item) => item.metrics.integratedLufs));
  const crest = median(cohort.map((item) => item.metrics.dynamicRangeDb));
  for (const item of cohort) {
    if (item.bands.length !== 5 || item.bands.some((band, index) => band.lowHz !== edges.at(index) || band.highHz !== edges.at(index + 1)
      || !Number.isFinite(band.powerDb) || !Number.isFinite(band.usableHighHz)
      || band.usableHighHz < band.lowHz || band.usableHighHz > band.highHz))
      throw new Error("The album contains invalid spectral coverage.");
  }
  const commonBands = [0, 1, 2, 3, 4].filter((index) => cohort.every((item) => {
    const band = item.bands.at(index);
    return band?.valid && band.usableHighHz === band.highHz && band.powerDb > -119.9;
  }));
  const relative = cohort.map((item) => {
    const powers = commonBands.map((index) => item.bands.at(index)?.powerDb ?? -120);
    const totalDb = 10 * Math.log10(powers.reduce((total, value) => total + 10 ** (value / 10), 0));
    return { id: item.id, values: powers.map((value) => value - totalDb) };
  });
  const bandCenters = commonBands.map((_, index) => median(relative.map((item) => item.values.at(index) ?? 0)));
  return { medianTrackLufs: center,
    loudnessSpreadLu: Math.max(...cohort.map((item) => item.metrics.integratedLufs)) - Math.min(...cohort.map((item) => item.metrics.integratedLufs)),
    commonBands: commonBands.map((index) => ({ lowHz: edges.at(index) ?? 0, highHz: edges.at(index + 1) ?? 0 })),
    tracks: readings.map((item) => {
      if (!measurable(item)) return { id: item.id, loudnessDeltaLu: null, crestDeltaDb: null, tonalDeviationDb: null, findings: ["Too quiet or short for a reliable loudness comparison."] };
      const loudnessDeltaLu = item.metrics.integratedLufs - center, crestDeltaDb = item.metrics.dynamicRangeDb - crest;
      const values = relative.find((value) => value.id === item.id)?.values ?? [];
      const tonalDeviationDb = commonBands.length >= 2
        ? Math.sqrt(values.reduce((sum, value, index) => sum + (value - (bandCenters.at(index) ?? value)) ** 2, 0) / commonBands.length) : null;
      const findings: string[] = [];
      if (Math.abs(loudnessDeltaLu) > 2) findings.push("More than 2 LU from the median track; this may be intentional.");
      if (Math.abs(crestDeltaDb) > 3) findings.push("Crest factor differs by more than 3 dB; listen to the transition.");
      if (tonalDeviationDb !== null && tonalDeviationDb > 3) findings.push("Relative band balance differs by more than 3 dB RMS across the shared bands.");
      if (tonalDeviationDb === null) findings.push("Fewer than two shared full, nonzero bands; tone comparison is unavailable.");
      return { id: item.id, loudnessDeltaLu, crestDeltaDb, tonalDeviationDb, findings };
    }) };
}
