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

async function preflight(request: JobRequest, source: Blob, reference: Blob, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  const input = source.size + reference.size;
  if (input > MAX_INPUT_BYTES) throw new Error("The combined audio exceeds the 129 MiB local job limit. " + LOCAL_FALLBACK);
  const decoded = await decodedBytes(source) + await decodedBytes(reference);
  signal.throwIfAborted();
  // Conservative coexistence: original/canonical Blobs, live PCM/AudioBuffer,
  // transfer input, Go raw/decoded/render/encode and returned buffer/Blob.
  // Reference streams its output measurements and does not encode song-length WAVs.
  const estimate = 64 * MIB + input * 4 + decoded * (request.operation === "render" ? 7 : 4);
  if (estimate > memoryBudget()) throw new Error("This job exceeds the browser's conservative audio memory budget. " + LOCAL_FALLBACK);
}

let queue: Promise<void> = Promise.resolve();
let pending = 0;

function startWorker(request: JobRequest, source: ArrayBuffer, reference: ArrayBuffer, signal: AbortSignal, onProgress?: (progress: number, stage: string) => void): Promise<JobResult> {
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
    const deadline = setTimeout(() => { finish(undefined, new Error("Local audio processing exceeded its time limit. " + LOCAL_FALLBACK)); }, 130_000);
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
      if (data.kind !== "result" || !("json" in data) || typeof data.json !== "string" || new TextEncoder().encode(data.json).byteLength > MAX_METADATA_BYTES || !("audio" in data) || !(data.audio instanceof ArrayBuffer) || data.audio.byteLength > MAX_INPUT_BYTES) { finish(undefined, new Error("Invalid local audio result.")); return; }
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

async function execute(request: JobRequest, source = new Blob(), reference = new Blob(), signal = new AbortController().signal, onProgress?: (progress: number, stage: string) => void): Promise<JobResult> {
  signal.throwIfAborted();
  if (pending >= 2) throw new Error("Local audio processing is busy. Cancel the current job or try again shortly.");
  pending++;
  const run = async () => {
    signal.throwIfAborted();
    await preflight(request, source, reference, signal);
    onProgress?.(0, "Preparing local audio processing…");
    const input = await source.arrayBuffer(), comparison = await reference.arrayBuffer();
    signal.throwIfAborted();
    return startWorker(request, input, comparison, signal, onProgress);
  };
  const result = queue.then(run, run).finally(() => { pending--; });
  queue = result.then(() => undefined, () => undefined);
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
