import { MAX_JOB_INPUT_BYTES } from "./audio-limits";
import { audioInputShape } from "./audio-input-shape";
import { EXPORT_SAMPLE_RATES } from "./types";
const OFFLINE_ABI = "1.0";
const MIB = 1024 * 1024;
const MAX_METADATA_BYTES = 2 * MIB + 128 * 1024;
const LOCAL_FALLBACK = "For this file, use the native Aurialis build (built from source) on this device. Your audio will not be uploaded.";
// Retained audio lives in this tab in both builds, so the native build keeps the budget but needs its own advice.
const RETAINED_NATIVE_HINT = "Download or discard finished audio in this tab, such as album masters or reviewed WAVs, or close other heavy tabs, then try again.";

interface JobRequest {
  operation: "render" | "features" | "deep" | "reference" | "compile";
  /** "render" skips the source measurement a client already cached (V1-13). */
  measure?: "render";
  params?: string;
  script?: string;
  profile?: string;
  bitDepth?: number;
  sampleRate?: number;
  dither?: string;
  format?: string;
  deviceRate?: number;
  options?: string;
  scriptVersion?: string;
}
interface JobResult { json: string; audio: ArrayBuffer }

/** Public websites always process locally. Only the device's loopback app may use HTTP audio APIs. */
export function usesBrowserAudio(): boolean {
  if (process.env.NEXT_PUBLIC_AURIALIS_EXECUTION === "browser") return true;
  if (typeof location === "undefined") return true;
  return !["localhost", "127.0.0.1", "[::1]", "::1"].includes(location.hostname.toLowerCase());
}

function memoryBudget(): number {
  const memory: unknown = typeof navigator !== "undefined" && "deviceMemory" in navigator ? navigator.deviceMemory : undefined;
  if (typeof memory === "number" && Number.isFinite(memory) && memory <= 2) return 256 * MIB;
  if (typeof memory === "number" && Number.isFinite(memory) && memory >= 8) return 2048 * MIB;
  if (typeof memory === "number" && Number.isFinite(memory)) return 512 * MIB;
  // Safari and Firefox do not report device memory. Phones and tablets get the
  // smaller budget; desktop browsers comfortably hold a 1.5 GiB worker.
  const coarse = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
  return coarse ? 1024 * MIB : 1536 * MIB;
}

let reservedResidentBytes = 0;
let activeJobBytes = 0;

/** Own the exact bytes retained outside a job, such as an album prefix or reviewed WAV. */
export function reserveBrowserAudioMemory(initialBytes = 0): Readonly<{ update: (bytes: number) => void; dispose: () => void }> {
  let held = 0;
  let disposed = false;
  const update = (bytes: number) => {
    if (disposed) throw new Error("This audio memory reservation has been released.");
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("Audio memory reservations require nonnegative safe byte counts.");
    const total = reservedResidentBytes - held + bytes;
    if (!Number.isSafeInteger(total) || total < 0) throw new Error("Audio memory reservations exceed the safe byte limit.");
    if (total + Math.max(64 * MIB, activeJobBytes) > memoryBudget()) throw new Error("Retained audio exceeds the browser's conservative memory budget. " + (usesBrowserAudio() ? LOCAL_FALLBACK : RETAINED_NATIVE_HINT));
    reservedResidentBytes = total;
    held = bytes;
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    reservedResidentBytes -= held;
    held = 0;
  };
  update(initialBytes);
  return Object.freeze({ update, dispose });
}

// Measured under WASM on 8,388,608 frames at 48 kHz: 7.5 s unconverted,
// 26.5 s to 88.2 kHz and 28.1 s to 96 kHz, about 1 + 1.4 × the rate ratio.
// 1.5 keeps headroom; downsampling still filters every input frame.
const CONVERSION_COST_PER_RATIO = 1.5;

async function preflight(request: JobRequest, source: Blob, reference: Blob, signal: AbortSignal): Promise<number> {
  signal.throwIfAborted();
  const input = source.size + reference.size;
  if (input > MAX_JOB_INPUT_BYTES) throw new Error("The combined audio exceeds the 257 MiB local job limit. " + LOCAL_FALLBACK);
  const shape = await audioInputShape(source, signal);
  const decoded = shape.bytes + (await audioInputShape(reference, signal)).bytes;
  signal.throwIfAborted();
  // Measured Go worker linear memory peaks near 2.2x the decoded PCM (input
  // copy, reconstructed and rendered channels, encoded WAV). Add the
  // transferred input buffer and the returned audio, with headroom.
  // FLAC's bounded geometric growth can retain up to 2x decoded capacity:
  // 4x covers that plus rendered PCM and encoded float WAV; 3x covers a
  // decode growth copy before rendering. This remains a working estimate.
  let estimate = 64 * MIB + input * 2 + decoded * (request.operation === "render" ? 4 : 3);
  // A converted export also holds resampled channels, their measurement and
  // the larger encoded WAV. An unreadable source rate assumes 8 kHz (worst case).
  const ratio = request.sampleRate !== undefined && request.sampleRate !== shape.rate ? request.sampleRate / (shape.rate ?? 8000) : 0;
  estimate += decoded * 3 * ratio;
  if (estimate + reservedResidentBytes > memoryBudget()) throw new Error("This job exceeds the browser's conservative audio memory budget. " + LOCAL_FALLBACK);
  activeJobBytes = estimate;
  // 130 s covers 16,777,216 frames; longer sources and conversions get proportionally longer.
  const conversion = ratio > 0 ? 1 + CONVERSION_COST_PER_RATIO * Math.max(1, ratio) : 1;
  return 130_000 * Math.max(1, decoded / (16_777_216 * 8)) * conversion;
}

let queue: Promise<void> = Promise.resolve();
let pending = 0;

function startWorker(request: JobRequest, source: ArrayBuffer, reference: ArrayBuffer, signal: AbortSignal, timeoutMs: number, onProgress?: (progress: number, stage: string) => void): Promise<JobResult> {
  return new Promise<JobResult>((resolve, reject) => {
    signal.throwIfAborted();
    const worker = new Worker("/offline-job-worker.js");
    const id = crypto.randomUUID();
    let settled = false;
    const finish = (result?: JobResult, error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      signal.removeEventListener("abort", abort);
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      worker.terminate();
      if (result) resolve(result);
      else reject(error ?? new Error("Local audio processing stopped."));
    };
    const abort = () => { finish(undefined, signal.reason instanceof Error ? signal.reason : new DOMException("Local audio canceled", "AbortError")); };
    const deadline = setTimeout(() => { finish(undefined, new Error("Local audio processing exceeded its time limit. " + LOCAL_FALLBACK)); }, timeoutMs);
    signal.addEventListener("abort", abort, { once: true });
    worker.onerror = () => { finish(undefined, new Error("Audio processing stopped unexpectedly in this browser. " + LOCAL_FALLBACK)); };
    worker.onmessageerror = () => { finish(undefined, new Error("The local audio result was unreadable.")); };
    worker.onmessage = (event: MessageEvent<unknown>) => {
      const data = event.data;
      if (typeof data !== "object" || data === null || !("id" in data) || data.id !== id || !("kind" in data)) { finish(undefined, new Error("Invalid local audio worker identity.")); return; }
      if (!("abi" in data) || data.abi !== OFFLINE_ABI) { finish(undefined, new Error("The local audio engine version is incompatible. Reload Aurialis to retry.")); return; }
      if (data.kind === "progress") {
        if (!("progress" in data) || typeof data.progress !== "number" || !Number.isFinite(data.progress) || !("stage" in data) || typeof data.stage !== "string" || data.stage.length > 1024) { finish(undefined, new Error("Invalid local audio progress.")); return; }
        try { onProgress?.(Math.max(0, Math.min(100, data.progress)), data.stage); }
        catch { finish(undefined, new Error("Local audio progress handling stopped.")); }
        return;
      }
      if (data.kind === "error") { finish(undefined, new Error("error" in data && typeof data.error === "string" ? data.error.slice(0, 1024) : "Local audio processing failed.")); return; }
      if (data.kind !== "result" || !("json" in data) || typeof data.json !== "string" || new TextEncoder().encode(data.json).byteLength > MAX_METADATA_BYTES || !("audio" in data) || !(data.audio instanceof ArrayBuffer) || data.audio.byteLength > MAX_JOB_INPUT_BYTES) { finish(undefined, new Error("Invalid local audio result.")); return; }
      finish({ json: data.json, audio: data.audio });
    };
    const metadata = JSON.stringify(request);
    if (new TextEncoder().encode(metadata).byteLength > MAX_METADATA_BYTES) { finish(undefined, new Error("Local audio metadata exceeds its limit.")); return; }
    try { worker.postMessage({ abi: OFFLINE_ABI, id, metadata, source, reference }, [source, reference]); }
    catch { finish(undefined, new Error("The local audio buffers could not be transferred.")); }
  });
}

function awaitCancellation<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  const canceled = () => signal.reason instanceof Error ? signal.reason : new DOMException("Local audio canceled", "AbortError");
  if (signal.aborted) return Promise.reject(canceled());
  return new Promise<T>((resolve, reject) => {
    const abort = () => { reject(canceled()); };
    signal.addEventListener("abort", abort, { once: true });
    void promise.then((value) => { signal.removeEventListener("abort", abort); resolve(value); }, (error: unknown) => { signal.removeEventListener("abort", abort); reject(error instanceof Error ? error : new Error("Local audio processing failed.")); });
  });
}

/** Background jobs (the A/B loudness measurement) yield to anything the user started. */
export type JobPriority = "foreground" | "background";
const backgroundJobs = new Set<{ controller: AbortController; settled: Promise<void> }>();

async function execute(request: JobRequest, source = new Blob(), reference = new Blob(), callerSignal = new AbortController().signal, onProgress?: (progress: number, stage: string) => void, priority: JobPriority = "foreground"): Promise<JobResult> {
  callerSignal.throwIfAborted();
  if (priority === "foreground" && backgroundJobs.size > 0) {
    // Export, Deep and the other user actions preempt measurements, so a
    // background job can neither delay them in the FIFO nor make them busy.
    const preempted = [...backgroundJobs];
    for (const job of preempted) job.controller.abort(new DOMException("A foreground audio job preempted this measurement.", "AbortError"));
    await Promise.all(preempted.map((job) => job.settled));
    callerSignal.throwIfAborted();
  }
  if (pending >= 2) throw new Error("Local audio processing is busy. Cancel the current job or try again shortly.");
  const preemption = priority === "background" ? new AbortController() : undefined;
  const signal = preemption ? AbortSignal.any([callerSignal, preemption.signal]) : callerSignal;
  const inputBytes = source.size + reference.size;
  if (inputBytes > MAX_JOB_INPUT_BYTES) throw new Error("The combined audio exceeds the 257 MiB local job limit. " + LOCAL_FALLBACK);
  // A waiting request already retains these Blobs, before its full preflight.
  // Keep the raw input charged through actual settlement, even if its caller
  // cancels early. This conservatively overlaps the active job's estimate.
  const inputMemory = reserveBrowserAudioMemory(inputBytes);
  pending++;
  const run = async () => {
    signal.throwIfAborted();
    try {
      const timeoutMs = await preflight(request, source, reference, signal);
      onProgress?.(0, "Preparing local audio processing…");
      const input = await source.arrayBuffer(), comparison = await reference.arrayBuffer();
      signal.throwIfAborted();
      return await startWorker(request, input, comparison, signal, timeoutMs, onProgress);
    } finally { activeJobBytes = 0; }
  };
  const result = queue.then(run, run).finally(() => { pending--; inputMemory.dispose(); });
  queue = result.then(() => undefined, () => undefined);
  if (preemption) {
    const job = { controller: preemption, settled: queue };
    backgroundJobs.add(job);
    void queue.then(() => { backgroundJobs.delete(job); });
  }
  return awaitCancellation(result, signal);
}

function formRequest(path: string, form: FormData): { request: JobRequest; source: Blob; reference: Blob } {
  const fields = new Map<string, FormDataEntryValue>();
  for (const [key, value] of form) {
    if (fields.has(key)) throw new Error("Duplicate local audio field.");
    fields.set(key, value);
  }
  let request: JobRequest;
  let allowed: string[];
  switch (path) {
    case "/api/master/render": request = { operation: "render" }; allowed = ["file", "params", "script", "profile", "bitDepth", "sampleRate", "dither", "format", "measure"]; break;
    case "/api/analyze/features": request = { operation: "features" }; allowed = ["file"]; break;
    case "/api/analyze/deep": request = { operation: "deep" }; allowed = ["file", "profile", "scriptVersion"]; break;
    case "/api/analyze/reference": request = { operation: "reference" }; allowed = ["source", "reference", "params", "options"]; break;
    default: throw new Error("This audio operation is unavailable in the browser. " + LOCAL_FALLBACK);
  }
  for (const key of fields.keys()) if (!allowed.includes(key)) throw new Error("Unsupported local audio field.");
  const text = (key: string) => { const value = fields.get(key); if (value !== undefined && typeof value !== "string") throw new Error("Invalid local audio field."); return value; };
  const params = text("params"), script = text("script"), profile = text("profile"), format = text("format"), options = text("options"), scriptVersion = text("scriptVersion"), bitDepth = text("bitDepth"), sampleRate = text("sampleRate"), dither = text("dither");
  if (params !== undefined) request.params = params;
  if (script !== undefined) request.script = script;
  if (profile !== undefined) request.profile = profile;
  if (format !== undefined) request.format = format;
  if (options !== undefined) request.options = options;
  if (scriptVersion !== undefined) request.scriptVersion = scriptVersion;
  if (bitDepth !== undefined) {
    if (!["16", "24", "32"].includes(bitDepth)) throw new Error("Invalid local audio bit depth.");
    request.bitDepth = Number(bitDepth);
  }
  if (sampleRate !== undefined) {
    const rate = EXPORT_SAMPLE_RATES.find((item) => String(item) === sampleRate);
    if (rate === undefined) throw new Error("Invalid local audio export rate.");
    request.sampleRate = rate;
  }
  if (dither !== undefined) {
    if (dither !== "tpdf" && dither !== "none") throw new Error("Invalid local audio dither.");
    request.dither = dither;
  }
  const measure = text("measure");
  if (measure !== undefined) {
    if (measure !== "render") throw new Error("Invalid local audio measurement.");
    request.measure = measure;
  }
  const source = fields.get(request.operation === "reference" ? "source" : "file"), reference = fields.get("reference");
  if (!(source instanceof Blob) || (reference !== undefined && !(reference instanceof Blob))) throw new Error("Missing local audio source.");
  return { request, source, reference: reference ?? new Blob() };
}

/** The render's afterMetrics true peak, which the native server sends as X-Aurialis-After-Peak-dBTP. */
function deliveredPeak(json: string): number | undefined {
  let body: unknown;
  try { body = JSON.parse(json); } catch { return undefined; }
  if (typeof body !== "object" || body === null || !("afterMetrics" in body) || typeof body.afterMetrics !== "object" || body.afterMetrics === null || !("truePeakDbtp" in body.afterMetrics)) return undefined;
  const peak = body.afterMetrics.truePeakDbtp;
  return typeof peak === "number" && Number.isFinite(peak) ? peak : undefined;
}

// User actions outrank the background A/B loudness measurement on both
// transports. The native server admits one audio POST and answers 503 to the
// rest, so foreground work aborts any in-flight measurement and retries a 503
// it caused; measurements never start while user work is active or just ended
// (multi-stage Deep analysis has short gaps between its requests).
const FOREGROUND_GRACE_MS = 2000;
const NATIVE_RETRIES = 4;
let foregroundDepth = 0;
let foregroundEndedAt = -Infinity;
const nativeBackground = new Set<{ controller: AbortController; settled: Promise<void> }>();

function preempted(): DOMException {
  return new DOMException("A foreground audio job preempted this measurement.", "AbortError");
}

/** Run user-initiated audio work (Export, Deep, Smart Split) with priority over background measurements. */
export async function withForegroundAudio<T>(work: () => Promise<T>): Promise<T> {
  foregroundDepth++;
  try {
    const running = [...nativeBackground];
    // Start immediately when nothing yields, so admission stays synchronous.
    if (running.length > 0) {
      for (const job of running) job.controller.abort(preempted());
      await Promise.all(running.map((job) => job.settled));
    }
    return await work();
  } finally {
    foregroundDepth--;
    foregroundEndedAt = performance.now();
  }
}

function foregroundBusy(): boolean {
  return foregroundDepth > 0 || performance.now() - foregroundEndedAt < FOREGROUND_GRACE_MS;
}

async function nativeRequest(path: string, init: RequestInit, priority: JobPriority): Promise<Response> {
  if (priority === "background") {
    if (foregroundBusy()) throw preempted();
    const controller = new AbortController();
    const response = fetch(path, { ...init, signal: init.signal ? AbortSignal.any([init.signal, controller.signal]) : controller.signal });
    const job = { controller, settled: response.then(() => undefined, () => undefined) };
    nativeBackground.add(job);
    try {
      const result = await response;
      // The slot was taken by user work: retry later rather than report a failure.
      if (result.status === 503) throw preempted();
      return result;
    } finally { nativeBackground.delete(job); }
  }
  return withForegroundAudio(async () => {
    for (let attempt = 0; ; attempt++) {
      const response = await fetch(path, init);
      // A just-aborted measurement may still hold the slot for a moment.
      if (response.status !== 503 || attempt >= NATIVE_RETRIES || init.signal?.aborted) return response;
      const after = Number(response.headers.get("Retry-After"));
      await new Promise((resolve) => setTimeout(resolve, Math.min(1000, Number.isFinite(after) && after > 0 ? after * 1000 : 250)));
    }
  });
}

/** Same contract as the device-local HTTP transport, implemented without network audio on websites. */
export async function deviceAudioRequest(path: string, init: RequestInit, onProgress?: (progress: number, stage: string) => void, priority: JobPriority = "foreground"): Promise<Response> {
  const url = new URL(path, typeof location === "undefined" ? "https://local.invalid" : location.origin);
  if (!path.startsWith("/api/") || path.startsWith("//") || url.origin !== (typeof location === "undefined" ? "https://local.invalid" : location.origin)) throw new Error("Audio requests must stay on this device.");
  if (!usesBrowserAudio()) return nativeRequest(path, init, priority);
  if (priority === "background" && foregroundBusy()) throw preempted();
  if (init.method !== "POST") throw new Error("Unsupported local audio request method.");
  let request: JobRequest, source = new Blob(), reference = new Blob();
  if (init.body instanceof FormData) {
    ({ request, source, reference } = formRequest(path, init.body));
    if (new Headers(init.headers).get("Accept")?.includes("application/json")) request.format = "json";
  } else if (typeof init.body === "string") {
    const url = new URL(path, "https://local.invalid");
    if (url.pathname !== "/api/automation/compile" || [...url.searchParams.keys()].some((key) => key !== "deviceRate") || url.searchParams.getAll("deviceRate").length > 1) throw new Error("Unsupported local audio JSON request.");
    request = { operation: "compile", script: init.body };
    if (url.searchParams.has("deviceRate")) {
      const rate = url.searchParams.get("deviceRate");
      if (!rate || !/^\d+$/u.test(rate)) throw new Error("Invalid local compilation rate.");
      request.deviceRate = Number(rate);
    }
  } else throw new Error("Invalid local audio request body.");
  const run = () => execute(request, source, reference, init.signal ?? undefined, onProgress, priority);
  const result = priority === "foreground" ? await withForegroundAudio(run) : await run();
  const headers = new Headers({ "Content-Type": result.audio.byteLength ? "audio/wav" : "application/json", "Cache-Control": "no-store" });
  if (result.audio.byteLength) {
    headers.set("X-Aurialis-Source-Metrics", result.json);
    const peak = deliveredPeak(result.json);
    if (peak !== undefined) headers.set("X-Aurialis-After-Peak-dBTP", peak.toFixed(2));
  }
  return new Response(result.audio.byteLength ? new Blob([result.audio], { type: "audio/wav" }) : result.json, { status: 200, headers });
}
