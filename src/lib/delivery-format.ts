import { convertedFrames, formatRate, type ExportRateChoice } from "./export-rates";
import { EXPORT_SAMPLE_RATES, type ExportBitDepth, type ExportDelivery, type ExportSampleRate } from "./types";

/** One delivered WAV. Export, Release Check and album masters all render this format. */
export type DeliveryFormat = { bitDepth: ExportBitDepth; sampleRate: ExportSampleRate | "source"; dither: boolean };
/** Source rate, 24-bit PCM, TPDF dither: what every render used before the format was selectable. */
export const DEFAULT_DELIVERY: DeliveryFormat = { bitDepth: 24, sampleRate: "source", dither: true };
/** Red Book CD PCM: 44.1 kHz, 16-bit, dithered once at the new rate. */
export const CD_DELIVERY: DeliveryFormat = { bitDepth: 16, sampleRate: 44100, dither: true };

/** The render request fields; omitted fields keep the source rate and TPDF dither. */
export function deliveryRequest(format: DeliveryFormat): ExportDelivery {
  return {
    ...(format.sampleRate === "source" ? {} : { sampleRate: format.sampleRate }),
    ...(format.bitDepth !== 32 && !format.dither ? { dither: "none" as const } : {}),
  };
}

export function deliveredRate(format: DeliveryFormat, sourceRate: number): number {
  return format.sampleRate === "source" ? sourceRate : format.sampleRate;
}

/** Frames in the delivered file; a conversion keeps the duration, rounded up as Go does. */
export function deliveredFrames(format: DeliveryFormat, sourceRate: number, frames: number): number {
  const rate = deliveredRate(format, sourceRate);
  return rate === sourceRate ? frames : convertedFrames(frames, sourceRate, rate);
}

/** Size of the delivered clean stereo WAV: header plus two channels of samples. */
export function deliveredBytes(format: DeliveryFormat, sourceRate: number, frames: number): number {
  return 44 + deliveredFrames(format, sourceRate, frames) * format.bitDepth / 4;
}

export function deliverySummary(format: DeliveryFormat, sourceRate?: number): string {
  const rate = format.sampleRate !== "source" ? formatRate(format.sampleRate) : sourceRate === undefined ? "Source rate" : `${formatRate(sourceRate)} (source)`;
  const depth = format.bitDepth === 32 ? "32-bit float" : `${String(format.bitDepth)}-bit PCM · ${format.dither ? "TPDF dither" : "no dither"}`;
  return `${rate} · ${depth}`;
}

/** A rate this source cannot deliver falls back to the source rate, as Export does. */
export function availableDelivery(format: DeliveryFormat, choices: readonly ExportRateChoice[]): DeliveryFormat {
  return choices.some((choice) => choice.value === format.sampleRate && choice.unavailable === undefined) ? format : { ...format, sampleRate: "source" };
}

/** Restore a saved format; anything unrecognized renders the default. */
export function readDeliveryFormat(value: unknown): DeliveryFormat {
  if (typeof value !== "object" || value === null) return { ...DEFAULT_DELIVERY };
  const { bitDepth, sampleRate, dither } = value as Partial<Record<keyof DeliveryFormat, unknown>>;
  const depth = bitDepth === 16 || bitDepth === 24 || bitDepth === 32 ? bitDepth : undefined;
  const rate = sampleRate === "source" ? sampleRate : EXPORT_SAMPLE_RATES.find((item) => item === sampleRate);
  return depth !== undefined && rate !== undefined && typeof dither === "boolean" ? { bitDepth: depth, sampleRate: rate, dither } : { ...DEFAULT_DELIVERY };
}
