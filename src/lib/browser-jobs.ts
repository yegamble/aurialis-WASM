import { assertEncodedWAVLayout, encodedWAVBytes, type EncodedLayout } from "./encoded-layout";
import { injectedProcessingIdentity } from "./processing-identity";

const OFFLINE_ABI = "1.0";
const MIB = 1024 * 1024;
const MAX_INPUT_BYTES = 129 * MIB;
const MAX_METADATA_BYTES = 2 * MIB + 128 * 1024;
const MAX_FRAMES = 16_777_216;
const LOCAL_FALLBACK = "Use the local Aurialis app on this device for this file. Your audio will not be uploaded.";

interface JobRequest {
  operation: "render" | "features" | "deep" | "reference" | "compile";
  params?: string;
  script?: string;
  profile?: string;
  bitDepth?: number;
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
  if (typeof memory === "number" && Number.isFinite(memory) && memory >= 8) return 1024 * MIB;
  return 512 * MIB;
}

let reservedResidentBytes = 0;
let activeJobBytes = 0;
let activeJobOwner: symbol | null = null;

/** Own the exact bytes retained outside a job, such as an album prefix or reviewed WAV. */
export function reserveBrowserAudioMemory(initialBytes = 0): Readonly<{ update: (bytes: number) => void; dispose: () => void }> {
  return residentAudioMemory(initialBytes);
}
function residentAudioMemory(initialBytes: number, replacing?: symbol): ReturnType<typeof reserveBrowserAudioMemory> {
  let held = 0;
  let disposed = false;
  const update = (bytes: number, jobOwner?: symbol) => {
    const budget = memoryBudget(); // Read external device facts before taking the latest accounting snapshot.
    if (disposed) throw new Error("This audio memory reservation has been released.");
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("Audio memory reservations require nonnegative safe byte counts.");
    const total = reservedResidentBytes - held + bytes;
    if (!Number.isSafeInteger(total) || total < 0) throw new Error("Audio memory reservations exceed the safe byte limit.");
    if (jobOwner !== undefined && jobOwner !== activeJobOwner) throw new Error("The audio job ownership changed before output handoff.");
    if (total + (jobOwner !== undefined ? 64 * MIB : Math.max(64 * MIB, activeJobBytes)) > budget) throw new Error("Retained audio exceeds the browser's conservative memory budget. " + LOCAL_FALLBACK);
    reservedResidentBytes = total;
    held = bytes;
    if (jobOwner !== undefined) { activeJobOwner = null; activeJobBytes = 0; }
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    reservedResidentBytes -= held;
    held = 0;
  };
  const owner = Object.freeze({ update: (bytes: number) => { update(bytes); }, dispose });
  update(initialBytes, replacing);
  return owner;
}

async function decodedBytes(blob: Blob): Promise<number> {
  if (blob.size === 0) return 0;
  const fallback = Math.min(MAX_FRAMES * 8, blob.size * 8);
  const data = new DataView(await blob.slice(0, 65_536).arrayBuffer());
  const id = (offset: number) => String.fromCharCode(...Array.from({ length: 4 }, (_, i) => data.getUint8(offset + i)));
  // Capacity only. Go CDR remains the authoritative format/container validator.
  if (data.byteLength < 12 || id(0) !== "RIFF" || id(8) !== "WAVE") return fallback;
  let align = 0;
  for (let offset = 12; offset + 8 <= data.byteLength;) {
    const size = data.getUint32(offset + 4, true);
    if (id(offset) === "data") {
      const frames = align > 0 ? Math.floor(size / align) : MAX_FRAMES;
      if (frames < 1 || frames > MAX_FRAMES) throw new Error("This WAV exceeds the local frame limit. " + LOCAL_FALLBACK);
      return frames * 8;
    }
    if (offset + 8 + size > data.byteLength) return fallback;
    if (id(offset) === "fmt " && size >= 16) align = data.getUint16(offset + 20, true);
    offset += 8 + size + size % 2;
  }
  return fallback;
}

async function preflight(request: JobRequest, source: Blob, reference: Blob, signal: AbortSignal, jobOwner: symbol): Promise<void> {
  signal.throwIfAborted();
  const input = source.size + reference.size;
  if (input > MAX_INPUT_BYTES) throw new Error("The combined audio exceeds the 129 MiB local job limit. " + LOCAL_FALLBACK);
  const decoded = await decodedBytes(source) + await decodedBytes(reference);
  signal.throwIfAborted();
  // Conservative coexistence: original/canonical Blobs, live PCM/AudioBuffer,
  // transfer input, Go raw/decoded/render/encode and returned buffer/Blob.
  // Reference streams its output measurements and does not encode song-length WAVs.
  const estimate = 64 * MIB + input * 4 + decoded * (request.operation === "render" ? 7 : 4);
  const budget = memoryBudget();
  if (activeJobOwner !== null) throw new Error("The local audio processor already owns an active job.");
  if (estimate + reservedResidentBytes > budget) throw new Error("This job exceeds the browser's conservative audio memory budget. " + LOCAL_FALLBACK);
  activeJobBytes = estimate; activeJobOwner = jobOwner;
}

let queue: Promise<void> = Promise.resolve();
let pending = 0;

function startWorker(request: JobRequest, source: ArrayBuffer, reference: ArrayBuffer, signal: AbortSignal, onProgress?: (progress: number, stage: string) => void, owned = false): Promise<JobResult> {
  return new Promise<JobResult>((resolve, reject) => {
    signal.throwIfAborted();
    const identity = injectedProcessingIdentity();
    const processing = identity?.target === "browser" ? { fingerprint: identity.fingerprint, offlineSha256: identity.offlineSha256, offlineBytes: identity.offlineBytes } : null;
    const worker = new Worker("/offline-job-worker.js" + (processing ? `?processing=${processing.fingerprint}` : ""));
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
    const deadline = setTimeout(() => { finish(undefined, new Error("Local audio processing exceeded its time limit. " + LOCAL_FALLBACK)); }, 130_000);
    signal.addEventListener("abort", abort, { once: true });
    worker.onerror = () => { finish(undefined, new Error("Audio processing stopped unexpectedly in this browser. " + LOCAL_FALLBACK)); };
    worker.onmessageerror = () => { finish(undefined, new Error("The local audio result was unreadable.")); };
    worker.onmessage = (event: MessageEvent<unknown>) => {
      if (settled) return;
      const data = event.data;
      if (typeof data !== "object" || data === null || !("id" in data) || data.id !== id || !("kind" in data)) { finish(undefined, new Error("Invalid local audio worker identity.")); return; }
      if (!("abi" in data) || data.abi !== OFFLINE_ABI) { finish(undefined, new Error("The local audio engine version is incompatible. Reload Aurialis to retry.")); return; }
      if (processing && (!("processingBuild" in data) || data.processingBuild !== processing.fingerprint)) { finish(undefined, new Error("The local worker uses a different processing build. Reload to retry.")); return; }
      if (data.kind === "progress") {
        if (!("progress" in data) || typeof data.progress !== "number" || !Number.isFinite(data.progress) || !("stage" in data) || typeof data.stage !== "string" || data.stage.length > 1024) { finish(undefined, new Error("Invalid local audio progress.")); return; }
        try { onProgress?.(Math.max(0, Math.min(100, data.progress)), data.stage); }
        catch { finish(undefined, new Error("Local audio progress handling stopped.")); }
        return;
      }
      if (data.kind === "error") { finish(undefined, new Error("error" in data && typeof data.error === "string" ? data.error.slice(0, 1024) : "Local audio processing failed.")); return; }
      if (data.kind !== "result" || !("json" in data) || typeof data.json !== "string" || new TextEncoder().encode(data.json).byteLength > MAX_METADATA_BYTES || !("audio" in data) || !(data.audio instanceof ArrayBuffer) || data.audio.byteLength > MAX_INPUT_BYTES) { finish(undefined, new Error("Invalid local audio result.")); return; }
      const result = { json: data.json, audio: data.audio };
      if (owned) { data.audio = new ArrayBuffer(0); data.json = ""; }
      finish(result);
    };
    const metadata = JSON.stringify(request);
    if (new TextEncoder().encode(metadata).byteLength > MAX_METADATA_BYTES) { finish(undefined, new Error("Local audio metadata exceeds its limit.")); return; }
    try { worker.postMessage({ abi: OFFLINE_ABI, id, metadata, source, reference, processing }, [source, reference]); }
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

export interface OwnedAudioResult { readonly blob: Blob; readonly owner: ReturnType<typeof reserveBrowserAudioMemory>; readonly dispose: () => void }
function renderMetadata(json: string): void {
  if (new TextEncoder().encode(json).byteLength > MAX_METADATA_BYTES) throw new Error("The local render metadata exceeds its limit.");
  const value: unknown = JSON.parse(json);
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("The local render metadata is invalid.");
}
function ownedJobResult(result: JobResult, layout: EncodedLayout, jobOwner: symbol, signal: AbortSignal): OwnedAudioResult {
  let audio: ArrayBuffer | null = result.audio;
  try {
    signal.throwIfAborted(); renderMetadata(result.json); assertEncodedWAVLayout(audio, layout);
    // The unchanged worker estimate covers the transferred buffer and immutable Blob copy together.
    const blob = new Blob([audio], { type: "audio/wav" });
    audio = null; result.audio = new ArrayBuffer(0); result.json = ""; signal.throwIfAborted();
    const owner = residentAudioMemory(blob.size, jobOwner);
    return Object.freeze({ blob, owner, dispose: owner.dispose });
  } finally { audio = null; result.audio = new ArrayBuffer(0); result.json = ""; }
}
function execute(request: JobRequest, source: Blob, reference: Blob, signal: AbortSignal, onProgress: ((progress: number, stage: string) => void) | undefined, layout: EncodedLayout): Promise<OwnedAudioResult>;
function execute(request: JobRequest, source?: Blob, reference?: Blob, signal?: AbortSignal, onProgress?: (progress: number, stage: string) => void): Promise<JobResult>;
async function execute(request: JobRequest, source = new Blob(), reference = new Blob(), signal = new AbortController().signal, onProgress?: (progress: number, stage: string) => void, layout?: EncodedLayout): Promise<JobResult | OwnedAudioResult> {
  signal.throwIfAborted();
  if (pending >= 2) throw new Error("Local audio processing is busy. Cancel the current job or try again shortly.");
  const inputBytes = source.size + reference.size;
  if (inputBytes > MAX_INPUT_BYTES) throw new Error("The combined audio exceeds the 129 MiB local job limit. " + LOCAL_FALLBACK);
  const inputMemory = reserveBrowserAudioMemory(inputBytes), jobOwner = Symbol("audio job");
  pending++;
  const run = async () => {
    signal.throwIfAborted();
    let input: ArrayBuffer | null = null, comparison: ArrayBuffer | null = null, result: JobResult | null = null;
    try {
      await preflight(request, source, reference, signal, jobOwner);
      onProgress?.(0, "Preparing local audio processing…");
      input = await source.arrayBuffer(); comparison = await reference.arrayBuffer(); signal.throwIfAborted();
      result = await startWorker(request, input, comparison, signal, onProgress, layout !== undefined);
      input = null; comparison = null;
      if (layout) return ownedJobResult(result, layout, jobOwner, signal);
      return result;
    } finally {
      input = null; comparison = null;
      if (layout && result) { result.audio = new ArrayBuffer(0); result.json = ""; result = null; }
      if (activeJobOwner === jobOwner) { activeJobOwner = null; activeJobBytes = 0; }
    }
  };
  const result = queue.then(run, run).finally(() => { pending--; inputMemory.dispose(); });
  queue = result.then(() => undefined, () => undefined);
  if (!layout) return awaitCancellation(result, signal);
  // Owned callers wait for actual queue/read settlement; late cancellation cannot orphan an output lease.
  const completed = await result;
  if (signal.aborted) { if ("owner" in completed) completed.dispose(); signal.throwIfAborted(); }
  return completed;
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
    case "/api/master/render": request = { operation: "render" }; allowed = ["file", "params", "script", "profile", "bitDepth", "format"]; break;
    case "/api/analyze/features": request = { operation: "features" }; allowed = ["file"]; break;
    case "/api/analyze/deep": request = { operation: "deep" }; allowed = ["file", "profile", "scriptVersion"]; break;
    case "/api/analyze/reference": request = { operation: "reference" }; allowed = ["source", "reference", "params", "options"]; break;
    default: throw new Error("This audio operation is unavailable in the browser. " + LOCAL_FALLBACK);
  }
  for (const key of fields.keys()) if (!allowed.includes(key)) throw new Error("Unsupported local audio field.");
  const text = (key: string) => { const value = fields.get(key); if (value !== undefined && typeof value !== "string") throw new Error("Invalid local audio field."); return value; };
  const params = text("params"), script = text("script"), profile = text("profile"), format = text("format"), options = text("options"), scriptVersion = text("scriptVersion"), bitDepth = text("bitDepth");
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
  const source = fields.get(request.operation === "reference" ? "source" : "file"), reference = fields.get("reference");
  if (!(source instanceof Blob) || (reference !== undefined && !(reference instanceof Blob))) throw new Error("Missing local audio source.");
  return { request, source, reference: reference ?? new Blob() };
}

/** Same contract as the device-local HTTP transport, implemented without network audio on websites. */
export async function deviceAudioRequest(path: string, init: RequestInit, onProgress?: (progress: number, stage: string) => void): Promise<Response> {
  const url = new URL(path, typeof location === "undefined" ? "https://local.invalid" : location.origin);
  if (!path.startsWith("/api/") || path.startsWith("//") || url.origin !== (typeof location === "undefined" ? "https://local.invalid" : location.origin)) throw new Error("Audio requests must stay on this device.");
  if (!usesBrowserAudio()) return fetch(path, init);
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
  const result = await execute(request, source, reference, init.signal ?? undefined, onProgress);
  const headers = new Headers({ "Content-Type": result.audio.byteLength ? "audio/wav" : "application/json", "Cache-Control": "no-store" });
  if (result.audio.byteLength) headers.set("X-Aurialis-Source-Metrics", result.json);
  return new Response(result.audio.byteLength ? new Blob([result.audio], { type: "audio/wav" }) : result.json, { status: 200, headers });
}

/** Internal owned binary path. Callers adopt this same owner before another audio phase. */
export async function deviceOwnedAudioRequest(path: string, init: RequestInit, layout: EncodedLayout): Promise<OwnedAudioResult> {
  const expectedBytes = encodedWAVBytes(layout), signal = init.signal ?? new AbortController().signal;
  signal.throwIfAborted();
  const url = new URL(path, typeof location === "undefined" ? "https://local.invalid" : location.origin);
  if (url.pathname !== "/api/master/render" || url.search || path.startsWith("//") || !path.startsWith("/api/")
    || url.origin !== (typeof location === "undefined" ? "https://local.invalid" : location.origin) || init.method !== "POST" || !(init.body instanceof FormData)) throw new Error("Owned audio requests must render on this device.");
  const { request, source, reference } = formRequest(path, init.body);
  if (request.bitDepth !== layout.bitDepth || request.format === "json" || new Headers(init.headers).get("Accept")?.includes("application/json")) throw new Error("The owned render does not match its requested encoded layout.");
  if (usesBrowserAudio()) return execute(request, source, reference, signal, undefined, layout);
  const nativeSignal = AbortSignal.any([signal, AbortSignal.timeout(65_000)]);
  const owner = reserveBrowserAudioMemory(expectedBytes * 3);
  let response: Response | null = null, bytes: Uint8Array<ArrayBuffer> | null = null;
  try {
    response = await fetch(path, { ...init, signal: nativeSignal }); nativeSignal.throwIfAborted();
    const length = response.headers.get("Content-Length"), metadata = response.headers.get("X-Aurialis-Source-Metrics");
    if (!response.ok || !response.body || !response.headers.get("Content-Type")?.startsWith("audio/wav")
      || length !== null && (!/^\d+$/u.test(length) || Number(length) !== expectedBytes)) {
      await response.body?.cancel(); throw new Error("The native render has an unexpected response type or length.");
    }
    if (metadata !== null) renderMetadata(metadata);
    const cancellation: { pending: Promise<void> | null } = { pending: null };
    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
    const cancel = () => { if (reader) { cancellation.pending ??= reader.cancel(nativeSignal.reason); void cancellation.pending.catch(() => undefined); } };
    try {
      reader = response.body.getReader();
      nativeSignal.addEventListener("abort", cancel, { once: true });
      nativeSignal.throwIfAborted();
      bytes = new Uint8Array(expectedBytes); let received = 0;
      for (;;) {
        const chunk = await reader.read(); nativeSignal.throwIfAborted();
        if (chunk.done) break;
        if (chunk.value.byteLength === 0 || received + chunk.value.byteLength > expectedBytes) throw new Error("The native render has an unexpected length.");
        bytes.set(chunk.value, received); received += chunk.value.byteLength;
      }
      if (received !== expectedBytes) throw new Error("The native render has an unexpected length.");
    } finally {
      nativeSignal.removeEventListener("abort", cancel);
      if (reader) { try { await (cancellation.pending ?? reader.cancel()); } finally { reader.releaseLock(); } }
    }
    nativeSignal.throwIfAborted(); assertEncodedWAVLayout(bytes.buffer, layout);
    const blob = new Blob([bytes], { type: "audio/wav" });
    bytes = null; response = null; nativeSignal.throwIfAborted(); owner.update(blob.size); nativeSignal.throwIfAborted();
    return Object.freeze({ blob, owner, dispose: owner.dispose });
  } catch (cause) {
    if (response?.body && !response.body.locked) await response.body.cancel().catch(() => undefined);
    bytes = null; response = null; owner.dispose(); throw cause;
  }
}
