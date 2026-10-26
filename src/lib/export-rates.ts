import { MAX_SOURCE_FRAMES } from "./audio-limits";
import { EXPORT_SAMPLE_RATES, type ExportSampleRate } from "./types";

type ExportRateChoice = {
  /** "source" sends no sampleRate, so the export keeps every source frame. */
  value: ExportSampleRate | "source";
  hz: number;
  /** Why Go would refuse this conversion for the current track. */
  unavailable?: "too-long" | "unsupported";
};

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

/** Mirrors Go `newResampler`: an exact polyphase ratio needs both factors at most 4096. */
function convertible(from: number, to: number): boolean {
  if (!Number.isSafeInteger(from) || from < 8000 || from > 192000) return false;
  const divisor = gcd(from, to);
  return to / divisor <= 4096 && from / divisor <= 4096;
}

/** Output length of a conversion; Go rounds the source duration up to a whole frame. */
export function convertedFrames(frames: number, from: number, to: number): number {
  return Math.ceil((frames * to) / from);
}

/**
 * The delivery rates offered for a source: the source rate once, then every
 * other export rate, marking those whose conversion Go would reject.
 */
export function exportRateChoices(sourceRate: number, frames: number): ExportRateChoice[] {
  const listed = EXPORT_SAMPLE_RATES.some((rate) => rate === sourceRate);
  const choices: ExportRateChoice[] = listed ? [] : [{ value: "source", hz: sourceRate }];
  for (const rate of EXPORT_SAMPLE_RATES) {
    if (rate === sourceRate) {
      choices.push({ value: "source", hz: rate });
    } else if (!convertible(sourceRate, rate)) {
      choices.push({ value: rate, hz: rate, unavailable: "unsupported" });
    } else if (convertedFrames(frames, sourceRate, rate) > MAX_SOURCE_FRAMES) {
      choices.push({ value: rate, hz: rate, unavailable: "too-long" });
    } else {
      choices.push({ value: rate, hz: rate });
    }
  }
  return choices;
}

export const formatRate = (hz: number): string => `${String(hz / 1000)} kHz`;

function list(items: readonly string[]): string {
  return items.length < 2 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1) ?? ""}`;
}

/** Visible explanation for every unavailable rate, or "" when all rates are available. */
export function unavailableRateNote(choices: readonly ExportRateChoice[], sourceRate: number): string {
  const rates = (reason: ExportRateChoice["unavailable"]) => choices.filter((choice) => choice.unavailable === reason).map((choice) => formatRate(choice.hz));
  const long = rates("too-long"), unsupported = rates("unsupported");
  const notes: string[] = [];
  if (long.length > 0) notes.push(`${list(long)} ${long.length > 1 ? "are" : "is"} unavailable: this track would exceed the ${MAX_SOURCE_FRAMES.toLocaleString("en-US")}-frame limit for a converted export.`);
  if (unsupported.length > 0) notes.push(`${list(unsupported)} ${unsupported.length > 1 ? "are" : "is"} unavailable: ${formatRate(sourceRate)} cannot be converted to ${unsupported.length > 1 ? "them" : "it"} exactly.`);
  return notes.join(" ");
}
