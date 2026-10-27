import { MAX_SOURCE_FRAMES } from "./audio-limits";
import type { StereoPCM } from "./browser-engine";
import { exportParams } from "./engine-params";
import { usesBrowserAudio } from "./browser-jobs";
import { prepareLiveAutomation, verifiedSourceVector } from "./live-automation";
import { sameSource } from "./library";
import type { ScriptV2 } from "./deep-mastering";
import { packLiveControls, createLiveControls } from "./live-controls";
import type { AdvancedParams, SourceIdentity } from "./types";

export type LivePlaybackState = {
  position: number;
  duration: number;
  playing: boolean;
  ready: boolean;
  loading: boolean;
  original: boolean;
  repeat: boolean;
  repeatPending?: boolean;
  volume: number;
  /** Applied static monitor attenuation in dB (each ≤ 0); absent in fixtures predating V1-11. */
  loudnessMatch?: LoudnessMatchGains;
  underruns: number;
  parameterVersion: number;
  appliedVersion: number;
  error: string | null;
  /** Rate the live engine runs at once its context exists. It equals the
   * source rate unless the browser cannot open that rate (or the source is
   * above LIVE_MAX_SAMPLE_RATE); then A is resampled before processing. */
  liveSampleRate?: number;
};

/** Highest source rate the live engine runs natively. 96 kHz with every module
 * on measured 2.7–2.9× headroom (docs/tasks.md V1-10); higher rates would leave
 * too little, so they play at the device rate instead. */
const LIVE_MAX_SAMPLE_RATE = 96000;

/** Open the context at the source rate so live DSP processes the samples the
 * export processes. A browser that rejects the rate gets its device rate. */
function openLiveContext(sourceRate: number): AudioContext {
  if (sourceRate <= LIVE_MAX_SAMPLE_RATE) {
    // Browsers reject unsupported rates differently (NotSupportedError, SyntaxError);
    // any real fault recurs below and propagates.
    try { return new AudioContext({ latencyHint: "interactive", sampleRate: sourceRate }); }
    catch { /* Fall back to the device rate. */ }
  }
  return new AudioContext({ latencyHint: "interactive" });
}

/** One static, attenuate-only A/B monitor gain pair in dB (V1-11). Never part of export. */
export type LoudnessMatchGains = { processedDb: number; originalDb: number };
const UNITY_MATCH: LoudnessMatchGains = { processedDb: 0, originalDb: 0 };
function matchMessage(match: LoudnessMatchGains) {
  return { type: "match", processed: 10 ** (match.processedDb / 20), original: 10 ** (match.originalDb / 20) };
}

/** BS.1770-4 / EBU R128 readings of the processed output (before A/B and volume). */
export type LiveLoudness = {
  /** null until its 400 ms / 3 s window is full or while every block is gated. */
  momentaryLufs: number | null;
  shortTermLufs: number | null;
  integratedLufs: number | null;
  loudnessRangeLu: number | null;
  truePeakDbtp: number;
  recentTruePeakDbtp: number;
  gainReductionDb: number;
};

export type LiveMeter = LiveLoudness & {
  peakDbfs: number;
  rmsDbfs: number;
  crestDb: number;
  correlation: number;
  position: number;
  underruns: number;
};

const SILENT_LOUDNESS: LiveLoudness = { momentaryLufs: null, shortTermLufs: null, integratedLufs: null,
  loudnessRangeLu: null, truePeakDbtp: -120, recentTruePeakDbtp: -120, gainReductionDb: 0 };

function liveLoudness(message: Record<string, unknown>): LiveLoudness | null {
  const reading = (value: unknown) => value === null || (typeof value === "number" && Number.isFinite(value));
  const level = (value: unknown) => typeof value === "number" && Number.isFinite(value);
  const { momentaryLufs, shortTermLufs, integratedLufs, loudnessRangeLu, truePeakDbtp, recentTruePeakDbtp, gainReductionDb } = message;
  if (![momentaryLufs, shortTermLufs, integratedLufs, loudnessRangeLu].every(reading)
    || ![truePeakDbtp, recentTruePeakDbtp, gainReductionDb].every(level)) return null;
  return { momentaryLufs, shortTermLufs, integratedLufs, loudnessRangeLu, truePeakDbtp, recentTruePeakDbtp, gainReductionDb } as LiveLoudness;
}

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
  applyScript: (script: ScriptV2, signal: AbortSignal, canCommit?: () => boolean) => Promise<ScriptV2>;
  detachScript: (settings: AdvancedParams, signal: AbortSignal, canCommit?: () => boolean) => Promise<void>;
  setBypass: (original: boolean) => void;
  setVolume: (volume: number) => void;
  /** Apply one static attenuate-only monitor gain pair, or unity with null. */
  setLoudnessMatch: (match: LoudnessMatchGains | null) => void;
  setRepeat: (enabled: boolean) => void;
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

// Each controller owns its complete graph and Go instance. Nothing from a closed
// track is cached or reused when the user returns to that track.
export function createLivePlayback(
  source: StereoPCM,
  settings: AdvancedParams,
  callbacks: LivePlaybackCallbacks = {},
  binding?: { blob: Blob; identity: SourceIdentity; applied?: ScriptV2 },
): LivePlaybackController {
  if (!Number.isInteger(source.sampleRate) || source.sampleRate < 8000 || source.sampleRate > 192000
    || source.left.length === 0 || source.left.length !== source.right.length
    || source.left.length > MAX_SOURCE_FRAMES)
    throw new Error("Live playback requires bounded stereo PCM at 8–192 kHz.");
  if (!source.left.every(Number.isFinite) || !source.right.every(Number.isFinite))
    throw new Error("Live playback requires finite PCM samples.");
  if (binding && (binding.identity.sampleRate !== source.sampleRate || binding.identity.frames !== source.left.length)) throw new Error("The source layout differs from its canonical identity. Restore the matching audio file.");
  let installedScript: ScriptV2 | undefined;
  let desiredScript: ScriptV2 | undefined = binding?.applied;
  let scheduleRevision = 0;
  let publicationToken = 0;
  let activePublication: AbortController | undefined;
  const publications = new Map<number, { resolve: (revision: number) => void; reject: (error: Error) => void; canCommit: () => boolean; commitSent: boolean }>();
  let currentParams = exportParams(settings);
  let serializedSettings = JSON.stringify(currentParams);
  let state: LivePlaybackState = {
    position: 0, duration: source.left.length / source.sampleRate,
    playing: false, ready: false, loading: false, original: false, repeat: false, volume: 1,
    loudnessMatch: UNITY_MATCH, underruns: 0, parameterVersion: 1, appliedVersion: 0, error: null,
  };
  let audio: AudioContext | undefined;
  let worklet: AudioWorkletNode | undefined;
  let header: Int32Array<SharedArrayBuffer> | undefined;
  let streamHeader: Int32Array<SharedArrayBuffer> | undefined;
  let streamTime: Float64Array<SharedArrayBuffer> | undefined;
  let sourceTicket = 0;
  const arms = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();
  let controls: ReturnType<typeof createLiveControls> | undefined;
  let loadingAbort: AbortController | undefined;
  let buffer: AudioBuffer | undefined;
  let sourceNode: AudioBufferSourceNode | undefined;
  let leftAnalyser: AnalyserNode | undefined;
  let rightAnalyser: AnalyserNode | undefined;
  let splitter: ChannelSplitterNode | undefined;
  let merger: ChannelMergerNode | undefined;
  let initialization: Promise<void> | undefined;
  let rejectInitialization: ((reason: Error) => void) | undefined;
  let bootTimeout: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let playTicket = 0;
  let wantsPlayback = false;
  let sourceOffset = 0;
  let sourceStart = 0;
  let sourceEnd = state.duration;
  let sourceEndFrame = source.left.length;
  let sourceFrameOffset = 0;
  let sourceStartFrame = 0;
  let sourceGeneration = 0;
  let epochLooping = false;
  let automaticRepeat = false;
  let delaySeconds = 0;
  let spectrumFrame = 0;
  let lastSpectrumTime = 0;

  function isDisposed(): boolean { return disposed; }
  function unwrappedPosition(time?: number): number {
    if (!audio) return state.position;
    return Math.max(sourceOffset, sourceOffset + (time ?? audio.currentTime) - sourceStart - delaySeconds);
  }
  function positionAt(time?: number): number {
    if (!state.playing || !audio) return state.position;
    const position = unwrappedPosition(time);
    return position >= sourceEnd ? state.duration : position % state.duration;
  }
  function publishSourceEpoch(): void {
    if (!streamHeader || !streamTime || !audio) return;
    const sequence = Atomics.load(streamHeader, 0);
    Atomics.store(streamHeader, 0, sequence + 1);
    streamTime[0] = sourceStartFrame;
    streamTime[1] = sourceEnd === Infinity ? Infinity : sourceStartFrame + Math.round(delaySeconds * audio.sampleRate)
      + Number((BigInt(sourceEndFrame - sourceFrameOffset) * BigInt(audio.sampleRate) + BigInt(source.sampleRate - 1)) / BigInt(source.sampleRate));
    Atomics.store(streamHeader, 1, sourceGeneration);
    Atomics.store(streamHeader, 0, sequence + 2);
  }
  function setSourceEndFrame(end: number): void {
    sourceEndFrame = end; sourceEnd = end === Infinity ? Infinity : end / source.sampleRate;
    publishSourceEpoch();
  }
  function nextInputCycle(): number {
    if (!audio) return source.left.length;
    const elapsed = Math.max(header ? Atomics.load(header, READ) * QUANTUM : 0, Math.round(audio.currentTime * audio.sampleRate) - sourceStartFrame, 0);
    const numerator = BigInt(sourceFrameOffset) * BigInt(audio.sampleRate) + BigInt(elapsed) * BigInt(source.sampleRate);
    return Number(numerator / (BigInt(source.left.length) * BigInt(audio.sampleRate)) + 1n) * source.left.length;
  }
  function snapshot(): LivePlaybackState {
    return { ...state, position: positionAt(), repeatPending: state.playing && state.repeat && !epochLooping,
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
    activePublication?.abort();
    sourceTicket++; for (const arm of arms.values()) arm.reject(new Error("The source graph closed before arming.")); arms.clear();
    for (const pending of publications.values()) pending.reject(new Error("The audio graph was closed before publication."));
    publications.clear();
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
    loadingAbort?.abort();
    loadingAbort = undefined;
    if (audio && audio.state !== "closed") void audio.close().catch(() => undefined);
    installedScript = undefined; scheduleRevision = 0;
    audio = undefined; worklet = undefined; header = undefined; streamHeader = undefined; streamTime = undefined; controls = undefined;
    buffer = undefined; splitter = undefined; merger = undefined;
    leftAnalyser = undefined; rightAnalyser = undefined;
    initialization = undefined;
  }
  function fail(error: unknown): void {
    if (disposed) return;
    wantsPlayback = false;
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
  function armStream(sourceFrame: number, looping: boolean): Promise<number> {
    if (!header || !worklet) return Promise.reject(new Error("The source graph is not ready."));
    const generation = Atomics.add(header, GENERATION, 1) + 1;
    Atomics.store(header, WRITE, 0); Atomics.store(header, READ, 0);
    Atomics.store(header, WAKE, 0); Atomics.store(header, APPLIED_VERSION, 0);
    return new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => { finish(new Error("The audio engine did not arm the source. Retry playback.")); }, 5000);
      function finish(error?: Error) { clearTimeout(timeout); arms.delete(generation); if (error) reject(error); else resolve(generation); }
      arms.set(generation, { resolve: () => { finish(); }, reject: finish });
      worklet?.port.postMessage({ type: "arm", generation, sourceFrame, looping });
    });
  }
  function emitSilence(): void {
    callbacks.onMeter?.({ ...SILENT_LOUDNESS, peakDbfs: -120, rmsDbfs: -120, crestDb: 0,
      correlation: 1, position: state.position, underruns: state.underruns });
  }
  function pause(): void {
    playTicket++; sourceTicket++; wantsPlayback = false; automaticRepeat = false;
    for (const arm of arms.values()) arm.reject(new DOMException("Playback paused.", "AbortError")); arms.clear();
    const position = positionAt();
    stopSource();
    worklet?.port.postMessage({ type: "hold" });
    state = { ...state, position, playing: false, loading: false };
    cancelAnimationFrame(spectrumFrame);
    const context = audio;
    if (context?.state === "running") void context.suspend().catch((error: unknown) => {
      if (audio === context) fail(error);
    });
    emit();
    if (!disposed) emitSilence();
  }
  async function startSource(offset: number, repeating = false): Promise<void> {
    const context = audio, processor = worklet, input = buffer;
    if (!context || !processor || !input || !streamHeader || !streamTime) throw new Error("The live audio graph is not ready.");
    const ticket = ++sourceTicket;
    automaticRepeat = repeating;
    for (const arm of arms.values()) arm.reject(new DOMException("A newer source request replaced this one.", "AbortError")); arms.clear();
    stopSource();
    const sourceFrame = Math.min(source.left.length - 1, Math.max(0, Math.floor(offset * source.sampleRate)));
    sourceOffset = sourceFrame / source.sampleRate; sourceFrameOffset = sourceFrame;
    state = { ...state, position: sourceOffset, playing: false, loading: true };
    emit();
    // No native source exists before the worklet has reset and sought its Go clock.
    let generation: number;
    const looping = state.repeat;
    try { generation = await armStream(sourceFrame, looping); }
    catch (error) { if (isDisposed() || ticket !== sourceTicket) return; throw error; }
    if (isDisposed() || ticket !== sourceTicket || audio !== context || worklet !== processor) return;
    if (looping !== state.repeat) { await startSource(offset, repeating); return; }
    automaticRepeat = false; epochLooping = looping; sourceGeneration = generation;
    const node = context.createBufferSource(); sourceNode = node;
    node.buffer = input; node.loop = looping; node.connect(processor);
    sourceStart = Math.ceil((context.currentTime + 0.02) * context.sampleRate / QUANTUM) * QUANTUM / context.sampleRate;
    node.start(sourceStart, sourceOffset);
    // A stalled main thread must never publish an epoch after its native deadline.
    if (context.currentTime >= sourceStart) { stopSource(); throw new Error("The source start deadline was missed. Retry playback."); }
    sourceStartFrame = Math.round(sourceStart * context.sampleRate);
    setSourceEndFrame(looping ? Infinity : source.left.length);
    state = { ...state, position: sourceOffset, playing: true, loading: false, error: null };
    cancelAnimationFrame(spectrumFrame); spectrumFrame = requestAnimationFrame(spectrum);
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
    if (message.type === "stream-armed" && typeof message.generation === "number") {
      arms.get(message.generation)?.resolve();
    } else if (message.type === "automation-staged" && typeof message.token === "number") {
      const pending = publications.get(message.token);
      if (!pending || !pending.canCommit()) { worklet?.port.postMessage({ type: "schedule-cancel", token: message.token }); pending?.reject(new DOMException("The processing request changed.", "AbortError")); }
      else { pending.commitSent = true; worklet?.port.postMessage({ type: "schedule-commit", token: message.token }); }
    } else if (message.type === "automation-ack" && typeof message.token === "number" && typeof message.revision === "number") {
      publications.get(message.token)?.resolve(message.revision);
    } else if (message.type === "automation-error" && typeof message.token === "number") {
      publications.get(message.token)?.reject(new Error(typeof message.message === "string" ? message.message : "The processing revision was rejected."));
    } else if (message.type === "error") {
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
      const loudness = liveLoudness(message);
      if (!loudness) {
        fail(new Error("The live audio meter returned invalid data."));
        return;
      }
      state = { ...state, position: positionAt(message.time),
        underruns: Atomics.load(header, UNDERRUNS), appliedVersion: Atomics.load(header, APPLIED_VERSION) };
      if (unwrappedPosition(message.time) >= sourceEnd) {
        if (state.repeat) void startSource(0, true).then(() => { emit(); }).catch(fail);
        else pause();
        return;
      }
      callbacks.onMeter?.({ ...loudness, peakDbfs: message.peakDbfs, rmsDbfs: message.rmsDbfs,
        crestDb: message.crestDb, correlation: message.correlation,
        position: state.position, underruns: state.underruns });
      emit();
    }
  }
  async function initialize(): Promise<void> {
    if (disposed) return;
    if (!globalThis.crossOriginIsolated || typeof SharedArrayBuffer === "undefined")
      throw new Error(usesBrowserAudio()
        ? "Live playback requires cross-origin isolation. Reload the page; if this continues, use a current version of Chrome, Edge, Firefox or Safari."
        : "Live playback requires cross-origin isolation. Restart the Aurialis server and reload.");
    // Called synchronously from play(), before its first await, preserving the
    // user's activation for AudioContext creation/resume in Brave and Safari.
    const context = openLiveContext(source.sampleRate);
    audio = context;
    state = { ...state, liveSampleRate: context.sampleRate };
    const resumed = context.resume();
    const sharedHeader = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 8);
    const sharedStream = new SharedArrayBuffer(24);
    streamHeader = new Int32Array(sharedStream, 0, 2); streamTime = new Float64Array(sharedStream, 8, 2);
    const sharedTags = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * SLOTS * 5);
    const sharedSamples = new SharedArrayBuffer(Float32Array.BYTES_PER_ELEMENT * QUANTUM * SLOTS * 4);
    header = new Int32Array(sharedHeader);
    Atomics.store(header, GENERATION, 1);
    Atomics.store(header, PARAMETER_VERSION, state.parameterVersion);
    controls = createLiveControls(currentParams, state.parameterVersion, 2);
    const sharedControls = controls.buffer;
    const requestAbort = new AbortController();
    loadingAbort = requestAbort;
    let resolveReady: (() => void) | undefined;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectInitialization = reject;
      bootTimeout = setTimeout(() => { reject(new Error("Live audio initialization timed out. Retry playback.")); }, 15000);
    });
    const loadModule = async () => {
      const response = await fetch("/wasm/aurialis-realtime.wasm", { signal: requestAbort.signal });
      if (!response.ok) throw new Error("The shared Go audio engine could not be loaded. Reload and retry.");
      return WebAssembly.compile(await response.arrayBuffer());
    };
    const loaded = Promise.all([
      loadModule(), context.audioWorklet.addModule("/worklets/aurialis-live-worklet.js"),
    ]).then(([compiledModule]) => {
      if (isDisposed() || audio !== context) return;
      const delayBlocks = Math.max(4, Math.ceil(context.sampleRate * 0.08 / QUANTUM));
      delaySeconds = delayBlocks * QUANTUM / context.sampleRate;
      const node = new AudioWorkletNode(context, "aurialis-live", { numberOfInputs: 1, numberOfOutputs: 1,
        channelCount: 2, channelCountMode: "explicit", outputChannelCount: [2],
        processorOptions: { header: sharedHeader, stream: sharedStream, tags: sharedTags, samples: sharedSamples, delayBlocks,
          module: compiledModule, controls: sharedControls, controlAbiVersion: 2, entropy: crypto.getRandomValues(new Uint8Array(256)),
          clockOriginMs: Math.max(1, performance.now()) } });
      worklet = node;
      node.port.onmessage = (event: MessageEvent<unknown>) => {
        if (disposed || worklet !== node || !isRecord(event.data)) return;
        if (event.data.type === "ready") {
          if (bootTimeout) clearTimeout(bootTimeout);
          bootTimeout = undefined;
          rejectInitialization = undefined;
          resolveReady?.();
          resolveReady = undefined;
        } else onWorkletMessage(event);
      };
      node.onprocessorerror = () => {
        if (worklet === node) fail(new Error("The live audio processor stopped unexpectedly. Retry playback."));
      };
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
      node.port.postMessage({ type: "original", value: state.original });
      node.port.postMessage({ type: "volume", value: state.volume });
      node.port.postMessage(matchMessage(state.loudnessMatch ?? UNITY_MATCH));
    });
    await Promise.all([ready, loaded, resumed]);
    if (isDisposed() || audio !== context) return;
    if (!worklet) throw new Error("The live audio processor could not initialize.");
    if (binding) {
      const vector = await verifiedSourceVector(binding.blob, binding.identity, requestAbort.signal);
      if (isDisposed() || audio !== context) return;
      await requestPublication({ type: "bind-source", source: vector }, requestAbort.signal);
    }
    loadingAbort = undefined;
    buffer = context.createBuffer(2, source.left.length, source.sampleRate);
    buffer.copyToChannel(source.left, 0); buffer.copyToChannel(source.right, 1);
    state = { ...state, ready: true, error: null };
    emit();
  }

  async function ensureInitialized(): Promise<void> {
    if (disposed) throw new Error("This audio graph has been closed.");
    if (!initialization) {
      const attempt = initialize(); initialization = attempt;
      void attempt.catch((error: unknown) => { if (!isDisposed() && initialization === attempt) fail(error); });
    }
    await initialization;
    if (isDisposed() || !audio || !worklet) throw new Error("The audio graph is no longer available.");
  }
  function requestPublication(message: Record<string, unknown>, signal: AbortSignal, canCommit: () => boolean = () => true): Promise<number> {
    signal.throwIfAborted();
    if (!worklet || disposed) return Promise.reject(new Error("The audio graph is not ready."));
    const token = ++publicationToken;
    return new Promise<number>((resolve, reject) => {
      const gate = new Int32Array(new SharedArrayBuffer(4)); Atomics.store(gate, 0, 1);
      const deadline = setTimeout(() => { const uncertain = publications.get(token)?.commitSent ?? false; const error = new Error("The audio engine did not acknowledge this processing revision. The previous revision remains selected."); finish(error); if (uncertain) fail(error); }, 15_000);
      const abort = () => {
        const uncertain = publications.get(token)?.commitSent ?? false;
        worklet?.port.postMessage({ type: "schedule-cancel", token }); finish(new DOMException("Processing publication canceled.", "AbortError"));
        if (uncertain) fail(new Error("Processing changed during commit acknowledgment. Playback paused; press Play to restore the selected revision."));
      };
      function finish(error?: Error, revision?: number) { Atomics.store(gate, 0, 0); clearTimeout(deadline); signal.removeEventListener("abort", abort); publications.delete(token); if (error) reject(error); else resolve(revision ?? 0); }
      publications.set(token, { resolve: (revision) => { finish(undefined, revision); }, reject: (error) => { finish(error); }, canCommit: () => !disposed && !signal.aborted && canCommit(), commitSent: message.type === "detach" });
      signal.addEventListener("abort", abort, { once: true });
      const transfer: ArrayBuffer[] = [];
      for (const value of Object.values(message)) if (value instanceof Float64Array && value.buffer instanceof ArrayBuffer) transfer.push(value.buffer);
      worklet?.port.postMessage({ ...message, token, gate: gate.buffer }, transfer);
    });
  }
  async function applyScript(script: ScriptV2, signal: AbortSignal, canCommit: () => boolean = () => true): Promise<ScriptV2> {
    if (!binding || !sameSource(binding.identity, script.source)) throw new Error("Restore the matching canonical source before applying this script.");
    activePublication?.abort(); const operation = new AbortController(); activePublication = operation;
    const combined = AbortSignal.any([signal, operation.signal]);
    // Establish the context synchronously in this user gesture before hashing/compilation.
    const ready = ensureInitialized();
    await ready; combined.throwIfAborted();
    const context = audio; if (!context) throw new Error("The audio graph is unavailable.");
    await context.resume();
    const revision = Math.max(scheduleRevision + 1, script.revision);
    if (!Number.isSafeInteger(revision)) throw new Error("The schedule revision limit has been reached. Reload this project.");
    const installed = { ...script, revision };
    try {
      const packet = await prepareLiveAutomation(installed, binding.blob, context.sampleRate, combined);
      combined.throwIfAborted(); if (!canCommit()) throw new DOMException("The source or settings changed.", "AbortError");
      scheduleRevision = revision;
      const version = state.parameterVersion + 1;
      const accepted = await requestPublication({ type: "schedule", ...packet, version }, combined, canCommit);
      if (accepted !== revision) throw new Error("The audio engine acknowledged a different schedule revision.");
      if (!canCommit()) { fail(new Error("The processing request changed before acknowledgment. Playback paused; press Play to restore the selected revision.")); throw new DOMException("The processing request changed.", "AbortError"); }
      installedScript = installed; desiredScript = installed;
      state = { ...state, parameterVersion: version }; emit();
      return installed;
    } finally {
      if (activePublication === operation) { activePublication = undefined; if (!state.playing && audio === context) await context.suspend(); }
    }
  }

  return {
    applyScript,
    async detachScript(next, signal, canCommit = () => true) {
      activePublication?.abort();
      if (!canCommit()) throw new DOMException("The source or settings changed.", "AbortError");
      if (!installedScript) { desiredScript = undefined; currentParams = exportParams(next); serializedSettings = JSON.stringify(currentParams); controls?.publish(currentParams, ++state.parameterVersion); return; }
      await ensureInitialized(); signal.throwIfAborted();
      const context = audio; if (!context) throw new Error("The audio graph is unavailable.");
      await context.resume();
      try {
        signal.throwIfAborted();
        if (!canCommit()) throw new DOMException("The source or settings changed before detach.", "AbortError");
        const params = exportParams(next), version = state.parameterVersion + 1;
        controls?.publish(params, version);
        await requestPublication({ type: "detach", controls: packLiveControls(params, 2), version }, signal, canCommit);
        signal.throwIfAborted();
        if (!canCommit()) { fail(new Error("The detach request changed before acknowledgment. Playback paused; press Play to restore the selected revision.")); throw new DOMException("The source or settings changed during detach.", "AbortError"); }
        installedScript = undefined; desiredScript = undefined; currentParams = params; serializedSettings = JSON.stringify(params); controls?.publish(params, version);
        state = { ...state, parameterVersion: version }; emit();
      } finally { if (!state.playing && audio === context) await context.suspend(); }
    },
    async play() {
      if (disposed) return;
      if (state.playing) return;
      wantsPlayback = true;
      const ticket = ++playTicket;
      state = { ...state, loading: true, error: null };
      emit();
      try {
        // A prior Pause can suspend the context while the module is still
        // loading. Resume inside this Play gesture before waiting for ready.
        const resuming = initialization ? audio?.resume() : undefined;
        if (!initialization) {
          const attempt = initialize();
          initialization = attempt;
          // Pause invalidates Play intent, but the initialization still owns
          // its graph until it succeeds or fails. A failed old attempt must
          // never tear down a graph created by a later retry.
          void attempt.catch((error: unknown) => {
            if (!isDisposed() && initialization === attempt) fail(error);
          });
        }
        await Promise.all([initialization, resuming]);
        if (isDisposed() || ticket !== playTicket || !audio) return;
        await audio.resume();
        if (isDisposed() || ticket !== playTicket) return;
        if (desiredScript && !installedScript) await applyScript(desiredScript, new AbortController().signal);
        if (isDisposed() || ticket !== playTicket) return;
        await audio.resume();
        if (isDisposed() || ticket !== playTicket) return;
        await startSource(state.position >= state.duration ? 0 : state.position);
        emit();
      } catch (error) {
        if (!isDisposed() && ticket === playTicket) fail(error);
      }
    },
    pause,
    seek(seconds) {
      if (disposed || !Number.isFinite(seconds)) return;
      const offset = Math.max(0, Math.min(state.duration, seconds));
      if ((state.playing || (state.loading && wantsPlayback && !!buffer)) && offset < state.duration) void startSource(offset).then(() => { emit(); }).catch(fail);
      else {
        if (state.playing || (state.loading && wantsPlayback && offset >= state.duration)) pause();
        state = { ...state, position: offset };
      }
      emit();
    },
    setParams(next) {
      if (disposed) return;
      if (installedScript) throw new Error("Attached automation requires a complete baseline and schedule transaction.");
      const params = exportParams(next);
      const serialized = JSON.stringify(params);
      if (serialized === serializedSettings) return;
      const version = state.parameterVersion + 1;
      controls?.publish(params, version);
      serializedSettings = serialized;
      currentParams = params;
      state = { ...state, parameterVersion: version };
      if (header) Atomics.store(header, PARAMETER_VERSION, state.parameterVersion);
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
    setLoudnessMatch(match) {
      const next = match ?? UNITY_MATCH;
      // Monitoring only lowers the louder side; refuse boosts and non-finite values.
      if (disposed || ![next.processedDb, next.originalDb].every((value) => Number.isFinite(value) && value <= 0)) return;
      state = { ...state, loudnessMatch: { processedDb: next.processedDb, originalDb: next.originalDb } };
      worklet?.port.postMessage(matchMessage(next));
      emit();
    },
    setRepeat(enabled) {
      if (disposed || enabled === state.repeat) return;
      state = { ...state, repeat: enabled };
      if (automaticRepeat && !enabled) { pause(); state = { ...state, position: state.duration }; }
      else if (state.playing && epochLooping) {
        if (enabled && unwrappedPosition() >= sourceEnd) void startSource(0, true).then(() => { emit(); }).catch(fail);
        else setSourceEndFrame(enabled ? Infinity : nextInputCycle());
      }
      // A finite native source cannot be revived after EOF. Keep its complete
      // audible pass, then prepare a new epoch if Repeat is still requested.
      emit();
    },
    getState: snapshot,
    dispose() {
      if (disposed) return;
      disposed = true; wantsPlayback = false;
      playTicket++;
      rejectInitialization?.(new Error("Playback was disposed."));
      rejectInitialization = undefined;
      tearDown();
      state = { ...state, ready: false, loading: false, playing: false };
    },
  };
}
