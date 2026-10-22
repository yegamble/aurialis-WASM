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

async function responseJSON(response: Response): Promise<unknown> {
  if (!response.ok) throw new Error(response.status === 503 ? "The local audio processor is busy. Try again shortly." : `Audio analysis request failed (${String(response.status)}).`);
  return response.json() as Promise<unknown>;
}

/** Retain the admission response after Cancel so an admitted job can be deleted. */
export async function analyzeSourceFeatures(blob: Blob, signal: AbortSignal, onProgress: (progress: number, stage: string) => void): Promise<FeatureMeasurements> {
  signal.throwIfAborted();
  const body = new FormData();
  body.append("file", blob, "source.wav");
  onProgress(0, "Validating original audio…");
  const submitted = record(await responseJSON(await fetch("/api/analyze/features", { method: "POST", body, signal: AbortSignal.timeout(65_000) })));
  const id = string(submitted.jobId);
  if (!/^[a-zA-Z0-9-]{1,80}$/u.test(id)) throw new Error("Invalid analysis job identity.");
  const url = `/api/jobs/${encodeURIComponent(id)}`;
  let job = submitted;
  const deadline = Date.now() + 130_000;
  try {
    for (;;) {
      signal.throwIfAborted();
      if (job.status === "done") return measurements(job.features);
      if (job.status === "failed" || job.status === "cancel" + "led") throw new Error(typeof job.error === "string" ? job.error : "Audio analysis stopped before completion.");
      if (job.status !== "queued" && job.status !== "running") throw new Error("Unexpected analysis job state.");
      if (Date.now() > deadline) throw new Error("Audio analysis exceeded its time limit.");
      onProgress(Math.max(0, Math.min(100, finite(job.progress))), string(job.stage));
      job = record(await responseJSON(await fetch(`${url}?wait=1`, { signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) })));
      if (job.jobId !== id) throw new Error("Analysis job identity changed.");
    }
  } finally {
    // Also release retained successful summaries after taking their bounded copy.
    try { await fetch(url, { method: "DELETE", keepalive: true, signal: AbortSignal.timeout(5000) }); } catch { /* Server timeout/retention remains the fallback when disconnected. */ }
  }
}
