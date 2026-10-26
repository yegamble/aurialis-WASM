import { engineParams } from "./engine-params";
export { engineParams } from "./engine-params";
import { deviceAudioRequest, usesBrowserAudio } from "./browser-jobs";
import type { ScriptV2 } from "./deep-mastering";
import type { AdvancedParams, ExportDelivery, MeasuredAudioMetrics, SourceIdentity } from "./types";

export interface StereoPCM {
  left: Float32Array<ArrayBuffer>;
  right: Float32Array<ArrayBuffer>;
  sampleRate: number;
}
interface GoRuntime {
  importObject: WebAssembly.Imports;
  run(instance: WebAssembly.Instance): Promise<void>;
}
declare global {
  interface Window {
    Go?: new () => GoRuntime;
    aurialisDSPReady?: boolean;
    aurialisDSPInit?: (rate: number) => boolean;
    aurialisDSPReset?: () => boolean;
    aurialisDSPSetParams?: (params: string) => boolean;
    aurialisDSPProcessBlock?: (
      left: Float32Array,
      right: Float32Array,
      outLeft: Float32Array,
      outRight: Float32Array,
    ) => number;
  }
}
let loading: Promise<void> | undefined;
async function loadEngine(): Promise<void> {
  if (window.aurialisDSPReady) return;
  loading ??= (async () => {
    if (!window.Go)
      await new Promise<void>((resolve, reject) => {
        const script = document.createElement("script");
        script.src = "/wasm/wasm_exec.js";
        script.onload = () => {
          resolve();
        };
        script.onerror = () => {
          reject(
            new Error("The audio engine could not load. Reload to retry."),
          );
        };
        document.head.append(script);
      });
    if (!window.Go) throw new Error("Go audio runtime unavailable.");
    const go = new window.Go();
    const response = await fetch("/wasm/aurialis-dsp.wasm");
    if (!response.ok)
      throw new Error("The shared audio engine is unavailable.");
    const result = await WebAssembly.instantiate(
      await response.arrayBuffer(),
      go.importObject,
    );
    void go.run(result.instance).catch(() => {
      loading = undefined;
    });
    if (!window.aurialisDSPReady)
      throw new Error("The shared audio engine failed to initialize.");
  })().catch((error: unknown) => {
    loading = undefined;
    throw error;
  });
  return loading;
}
let engineQueue: Promise<unknown> = Promise.resolve();

async function audioRequest(
  data: FormData,
  signal?: AbortSignal,
  json = false,
): Promise<Response> {
  signal?.throwIfAborted();
  try {
    return await deviceAudioRequest("/api/master/render", {
      method: "POST",
      body: data,
      ...(json ? { headers: { Accept: "application/json" } } : {}),
      ...(signal ? { signal } : {}),
    });
  } catch (error: unknown) {
    signal?.throwIfAborted();
    if (usesBrowserAudio()) throw error;
    const address = typeof location === "undefined" ? "this address" : location.origin;
    throw new Error(
      `Could not reach the local audio server at ${address}. Check that Aurialis is running, then try again. If your browser reports a blocked local connection, check this site's local-network permission.`,
      { cause: error },
    );
  }
}

async function audioError(response: Response, fallback: string): Promise<Error> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return new Error(`${fallback} (HTTP ${String(response.status)}).`);
  }
  if (typeof body === "object" && body !== null) {
    if ("detail" in body && typeof body.detail === "string") return new Error(body.detail);
    if ("message" in body && typeof body.message === "string") return new Error(body.message);
    if ("error" in body && typeof body.error === "string") return new Error(body.error);
  }
  return new Error(fallback);
}

async function readAudioResponse<T>(read: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  try {
    const result = await read();
    signal?.throwIfAborted();
    return result;
  } catch (error: unknown) {
    signal?.throwIfAborted();
    throw new Error(usesBrowserAudio()
      ? "The audio response was interrupted or unreadable. Try again."
      : "The local server's audio response was interrupted or unreadable. Try again, or restart the Aurialis server.", { cause: error });
  }
}

export function processPreview(
  source: StereoPCM,
  advanced: AdvancedParams,
  signal?: AbortSignal,
): Promise<StereoPCM> {
  const run = async () => {
    const checkCancellation = () => {
      if (signal?.aborted) throw new Error("Preview was cancelled.");
    };
    checkCancellation();
    await loadEngine();
    checkCancellation();
    if (
      !window.aurialisDSPInit?.(source.sampleRate) ||
      !window.aurialisDSPSetParams?.(JSON.stringify(engineParams(advanced))) ||
      !window.aurialisDSPReset?.()
    )
      throw new Error("The engine rejected these settings.");
    const left = new Float32Array(source.left.length),
      right = new Float32Array(source.right.length);
    for (let offset = 0; offset < left.length; offset += 4096) {
      checkCancellation();
      const end = Math.min(left.length, offset + 4096);
      const count = window.aurialisDSPProcessBlock?.(
        source.left.subarray(offset, end),
        source.right.subarray(offset, end),
        left.subarray(offset, end),
        right.subarray(offset, end),
      );
      if (count !== end - offset)
        throw new Error("The engine returned incomplete audio.");
      if (offset % 16384 === 0)
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    checkCancellation();
    return { left, right, sampleRate: source.sampleRate };
  };
  const result = engineQueue.then(run, run);
  // Serialize work without retaining the last completed song-length PCM.
  engineQueue = result.then(() => undefined, () => undefined);
  return result;
}
function appendDelivery(data: FormData, delivery: ExportDelivery | undefined): void {
  if (delivery?.sampleRate !== undefined) data.append("sampleRate", String(delivery.sampleRate));
  if (delivery?.dither !== undefined) data.append("dither", delivery.dither);
}
type DeliveredWAV = {
  blob: Blob;
  /** Go's X-Aurialis-After-Peak-dBTP: measured on the delivered audio, after any conversion. */
  truePeakDbtp: number | null;
};
async function renderWAV(data: FormData, failure: string, signal?: AbortSignal): Promise<DeliveredWAV> {
  const response = await audioRequest(data, signal);
  if (!response.ok) throw await audioError(response, failure);
  const blob = await readAudioResponse(() => response.blob(), signal);
  const header = response.headers.get("X-Aurialis-After-Peak-dBTP");
  const peak = header === null || header.trim() === "" ? Number.NaN : Number(header);
  return { blob, truePeakDbtp: Number.isFinite(peak) ? peak : null };
}
function renderForm(file: Blob, field: "params" | "script", value: object, bitDepth: 16 | 24 | 32, delivery?: ExportDelivery): FormData {
  const data = new FormData();
  data.append("file", file, "source.wav");
  data.append(field, JSON.stringify(value));
  data.append("bitDepth", String(bitDepth));
  appendDelivery(data, delivery);
  return data;
}
const RENDER_FAILURE = "Audio processing failed. Please try again.";
const SCRIPT_FAILURE = "The applied script could not be rendered. Restore its matching source and retry.";
export async function serverRender(
  file: Blob,
  params: object,
  bitDepth: 16 | 24 | 32,
  signal?: AbortSignal,
): Promise<Blob> {
  signal?.throwIfAborted();
  return (await renderWAV(renderForm(file, "params", params, bitDepth), RENDER_FAILURE, signal)).blob;
}
export async function serverRenderScript(file: Blob, script: ScriptV2, bitDepth: 16 | 24 | 32, signal?: AbortSignal): Promise<Blob> {
  signal?.throwIfAborted();
  return (await renderWAV(renderForm(file, "script", script, bitDepth), SCRIPT_FAILURE, signal)).blob;
}
/** A delivery export: the WAV plus its delivered true peak when the engine reports one. */
export async function renderDelivery(file: Blob, render: { params: object } | { script: ScriptV2 }, bitDepth: 16 | 24 | 32, delivery: ExportDelivery, signal?: AbortSignal): Promise<DeliveredWAV> {
  signal?.throwIfAborted();
  return "script" in render
    ? renderWAV(renderForm(file, "script", render.script, bitDepth, delivery), SCRIPT_FAILURE, signal)
    : renderWAV(renderForm(file, "params", render.params, bitDepth, delivery), RENDER_FAILURE, signal);
}
export async function readCanonicalWAV(blob: Blob): Promise<StereoPCM> {
  const data = new DataView(await blob.arrayBuffer());
  const text = (start: number) =>
    String.fromCharCode(
      ...Array.from({ length: 4 }, (_, i) => data.getUint8(start + i)),
    );
  if (data.byteLength < 44 || text(0) !== "RIFF" || text(8) !== "WAVE")
    throw new Error("Invalid WAV source.");
  let channels = 0,
    sampleRate = 0,
    bits = 0,
    format = 0,
    start = 0,
    length = 0;
  for (let offset = 12; offset + 8 <= data.byteLength; ) {
    const size = data.getUint32(offset + 4, true);
    if (offset + 8 + size > data.byteLength)
      throw new Error("Incomplete WAV source.");
    if (text(offset) === "fmt ") {
      if (size < 16) throw new Error("Invalid WAV format.");
      format = data.getUint16(offset + 8, true);
      channels = data.getUint16(offset + 10, true);
      sampleRate = data.getUint32(offset + 12, true);
      bits = data.getUint16(offset + 22, true);
    }
    if (text(offset) === "data") {
      start = offset + 8;
      length = size;
    }
    offset += 8 + size + (size % 2);
  }
  if (
    format !== 3 ||
    bits !== 32 ||
    channels !== 2 ||
    sampleRate <= 0 ||
    length === 0 ||
    length % 8 !== 0
  )
    throw new Error("Expected canonical stereo float WAV.");
  const left = new Float32Array(length / 8),
    right = new Float32Array(length / 8);
  for (let i = 0; i < left.length; i++) {
    // Numeric index is bounded by this newly allocated Float32Array.
    // eslint-disable-next-line security/detect-object-injection
    left[i] = data.getFloat32(start + i * 8, true);
    // Numeric index is bounded by this newly allocated Float32Array.
    // eslint-disable-next-line security/detect-object-injection
    right[i] = data.getFloat32(start + i * 8 + 4, true);
  }
  return { left, right, sampleRate };
}
export function previewWAV(pcm: StereoPCM): Blob {
  const data = new ArrayBuffer(44 + pcm.left.length * 8),
    view = new DataView(data);
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++)
      view.setUint8(offset + i, value.charCodeAt(i));
  };
  text(0, "RIFF");
  view.setUint32(4, data.byteLength - 8, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 3, true);
  view.setUint16(22, 2, true);
  view.setUint32(24, pcm.sampleRate, true);
  view.setUint32(28, pcm.sampleRate * 8, true);
  view.setUint16(32, 8, true);
  view.setUint16(34, 32, true);
  text(36, "data");
  view.setUint32(40, pcm.left.length * 8, true);
  for (let i = 0; i < pcm.left.length; i++) {
    view.setFloat32(44 + i * 8, pcm.left.at(i) ?? 0, true);
    view.setFloat32(48 + i * 8, pcm.right.at(i) ?? 0, true);
  }
  return new Blob([data], { type: "audio/wav" });
}
export function sourcePeaks(pcm: StereoPCM): number[] {
  const count = Math.min(2048, pcm.left.length);
  return Array.from({ length: count }, (_, index) => {
    let peak = 0;
    for (
      let i = Math.floor(index * pcm.left.length / count);
      i < Math.floor((index + 1) * pcm.left.length / count);
      i++
    )
      peak = Math.max(
        peak,
        Math.abs(pcm.left.at(i) ?? 0),
        Math.abs(pcm.right.at(i) ?? 0),
      );
    return peak;
  });
}

type AudioMeasurement = {
  sampleRate: number;
  frames: number;
  duration: number;
  sourceIdentity?: SourceIdentity;
  beforeMetrics: MeasuredAudioMetrics;
  afterMetrics: MeasuredAudioMetrics;
};

/** Receive the reconstructed source and its measurements without uploading it twice. */
export async function importAudio(file: Blob, signal?: AbortSignal): Promise<{ canonical: Blob; measurement: AudioMeasurement }> {
  const form = new FormData();
  form.append("file", file, "source.wav");
  form.append("params", JSON.stringify({ bypass: true }));
  form.append("bitDepth", "32");
  const response = await audioRequest(form, signal);
  if (!response.ok) throw await audioError(response, "Audio import failed.");
  const header = response.headers.get("X-Aurialis-Source-Metrics");
  let measurement: AudioMeasurement;
  try {
    if (!header || header.length > 4096) throw new Error("The local audio engine returned incomplete source measurements. Reload Aurialis and try again.");
    let body: unknown;
    try { body = JSON.parse(header) as unknown; }
    catch { throw new Error("The local audio engine returned invalid source measurements."); }
    measurement = audioMeasurement(body);
  } catch (error) {
    await response.body?.cancel().catch(() => undefined);
    throw error;
  }
  const canonical = await readAudioResponse(() => response.blob(), signal);
  if (canonical.size !== 44 + measurement.frames * 8)
    throw new Error("The reconstructed audio transfer was incomplete. Try importing the source again.");
  return { canonical, measurement };
}

function metricObject(value: unknown): MeasuredAudioMetrics {
  if (typeof value !== "object" || value === null)
    throw new Error("The audio engine returned invalid audio measurements.");
  const number = (key: keyof MeasuredAudioMetrics): number => {
    // Keys are the fixed measurement schema below, never user-provided keys.
    // eslint-disable-next-line security/detect-object-injection
    const result: unknown = (value as Record<string, unknown>)[key];
    if (typeof result !== "number" || !Number.isFinite(result))
      throw new Error("The audio engine returned incomplete audio measurements.");
    return result;
  };
  return {
    integratedLufs: number("integratedLufs"),
    shortTermLufs: number("shortTermLufs"),
    truePeakDbtp: number("truePeakDbtp"),
    samplePeakDbfs: number("samplePeakDbfs"),
    dynamicRangeDb: number("dynamicRangeDb"),
    correlation: number("correlation"),
    lowBassCorrelation: number("lowBassCorrelation"),
    dcLeftDbfs: number("dcLeftDbfs"),
    dcRightDbfs: number("dcRightDbfs"),
    clippingSamples: number("clippingSamples"),
    gainReductionDb: number("gainReductionDb"),
  };
}

export async function measureAudio(
  file: Blob,
  params: object = { bypass: true },
  signal?: AbortSignal,
): Promise<AudioMeasurement> {
  const form = new FormData();
  form.append("file", file, "source.wav");
  form.append("params", JSON.stringify(params));
  form.append("format", "json");
  const response = await audioRequest(form, signal, true);
  if (!response.ok) throw await audioError(response, "Audio measurement failed.");
  const body: unknown = await readAudioResponse(() => response.json() as Promise<unknown>, signal);
  return audioMeasurement(body);
}

function audioMeasurement(body: unknown): AudioMeasurement {
  if (typeof body !== "object" || body === null || !("sampleRate" in body)
    || !("frames" in body) || !("duration" in body)
    || !("beforeMetrics" in body) || !("afterMetrics" in body)
    || typeof body.sampleRate !== "number" || !Number.isFinite(body.sampleRate)
    || body.sampleRate < 8000 || body.sampleRate > 192000
    || typeof body.frames !== "number" || !Number.isSafeInteger(body.frames) || body.frames < 1
    || typeof body.duration !== "number" || !Number.isFinite(body.duration) || body.duration <= 0
    || Math.abs(body.duration - body.frames / body.sampleRate) > 0.001)
    throw new Error("The audio engine returned invalid audio measurements.");
  return {
    sampleRate: body.sampleRate,
    frames: body.frames,
    duration: body.duration,
    ...("sourceIdentity" in body ? { sourceIdentity: sourceIdentity(body.sourceIdentity, body.sampleRate, body.frames) } : {}),
    beforeMetrics: metricObject(body.beforeMetrics),
    afterMetrics: metricObject(body.afterMetrics),
  };
}

function sourceIdentity(value: unknown, rate: number, frames: number): SourceIdentity {
  if (typeof value !== "object" || value === null || !("pcmHash" in value) || !("sampleRate" in value) || !("frames" in value) || typeof value.pcmHash !== "string" || !/^[a-f0-9]{64}$/u.test(value.pcmHash) || value.sampleRate !== rate || value.frames !== frames)
    throw new Error("The audio engine returned an invalid source identity.");
  return { pcmHash: value.pcmHash, sampleRate: rate, frames };
}

// range/dynamics are legacy display slots for measured crest factor, not LRA.
export function trackMetrics(metrics: MeasuredAudioMetrics) {
  return {
    lufs: metrics.integratedLufs,
    peak: metrics.truePeakDbtp,
    range: metrics.dynamicRangeDb,
    dynamics: metrics.dynamicRangeDb,
    correlation: metrics.correlation,
  };
}

// Explicit Simple-mode automatic gain. Advanced rendering never calls this.
// Fail rather than claiming a target when nonlinear processing or available
// sample-peak limiting cannot meet both loudness and the measured peak ceiling.
export async function normalizeSimpleAudio(
  file: Blob,
  settings: AdvancedParams,
  targetLufs: number,
  signal?: AbortSignal,
): Promise<AdvancedParams> {
  if (!Number.isFinite(targetLufs) || targetLufs < -36 || targetLufs > -5)
    throw new Error("Choose a loudness target between −36 and −5 LUFS.");
  let candidate = structuredClone(settings);
  let previous: { input: number; loudness: number } | undefined;
  let lower = -36;
  let upper = 36;
  for (let attempt = 0; attempt < 8; attempt++) {
    signal?.throwIfAborted();
    const { afterMetrics } = await measureAudio(file, engineParams(candidate), signal);
    signal?.throwIfAborted();
    const difference = targetLufs - afterMetrics.integratedLufs;
    if (afterMetrics.integratedLufs <= -69.9)
      throw new Error("The source is too quiet to normalize reliably.");
    if (Math.abs(difference) <= 0.2) {
      if (afterMetrics.truePeakDbtp > candidate.limiter.ceiling + 0.2)
        throw new Error("This loudness target exceeds the measured peak ceiling. Choose a quieter target.");
      return candidate;
    }
    // Input gain precedes compression and saturation, so one dB of input does
    // not necessarily produce one LU of output. Estimate that response from
    // measured renders, retaining a bracket when the slope changes or flattens.
    if (difference > 0) lower = Math.max(lower, candidate.input);
    else upper = Math.min(upper, candidate.input);
    let nextInput = candidate.input + difference;
    if (previous) {
      const slope = (afterMetrics.integratedLufs - previous.loudness) / (candidate.input - previous.input);
      nextInput = Number.isFinite(slope) && slope > 0.01
        ? candidate.input + difference / slope
        : (lower + upper) / 2;
      if (nextInput <= lower || nextInput >= upper) nextInput = (lower + upper) / 2;
    }
    nextInput = Math.max(-36, Math.min(36, nextInput));
    if (Math.abs(nextInput - candidate.input) < 0.001) break;
    previous = { input: candidate.input, loudness: afterMetrics.integratedLufs };
    candidate = { ...candidate, input: nextInput };
  }
  throw new Error("This loudness target could not be reached safely. Choose a quieter target or adjust dynamics.");
}
