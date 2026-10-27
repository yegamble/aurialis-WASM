import { usesBrowserAudio } from "./browser-jobs";
import { safeFileBaseName } from "./zip";

/** The server's model state (GET /api/stems/model `state`). */
export type StemModelState = "disabled" | "absent" | "downloading" | "loading" | "cached" | "invalid" | "loaded";

/** Window geometry and recorded seconds per window; only accelerated builds report one. */
export interface StemSpeed {
  windowSeconds: number;
  hopSeconds: number;
  idleSecondsPerWindow: number;
  busySecondsPerWindow: number;
}

export interface StemModelStatus {
  /** False when the local server did not answer; only a reachable server with available: false means disabled. */
  reachable: boolean;
  available: boolean;
  ready: boolean;
  downloading: boolean;
  downloadedBytes: number;
  totalBytes: number;
  state: StemModelState;
  /** True when inference uses Apple Accelerate; plain-Go builds report false and are unavailable. */
  accelerated: boolean;
  /** "apple-accelerate", "portable-go", or "" when the server was started without the model. */
  backend: string;
  speed: StemSpeed | null;
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

/** Why a split failed, so the panel can explain it in plain language and adjust the model note. */
export type StemSplitFailure = "unavailable" | "busy" | "queue_full" | "too_long" | "memory" | "model" | "model_cache" | "stopped" | "lost" | "expired" | "unreadable" | "missing_source" | "connection" | "timeout" | "internal";

/** The one sentence for a native server started with Smart Split disabled. */
export const STEM_MODEL_DISABLED = "Smart Split is turned off in this Aurialis server: it was started with the separation model disabled.";

const INTERNAL_FAILURE = "Smart Split ran into an internal error. Try again; if it keeps failing, report the song's length and sample rate.";

const failureCopy = new Map<StemSplitFailure, string>([
  ["unavailable", STEM_MODEL_DISABLED],
  ["busy", "Aurialis is finishing another audio task. Wait for it to complete, then split again."],
  ["queue_full", "Smart Split is already working on other songs and can't take another right now. Try again after one finishes."],
  ["too_long", "This song is too long to split. Smart Split handles up to about 5.8 minutes at 48 kHz."],
  ["memory", "This song needs more memory than Smart Split allows. Try a shorter section or a lower sample rate."],
  ["model", "The separation model couldn't be downloaded or verified. Check your internet connection, then split again to retry the download."],
  ["model_cache", "The separation model couldn't be saved to or loaded from its cache folder on this computer. Check that your user cache folder can be written to and has about 180 MB free, then split again."],
  ["stopped", "Smart Split stopped before it finished. A long song on a slower computer can reach the 90-minute job limit."],
  ["lost", "Aurialis lost track of this split; the local server may have restarted. Split the song again."],
  ["expired", "These stems are no longer available. Stems are kept for 15 minutes, and restarting the local server clears them. Split the song again."],
  ["unreadable", "Aurialis couldn't read this audio for splitting. Re-import the original file and try again."],
  ["missing_source", "The original audio is missing. Restore the source before splitting."],
  ["connection", "Aurialis lost contact with its local server. Check that it is still running, then try again."],
  ["timeout", "Aurialis's local server didn't answer in time; it may be busy with other audio. Wait a moment, then try again."],
]);

function copyFor(kind: StemSplitFailure): string {
  return failureCopy.get(kind) ?? INTERNAL_FAILURE;
}

/** A Smart Split failure with plain-language copy. The server's raw detail stays in `detail` for bug reports. */
export class StemSplitError extends Error {
  constructor(readonly kind: StemSplitFailure, readonly detail = "") {
    super(copyFor(kind));
    this.name = "StemSplitError";
  }
}

/** Classifies any error thrown while splitting or fetching stems. */
export function stemSplitFailureKind(error: unknown): StemSplitFailure {
  if (error instanceof StemSplitError) return error.kind;
  // AbortSignal.timeout() rejects fetch with a TimeoutError DOMException.
  if (error instanceof DOMException && error.name === "TimeoutError") return "timeout";
  if (error instanceof TypeError) return "connection";
  return "internal";
}

/** The message to show for any error thrown while splitting or fetching stems. */
export function stemSplitFailureMessage(error: unknown): string {
  return error instanceof StemSplitError ? error.message : copyFor(stemSplitFailureKind(error));
}

/** "<title> - <Stem>.wav", safe on common filesystems. */
export function stemDownloadName(title: string, stem: string): string {
  const track = safeFileBaseName(title, ""), part = safeFileBaseName(stem, "Stem");
  return track ? `${track} - ${part}.wav` : `${part}.wav`;
}

const unavailable: StemModelStatus = { reachable: true, available: false, ready: false, downloading: false, downloadedBytes: 0, totalBytes: 0, state: "disabled", accelerated: false, backend: "", speed: null };
const unreachable: StemModelStatus = { ...unavailable, reachable: false };

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid Smart Split response.");
  return value as Record<string, unknown>;
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

const states = new Set<string>(["disabled", "absent", "downloading", "loading", "cached", "invalid", "loaded"]);

function modelState(body: Record<string, unknown>): StemModelState {
  if (typeof body.state === "string" && states.has(body.state)) return body.state as StemModelState;
  if (body.ready === true) return "loaded";
  return body.downloading === true ? "downloading" : "absent";
}

function positive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function readSpeed(value: unknown): StemSpeed | null {
  if (typeof value !== "object" || value === null) return null;
  const { windowSeconds, hopSeconds, idleSecondsPerWindow, busySecondsPerWindow } = value as Record<string, unknown>;
  if (!positive(windowSeconds) || !positive(hopSeconds) || !positive(idleSecondsPerWindow) || !positive(busySecondsPerWindow)) return null;
  return { windowSeconds, hopSeconds, idleSecondsPerWindow, busySecondsPerWindow };
}

/** Split runs only from the native build, against a reachable server whose model is available, with a track loaded. */
export function canSplit(browser: boolean, status: StemModelStatus | null, audioId: string | null): boolean {
  return !browser && status?.reachable === true && status.available && audioId !== null;
}

/** Smart Split needs the native build's local server; the browser build has no model. */
export async function stemModelStatus(signal?: AbortSignal): Promise<StemModelStatus> {
  if (usesBrowserAudio()) return unavailable;
  try {
    const response = await fetch("/api/stems/model", { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000) });
    if (!response.ok) return unreachable;
    const body = record(await response.json());
    return {
      reachable: true, available: body.available === true, ready: body.ready === true, downloading: body.downloading === true,
      downloadedBytes: count(body.downloadedBytes), totalBytes: count(body.totalBytes), state: modelState(body),
      accelerated: body.accelerated === true, backend: typeof body.backend === "string" ? body.backend.slice(0, 40) : "", speed: readSpeed(body.speed),
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    return unreachable;
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

function stringField(body: unknown, name: "error" | "detail"): string {
  if (typeof body !== "object" || body === null) return "";
  const value: unknown = name === "error" ? ("error" in body ? body.error : "") : ("detail" in body ? body.detail : "");
  return typeof value === "string" ? value : "";
}

/** Maps the server's error code (body.error) to a failure kind. */
function rejected(response: Response, body: unknown): StemSplitError {
  const code = stringField(body, "error"), detail = stringField(body, "detail");
  if (code === "stems_unavailable") return new StemSplitError("unavailable", detail);
  if (code === "queue_full") return new StemSplitError("queue_full", detail);
  if (code === "busy") return new StemSplitError("busy", detail);
  if (response.status === 413) return new StemSplitError("too_long", detail);
  if (response.status === 400 || response.status === 415 || response.status === 422) return new StemSplitError("unreadable", detail);
  return new StemSplitError("internal", detail || `HTTP ${String(response.status)}`);
}

/** Maps a failed job's raw Go error to a failure kind. */
function jobFailure(raw: string): StemSplitError {
  if (/stem model download|dial tcp|no such host|connection (?:refused|reset)|certificate|tls|timeout|Get "/iu.test(raw)) return new StemSplitError("model", raw);
  // Anything else while loading is local: a cache folder that cannot be written or a damaged cached file.
  if (/stem model|separation model|model cache/iu.test(raw)) return new StemSplitError("model_cache", raw);
  if (/memory ceiling/iu.test(raw)) return new StemSplitError("memory", raw);
  if (/too long/iu.test(raw)) return new StemSplitError("too_long", raw);
  return new StemSplitError("internal", raw);
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
  if (!submitted.ok) throw rejected(submitted, admitted);
  let job = record(admitted);
  if (typeof job.jobId !== "string" || !idPattern.test(job.jobId)) throw new StemSplitError("internal", "Invalid Smart Split job identity.");
  const id = job.jobId;
  const url = `/api/jobs/${encodeURIComponent(id)}`;
  const release = () => { void fetch(url, { method: "DELETE", keepalive: true, signal: AbortSignal.timeout(5000) }).catch(() => undefined); };
  const deadline = Date.now() + 95 * 60_000;
  try {
    for (;;) {
      signal.throwIfAborted();
      if (job.status === "done") return { jobId: id, stems: readStems(job.stems, id), release };
      if (job.status === "failed") throw jobFailure(typeof job.error === "string" ? job.error : "");
      // The server marks a job that reached its 90-minute limit as cancelled.
      if (job.status === "cancel" + "led") throw new StemSplitError("stopped");
      if (job.status !== "queued" && job.status !== "running") throw new StemSplitError("internal", "Unexpected Smart Split job state.");
      if (Date.now() > deadline) throw new StemSplitError("stopped", "Client deadline exceeded.");
      onProgress(Math.max(0, Math.min(100, count(job.progress))), typeof job.stage === "string" ? job.stage.slice(0, 120) : "");
      const response = await fetch(`${url}?wait=1`, { signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) });
      if (response.status === 404) throw new StemSplitError("lost", "Job not found.");
      if (!response.ok) throw new StemSplitError("internal", `Status HTTP ${String(response.status)}`);
      job = record(await response.json());
      if (job.jobId !== id) throw new StemSplitError("internal", "Smart Split job identity changed.");
    }
  } catch (error) {
    release();
    throw error;
  }
}

/**
 * Reads one stem into memory. Downloading through a Blob lets the page name the
 * file "<title> - <Stem>.wav"; the server's attachment name is the bare stem ID.
 */
export async function fetchStemAudio(stem: SplitStem, signal?: AbortSignal): Promise<Blob> {
  const response = await fetch(stem.url, signal ? { signal } : {});
  if (response.status === 404) throw new StemSplitError("expired", "Stem not found.");
  if (!response.ok) throw new StemSplitError("internal", `Stem HTTP ${String(response.status)}`);
  const blob = await response.blob();
  return blob.type === "audio/wav" ? blob : new Blob([blob], { type: "audio/wav" });
}
