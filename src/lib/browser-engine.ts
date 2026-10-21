import type { AdvancedParams } from "./types";

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
export function engineParams(advanced: AdvancedParams) {
  return {
    bypass: false,
    abOriginal: false,
    loudnessMatchAb: false,
    inputGainDb: advanced.input,
    eqEnabled: advanced.eqEnabled,
    bands: advanced.eqBands.map((band) => ({
      freqHz: band.freqHz,
      gainDb: band.gainDb,
      q: band.q,
      type:
        band.type === "lowshelf"
          ? "low_shelf"
          : band.type === "highshelf"
            ? "high_shelf"
            : "peaking",
      enabled: band.enabled,
    })),
    compressor: {
      enabled: advanced.compressor.enabled,
      thresholdDb: advanced.compressor.threshold,
      ratio: advanced.compressor.ratio,
      attackMs: advanced.compressor.attack,
      releaseMs: advanced.compressor.release,
      kneeDb: advanced.compressor.knee,
      makeupDb: advanced.compressor.makeup,
      sidechainHpfHz: 90,
      topology: "optical",
    },
    saturation: {
      enabled: advanced.saturationModule.enabled,
      amount: advanced.saturationModule.drive,
      character: advanced.saturationModule.character,
    },
    stereo: {
      enabled: advanced.stereo.enabled,
      widthPct: advanced.stereo.width,
      monoBass: advanced.stereo.monoBass,
      crossoverHz: 110,
    },
    limiter: {
      enabled: advanced.limiter.enabled,
      ceilingDbtp: advanced.limiter.ceiling,
      targetLufs: advanced.limiter.targetLufs,
      releaseMs: advanced.limiter.release,
      truePeak: false,
    },
    repair: { enabled: false, deEssDb: 0, transientDb: 0, deClip: false },
    ditherBits: 0,
  };
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
  engineQueue = result.catch(() => undefined);
  return result;
}
export async function serverRender(
  file: Blob,
  params: object,
  bitDepth: 16 | 24 | 32,
): Promise<Blob> {
  const data = new FormData();
  data.append("file", file, "source.wav");
  data.append("params", JSON.stringify(params));
  data.append("bitDepth", String(bitDepth));
  const response = await fetch("/api/master/render", {
    method: "POST",
    body: data,
  });
  if (!response.ok) {
    const body: unknown = await response.json();
    let message = "Audio processing failed. Please try again.";
    if (typeof body === "object" && body !== null) {
      if ("message" in body && typeof body.message === "string")
        message = body.message;
      else if ("error" in body && typeof body.error === "string")
        message = body.error;
    }
    throw new Error(message);
  }
  return response.blob();
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
export function measuredLevels(pcm: StereoPCM): {
  peak: string;
  rms: string;
  crest: string;
} {
  let peak = 0,
    sum = 0;
  for (let i = 0; i < pcm.left.length; i++) {
    const l = pcm.left.at(i) ?? 0,
      r = pcm.right.at(i) ?? 0;
    peak = Math.max(peak, Math.abs(l), Math.abs(r));
    sum += l * l + r * r;
  }
  const rms = Math.sqrt(sum / (pcm.left.length * 2));
  const db = (n: number) => (n > 0 ? (20 * Math.log10(n)).toFixed(1) : "−∞");
  return {
    peak: db(peak),
    rms: db(rms),
    crest: rms > 0 ? (20 * Math.log10(peak / rms)).toFixed(1) : "—",
  };
}
export function sourcePeaks(pcm: StereoPCM): number[] {
  const size = Math.max(1, Math.ceil(pcm.left.length / 96));
  return Array.from({ length: 96 }, (_, index) => {
    let peak = 0;
    for (
      let i = index * size;
      i < Math.min((index + 1) * size, pcm.left.length);
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
