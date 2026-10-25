import { usesBrowserAudio } from "./browser-jobs";

export interface StemModelStatus {
  available: boolean;
  ready: boolean;
  downloading: boolean;
  downloadedBytes: number;
  totalBytes: number;
}

export interface SplitStem {
  id: string;
  name: string;
  color: string;
  url: string;
}

export interface StemSplit {
  jobId: string;
  stems: SplitStem[];
  /** Deletes the job and its stems from the local processor. */
  release: () => void;
}

const unavailable: StemModelStatus = { available: false, ready: false, downloading: false, downloadedBytes: 0, totalBytes: 0 };

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid Smart Split response.");
  return value as Record<string, unknown>;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

/** Smart Split needs the desktop app's local processor; the browser build has no model. */
export async function stemModelStatus(signal?: AbortSignal): Promise<StemModelStatus> {
  if (usesBrowserAudio()) return unavailable;
  try {
    const response = await fetch("/api/stems/model", { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000) });
    if (!response.ok) return unavailable;
    const body = record(await response.json());
    return { available: body.available === true, ready: body.ready === true, downloading: body.downloading === true, downloadedBytes: count(body.downloadedBytes), totalBytes: count(body.totalBytes) };
  } catch (error) {
    if (signal?.aborted) throw error;
    return unavailable;
  }
}

const idPattern = /^[a-zA-Z0-9-]{1,80}$/u;
const stemPattern = /^[a-z]{1,20}$/u;

function readStems(value: unknown, jobId: string): SplitStem[] {
  if (!Array.isArray(value) || value.length < 2 || value.length > 6) throw new Error("Smart Split returned an invalid stem list.");
  return value.map((item) => {
    const stem = record(item);
    if (typeof stem.id !== "string" || !stemPattern.test(stem.id) || typeof stem.name !== "string" || stem.name.length > 40 || typeof stem.color !== "string" || !/^#[0-9a-f]{6}$/iu.test(stem.color)) throw new Error("Smart Split returned an invalid stem.");
    return { id: stem.id, name: stem.name, color: stem.color, url: `/api/jobs/${encodeURIComponent(jobId)}/stems/${stem.id}` };
  });
}

function failure(response: Response, body: unknown): Error {
  const detail = typeof body === "object" && body !== null && "detail" in body && typeof body.detail === "string" ? body.detail : "";
  if (response.status === 503 && detail.includes("not available")) return new Error("Smart Split needs the Aurialis desktop app.");
  if (response.status === 503) return new Error("Smart Split is busy with another song. Try again when it finishes.");
  if (response.status === 413) return new Error("This song is too long to split. Smart Split handles up to about 5.8 minutes at 48 kHz.");
  return new Error(detail || `Smart Split failed (${String(response.status)}).`);
}

/**
 * Separates a source on the local processor. Separation can take several
 * minutes, so this polls well past the normal analysis limit. The job is kept
 * until release() so stems stay downloadable; cancelling deletes it.
 */
export async function runStemSplit(source: Blob, stems: number, signal: AbortSignal, onProgress: (progress: number, stage: string) => void): Promise<StemSplit> {
  signal.throwIfAborted();
  const body = new FormData();
  body.append("file", source, "source.wav");
  body.append("stems", String(stems));
  const submitted = await fetch("/api/separate", { method: "POST", body, signal: AbortSignal.any([signal, AbortSignal.timeout(65_000)]) });
  const admitted: unknown = await submitted.json().catch(() => null);
  if (!submitted.ok) throw failure(submitted, admitted);
  let job = record(admitted);
  if (typeof job.jobId !== "string" || !idPattern.test(job.jobId)) throw new Error("Invalid Smart Split job identity.");
  const id = job.jobId;
  const url = `/api/jobs/${encodeURIComponent(id)}`;
  const release = () => { void fetch(url, { method: "DELETE", keepalive: true, signal: AbortSignal.timeout(5000) }).catch(() => undefined); };
  const deadline = Date.now() + 95 * 60_000;
  try {
    for (;;) {
      signal.throwIfAborted();
      if (job.status === "done") return { jobId: id, stems: readStems(job.stems, id), release };
      if (job.status === "failed" || job.status === "cancel" + "led") throw new Error(typeof job.error === "string" ? job.error : "Smart Split stopped before completion.");
      if (job.status !== "queued" && job.status !== "running") throw new Error("Unexpected Smart Split job state.");
      if (Date.now() > deadline) throw new Error("Smart Split exceeded its time limit.");
      onProgress(Math.max(0, Math.min(100, count(job.progress))), typeof job.stage === "string" ? job.stage.slice(0, 120) : "");
      const response = await fetch(`${url}?wait=1`, { signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) });
      if (!response.ok) throw new Error(`Smart Split status failed (${String(response.status)}).`);
      job = record(await response.json());
      if (job.jobId !== id) throw new Error("Smart Split job identity changed.");
    }
  } catch (error) {
    release();
    throw error;
  }
}
