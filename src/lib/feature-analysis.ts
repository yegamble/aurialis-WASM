import { runAudioJob } from "./audio-jobs";

/** Measured source summaries. These are diagnostics, not a mastering script. */
export interface FeatureMeasurements {
  source: { pcmHash: string; sampleRate: number; frames: number };
  bands: { lowHz: number; highHz: number; usableHighHz: number; powerDb: number; valid: boolean }[];
  sections: { id: string; name: string; startFrame: number; endFrame: number; confidence: number }[];
  warnings: string[];
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid analysis response.");
  return value as Record<string, unknown>;
}

function finite(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Analysis contains an invalid measurement.");
  return value;
}

function string(value: unknown): string {
  if (typeof value !== "string" || value.length > 512) throw new Error("Invalid analysis text.");
  return value;
}

function measurements(value: unknown): FeatureMeasurements {
  const data = record(value);
  if (data.version !== "1.0") throw new Error("Unsupported analysis version.");
  const identity = record(data.source);
  const source = { pcmHash: string(identity.pcmHash), sampleRate: finite(identity.sampleRate), frames: finite(identity.frames) };
  if (!/^[a-f0-9]{64}$/u.test(source.pcmHash) || !Number.isInteger(source.sampleRate) || source.sampleRate < 8000 || source.sampleRate > 192000 || !Number.isInteger(source.frames) || source.frames < 1 || source.frames > 16_777_216) throw new Error("Invalid analysis source identity.");
  if (!Array.isArray(data.bands) || data.bands.length !== 5 || !Array.isArray(data.sections) || data.sections.length < 1 || data.sections.length > 1024 || !Array.isArray(data.warnings) || data.warnings.length > 20) throw new Error("Invalid analysis summary.");
  const bands = data.bands.map((item: unknown) => {
    const band = record(item);
    if (typeof band.valid !== "boolean") throw new Error("Invalid frequency availability.");
    return { lowHz: finite(band.lowHz), highHz: finite(band.highHz), usableHighHz: finite(band.usableHighHz), powerDb: finite(band.powerDb), valid: band.valid };
  });
  const sections = data.sections.map((item: unknown) => {
    const section = record(item);
    return { id: string(section.id), name: string(section.name), startFrame: finite(section.startFrame), endFrame: finite(section.endFrame), confidence: finite(section.confidence) };
  });
  let end = 0;
  for (const section of sections) {
    if (!Number.isInteger(section.startFrame) || !Number.isInteger(section.endFrame) || section.startFrame !== end || section.endFrame <= end || section.endFrame > source.frames || section.confidence < 0 || section.confidence > 1) throw new Error("Invalid analysis section coverage.");
    end = section.endFrame;
  }
  if (end !== source.frames) throw new Error("Incomplete analysis section coverage.");
  return { source, bands, sections, warnings: data.warnings.map(string) };
}

/** Measure canonical source audio without mutating its processing settings. */
export async function analyzeSourceFeatures(blob: Blob, signal: AbortSignal, onProgress: (progress: number, stage: string) => void, expectedBuild?: string): Promise<FeatureMeasurements> {
  const body = new FormData();
  body.append("file", blob, "source.wav");
  return runAudioJob("/api/analyze/features", body, signal, onProgress, (job) => measurements(job.features), expectedBuild);
}
