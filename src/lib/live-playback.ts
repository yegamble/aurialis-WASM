import { engineParams, type StereoPCM } from "./browser-engine";
import type { AdvancedParams } from "./types";

export type LivePlaybackState = {
  position: number;
  duration: number;
  playing: boolean;
  ready: boolean;
  loading: boolean;
  original: boolean;
  volume: number;
  underruns: number;
  parameterVersion: number;
  appliedVersion: number;
  error: string | null;
};

export type LiveMeter = {
  peakDbfs: number;
  rmsDbfs: number;
  crestDb: number;
  correlation: number;
  position: number;
  underruns: number;
};

export type LiveSpectrum = {
  dbBins: Float32Array<ArrayBuffer>;
  sampleRate: number;
  fftSize: number;
};

type LivePlaybackCallbacks = {
  onState?: (state: LivePlaybackState) => void;
  onMeter?: (meter: LiveMeter) => void;
  onSpectrum?: (spectrum: LiveSpectrum) => void;
  onError?: (error: Error) => void;
};

export type LivePlaybackController = {
  play: () => Promise<void>;
  pause: () => void;
  seek: (seconds: number) => void;
  setParams: (settings: AdvancedParams) => void;
  setBypass: (original: boolean) => void;
  setVolume: (volume: number) => void;
  dispose: () => void;
  getState: () => LivePlaybackState;
};

const QUANTUM = 128;
const SLOTS = 256;
const WRITE = 0;
const READ = 1;
const GENERATION = 2;
const PARAMETER_VERSION = 3;
const APPLIED_VERSION = 4;
const UNDERRUNS = 6;
const WAKE = 7;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

// Each controller owns its complete graph and Go worker. Nothing from a closed
// track is cached or reused when the user returns to that track.
export function createLivePlayback(
  source: StereoPCM,
  settings: AdvancedParams,
  callbacks: LivePlaybackCallbacks = {},
): LivePlaybackController {
  if (!Number.isInteger(source.sampleRate) || source.sampleRate < 8000 || source.sampleRate > 192000
    || source.left.length === 0 || source.left.length !== source.right.length
    || source.left.length > 16 * 1024 * 1024)
    throw new Error("Live playback requires bounded stereo PCM at 8–192 kHz.");
  if (!source.left.every(Number.isFinite) || !source.right.every(Number.isFinite))
    throw new Error("Live playback requires finite PCM samples.");
  let serializedSettings = JSON.stringify(engineParams(settings));
  let state: LivePlaybackState = {
    position: 0, duration: source.left.length / source.sampleRate,
    playing: false, ready: false, loading: false, original: false, volume: 1,
    underruns: 0, parameterVersion: 1, appliedVersion: 0, error: null,
  };
  let audio: AudioContext | undefined;
  let worker: Worker | undefined;
  let worklet: AudioWorkletNode | undefined;
  let header: Int32Array<SharedArrayBuffer> | undefined;
  let buffer: AudioBuffer | undefined;
  let sourceNode: AudioBufferSourceNode | undefined;
  let channel: MessageChannel | undefined;
  let leftAnalyser: AnalyserNode | undefined;
  let rightAnalyser: AnalyserNode | undefined;
  let splitter: ChannelSplitterNode | undefined;
  let merger: ChannelMergerNode | undefined;
  let initialization: Promise<void> | undefined;
  let rejectInitialization: ((reason: Error) => void) | undefined;
  let bootTimeout: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let playTicket = 0;
  let sourceOffset = 0;
  let sourceStart = 0;
  let delaySeconds = 0;
  let spectrumFrame = 0;
  let lastSpectrumTime = 0;

  function isDisposed(): boolean { return disposed; }
  function positionAt(time?: number): number {
    if (!state.playing || !audio) return state.position;
    return Math.max(sourceOffset, Math.min(state.duration,
      sourceOffset + (time ?? audio.currentTime) - sourceStart - delaySeconds));
  }
  function snapshot(): LivePlaybackState {
    return { ...state, position: positionAt(),
      underruns: header ? Atomics.load(header, UNDERRUNS) : state.underruns,
      appliedVersion: header ? Atomics.load(header, APPLIED_VERSION) : state.appliedVersion };
  }
  function emit(): void {
    if (!disposed) callbacks.onState?.(snapshot());
  }
  function stopSource(): void {
    if (!sourceNode) return;
    sourceNode.onended = null;
    try { sourceNode.stop(); } catch { /* It may already have reached its end. */ }
    sourceNode.disconnect();
    sourceNode = undefined;
  }
  function tearDown(): void {
    cancelAnimationFrame(spectrumFrame);
    if (bootTimeout) clearTimeout(bootTimeout);
    bootTimeout = undefined;
    stopSource();
    worklet?.disconnect();
    worklet?.port.close();
    splitter?.disconnect();
    leftAnalyser?.disconnect();
    rightAnalyser?.disconnect();
    merger?.disconnect();
    worker?.terminate();
    channel?.port1.close(); channel?.port2.close(); channel = undefined;
    if (audio && audio.state !== "closed") void audio.close().catch(() => undefined);
    audio = undefined; worker = undefined; worklet = undefined; header = undefined;
    buffer = undefined; splitter = undefined; merger = undefined;
    leftAnalyser = undefined; rightAnalyser = undefined;
    initialization = undefined;
  }
  function fail(error: unknown): void {
    if (disposed) return;
    const failure = error instanceof Error ? error : new Error(String(error));
    const position = positionAt();
    playTicket++;
    rejectInitialization?.(failure);
    rejectInitialization = undefined;
    tearDown();
    state = { ...state, position, playing: false, loading: false, ready: false, error: failure.message };
    emit();
    emitSilence();
    callbacks.onError?.(failure);
  }
  function resetStream(): void {
    if (!header || !worklet || !worker) return;
    const generation = Atomics.add(header, GENERATION, 1) + 1;
    Atomics.store(header, WRITE, 0); Atomics.store(header, READ, 0);
    Atomics.store(header, WAKE, 0); Atomics.store(header, APPLIED_VERSION, 0);
    worklet.port.postMessage({ type: "reset", generation });
    worker.postMessage({ type: "reset", generation });
  }
  function emitSilence(): void {
    callbacks.onMeter?.({ peakDbfs: -120, rmsDbfs: -120, crestDb: 0,
      correlation: 1, position: state.position, underruns: state.underruns });
  }
  function pause(): void {
    playTicket++;
    const position = positionAt();
    stopSource();
    state = { ...state, position, playing: false, loading: false };
    cancelAnimationFrame(spectrumFrame);
    const context = audio;
    if (context?.state === "running") void context.suspend().catch((error: unknown) => {
      if (audio === context) fail(error);
    });
    emit();
    if (!disposed) emitSilence();
  }
  function startSource(offset: number): void {
    if (!audio || !worklet || !buffer) throw new Error("The live audio graph is not ready.");
    stopSource();
    resetStream();
    sourceNode = audio.createBufferSource();
    sourceNode.buffer = buffer;
    sourceNode.connect(worklet);
    sourceOffset = offset;
    sourceStart = audio.currentTime + 0.01;
    sourceNode.start(sourceStart, offset);
    state = { ...state, position: offset, playing: true, loading: false, error: null };
  }
  function spectrum(time: number): void {
    if (disposed || !state.playing || !audio || !leftAnalyser || !rightAnalyser) return;
    if (time - lastSpectrumTime >= 50) {
      lastSpectrumTime = time;
      const left = new Float32Array(leftAnalyser.frequencyBinCount);
      const right = new Float32Array(rightAnalyser.frequencyBinCount);
      leftAnalyser.getFloatFrequencyData(left);
      rightAnalyser.getFloatFrequencyData(right);
      for (let index = 0; index < left.length; index++) {
        const power = (10 ** ((left.at(index) ?? -Infinity) / 10)
          + 10 ** ((right.at(index) ?? -Infinity) / 10)) / 2;
        // The index is bounded by this newly allocated spectrum buffer.
        // eslint-disable-next-line security/detect-object-injection
        left[index] = power > 0 ? 10 * Math.log10(power) : -Infinity;
      }
      callbacks.onSpectrum?.({ dbBins: left, sampleRate: audio.sampleRate, fftSize: leftAnalyser.fftSize });
    }
    spectrumFrame = requestAnimationFrame(spectrum);
  }
  function onWorkletMessage(event: MessageEvent<unknown>): void {
    if (disposed || !isRecord(event.data)) return;
    const message = event.data;
    if (message.type === "error") {
      fail(typeof message.message === "string" ? message.message : "Live playback failed.");
    } else if (message.type === "meter" && state.playing && header
      && message.generation === Atomics.load(header, GENERATION)) {
      if (typeof message.time !== "number" || typeof message.peakDbfs !== "number"
        || typeof message.rmsDbfs !== "number" || typeof message.crestDb !== "number"
        || typeof message.correlation !== "number"
        || ![message.time, message.peakDbfs, message.rmsDbfs, message.crestDb, message.correlation].every(Number.isFinite)) {
        fail(new Error("The live audio meter returned invalid data."));
        return;
      }
      state = { ...state, position: positionAt(message.time),
        underruns: Atomics.load(header, UNDERRUNS), appliedVersion: Atomics.load(header, APPLIED_VERSION) };
      if (state.position >= state.duration) {
        pause();
        return;
      }
      callbacks.onMeter?.({ peakDbfs: message.peakDbfs, rmsDbfs: message.rmsDbfs,
        crestDb: message.crestDb, correlation: message.correlation,
        position: state.position, underruns: state.underruns });
      emit();
    }
  }
  async function initialize(): Promise<void> {
    if (disposed) return;
    if (!globalThis.crossOriginIsolated || typeof SharedArrayBuffer === "undefined")
      throw new Error("Live playback requires cross-origin isolation. Restart the local app and reload.");
    // Called synchronously from play(), before its first await, preserving the
    // user's activation for AudioContext creation/resume in Brave and Safari.
    const context = new AudioContext({ latencyHint: "interactive" });
    audio = context;
    const resumed = context.resume();
    const sharedHeader = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 8);
    const sharedTags = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * SLOTS * 5);
    const sharedSamples = new SharedArrayBuffer(Float32Array.BYTES_PER_ELEMENT * QUANTUM * SLOTS * 4);
    header = new Int32Array(sharedHeader);
    Atomics.store(header, GENERATION, 1);
    Atomics.store(header, PARAMETER_VERSION, state.parameterVersion);
    const bridgeChannel = new MessageChannel();
    channel = bridgeChannel;
    const processingWorker = new Worker("/workers/aurialis-live-worker.js");
    worker = processingWorker;
    const ready = new Promise<void>((resolve, reject) => {
      rejectInitialization = reject;
      bootTimeout = setTimeout(() => { reject(new Error("Live audio initialization timed out. Retry playback.")); }, 15000);
      processingWorker.onmessage = (event: MessageEvent<unknown>) => {
        if (disposed || worker !== processingWorker || !isRecord(event.data)) return;
        if (event.data.type === "ready") {
          if (bootTimeout) clearTimeout(bootTimeout);
          bootTimeout = undefined;
          rejectInitialization = undefined;
          resolve();
        } else if (event.data.type === "error") {
          fail(new Error(typeof event.data.message === "string" ? event.data.message : "The audio worker failed."));
        }
      };
      processingWorker.onerror = () => {
        if (worker === processingWorker) fail(new Error("The shared Go audio worker could not start. Reload and retry."));
      };
    });
    processingWorker.postMessage({ type: "init", header: sharedHeader, tags: sharedTags,
      samples: sharedSamples, sampleRate: context.sampleRate, params: serializedSettings,
      version: state.parameterVersion, port: bridgeChannel.port1 }, [bridgeChannel.port1]);
    await Promise.all([ready, context.audioWorklet.addModule("/worklets/aurialis-live-worklet.js"), resumed]);
    if (isDisposed() || audio !== context) return;
    const delayBlocks = Math.max(4, Math.ceil(context.sampleRate * 0.08 / QUANTUM));
    delaySeconds = delayBlocks * QUANTUM / context.sampleRate;
    const node = new AudioWorkletNode(context, "aurialis-live", { numberOfInputs: 1, numberOfOutputs: 1,
      channelCount: 2, channelCountMode: "explicit", outputChannelCount: [2],
      processorOptions: { header: sharedHeader, tags: sharedTags, samples: sharedSamples, delayBlocks } });
    worklet = node;
    node.port.onmessage = (event: MessageEvent<unknown>) => {
      if (worklet === node) onWorkletMessage(event);
    };
    node.onprocessorerror = () => {
      if (worklet === node) fail(new Error("The live audio processor stopped unexpectedly. Retry playback."));
    };
    node.port.postMessage({ type: "connect", port: bridgeChannel.port2 }, [bridgeChannel.port2]);
    node.port.postMessage({ type: "original", value: state.original });
    node.port.postMessage({ type: "volume", value: state.volume });
    processingWorker.postMessage({ type: "params", params: serializedSettings, version: state.parameterVersion });
    const split = context.createChannelSplitter(2), merge = context.createChannelMerger(2);
    const left = context.createAnalyser(), right = context.createAnalyser();
    left.fftSize = right.fftSize = 4096;
    left.smoothingTimeConstant = right.smoothingTimeConstant = 0.35;
    left.minDecibels = right.minDecibels = -120;
    left.maxDecibels = right.maxDecibels = 0;
    node.connect(split);
    split.connect(left, 0); split.connect(right, 1);
    left.connect(merge, 0, 0); right.connect(merge, 0, 1);
    merge.connect(context.destination);
    splitter = split; merger = merge; leftAnalyser = left; rightAnalyser = right;
    buffer = context.createBuffer(2, source.left.length, source.sampleRate);
    buffer.copyToChannel(source.left, 0); buffer.copyToChannel(source.right, 1);
    state = { ...state, ready: true, error: null };
    emit();
  }

  return {
    async play() {
      if (disposed) return;
      if (state.playing) return;
      const ticket = ++playTicket;
      state = { ...state, loading: true, error: null };
      emit();
      try {
        initialization ??= initialize();
        await initialization;
        if (isDisposed() || ticket !== playTicket || !audio) return;
        await audio.resume();
        if (isDisposed() || ticket !== playTicket) return;
        startSource(state.position >= state.duration ? 0 : state.position);
        spectrumFrame = requestAnimationFrame(spectrum);
        emit();
      } catch (error) {
        if (!isDisposed() && ticket === playTicket) fail(error);
      }
    },
    pause,
    seek(seconds) {
      if (disposed || !Number.isFinite(seconds)) return;
      const offset = Math.max(0, Math.min(state.duration, seconds));
      if (state.playing && offset < state.duration) startSource(offset);
      else {
        if (state.playing) pause();
        state = { ...state, position: offset };
      }
      emit();
    },
    setParams(next) {
      if (disposed) return;
      const serialized = JSON.stringify(engineParams(next));
      if (serialized === serializedSettings) return;
      serializedSettings = serialized;
      state = { ...state, parameterVersion: state.parameterVersion + 1 };
      if (header) Atomics.store(header, PARAMETER_VERSION, state.parameterVersion);
      if (state.ready) worker?.postMessage({ type: "params", params: serializedSettings, version: state.parameterVersion });
      emit();
    },
    setBypass(original) {
      if (disposed) return;
      state = { ...state, original };
      worklet?.port.postMessage({ type: "original", value: original });
      emit();
    },
    setVolume(volume) {
      if (disposed || !Number.isFinite(volume)) return;
      state = { ...state, volume: Math.max(0, Math.min(1, volume)) };
      worklet?.port.postMessage({ type: "volume", value: state.volume });
      emit();
    },
    getState: snapshot,
    dispose() {
      if (disposed) return;
      disposed = true;
      playTicket++;
      rejectInitialization?.(new Error("Playback was disposed."));
      rejectInitialization = undefined;
      tearDown();
      state = { ...state, ready: false, loading: false, playing: false };
    },
  };
}
