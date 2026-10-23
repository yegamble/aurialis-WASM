import { deviceAudioRequest, usesBrowserAudio } from "./browser-jobs";
function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid audio job response.");
  return value as Record<string, unknown>;
}
async function responseJSON(response: Response): Promise<unknown> {
  if (!response.ok) throw new Error(response.status === 503 ? "The local audio processor is busy. Try again shortly." : `Audio analysis request failed (${String(response.status)}).`);
  return response.json() as Promise<unknown>;
}

/** Keep an admission response alive after Cancel so its admitted job can be deleted. */
export async function runAudioJob<T>(path: string, body: FormData, signal: AbortSignal, onProgress: (progress: number, stage: string) => void, result: (job: Record<string, unknown>) => T): Promise<T> {
  signal.throwIfAborted();
  onProgress(0, "Validating original audio…");
  if (usesBrowserAudio()) {
    const completed = object(await responseJSON(await deviceAudioRequest(path, { method: "POST", body, signal }, onProgress)));
    signal.throwIfAborted();
    if (completed.status !== "done") throw new Error("Local audio analysis did not complete.");
    return result(completed);
  }
  const submitted = object(await responseJSON(await fetch(path, { method: "POST", body, signal: AbortSignal.timeout(65_000) })));
  if (typeof submitted.jobId !== "string" || !/^[a-zA-Z0-9-]{1,80}$/u.test(submitted.jobId)) throw new Error("Invalid analysis job identity.");
  const id = submitted.jobId;
  const url = `/api/jobs/${encodeURIComponent(id)}`;
  const deadline = Date.now() + 130_000;
  let job = submitted;
  try {
    for (;;) {
      signal.throwIfAborted();
      if (job.status === "done") return result(job);
      if (job.status === "failed" || job.status === "cancel" + "led") throw new Error(typeof job.error === "string" ? job.error : "Audio analysis stopped before completion.");
      if (job.status !== "queued" && job.status !== "running") throw new Error("Unexpected analysis job state.");
      if (Date.now() > deadline) throw new Error("Audio analysis exceeded its time limit.");
      if (typeof job.progress !== "number" || !Number.isFinite(job.progress) || typeof job.stage !== "string" || job.stage.length > 512) throw new Error("Invalid audio job progress.");
      onProgress(Math.max(0, Math.min(100, job.progress)), job.stage);
      job = object(await responseJSON(await fetch(`${url}?wait=1`, { signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) })));
      if (job.jobId !== id) throw new Error("Analysis job identity changed.");
    }
  } finally {
    try { await fetch(url, { method: "DELETE", keepalive: true, signal: AbortSignal.timeout(5000) }); } catch { /* Disconnection falls back to bounded server retention. */ }
  }
}
