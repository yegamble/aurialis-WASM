import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultAdvancedParams } from "../audio-dsp";
import { createLivePlayback } from "../live-playback";
import * as automation from "../live-automation";
import { engineParams } from "../browser-engine";
import type { ScriptV2 } from "../deep-mastering";

const source = () => ({ sampleRate: 48000, left: new Float32Array(48000), right: new Float32Array(48000) });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

/** How the stub browser answers a requested AudioContext rate: ignore it and
 * run at the 48 kHz device rate, honour it, or reject it like an unsupported rate. */
type RatePolicy = "device" | "honor" | "reject";
function graphHarness(autoReady = true, autoArm = true, autoAutomation = false, rates: RatePolicy = "device") {
  const contexts: Context[] = [];
  const nodes: Node[] = [];
  const worker = vi.fn();
  const compiledModule = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
  const fetchModule = vi.fn<typeof fetch>(() => Promise.resolve(new Response(new Uint8Array([0]), { status: 200 })));
  vi.spyOn(WebAssembly, "compile").mockResolvedValue(compiledModule);
  class Port {
    onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
    revision = 0;
    postMessage = vi.fn((message: { type?: string; generation?: number; token?: number; revision?: number; looping?: boolean }) => {
      if (message.type === "arm" && autoArm) queueMicrotask(() => { this.message({ type: "stream-armed", generation: message.generation }); });
      if (autoAutomation && message.type === "bind-source") queueMicrotask(() => { this.message({ type: "automation-ack", token: message.token, revision: 0 }); });
      if (autoAutomation && message.type === "schedule") { this.revision = message.revision ?? 0; queueMicrotask(() => { this.message({ type: "automation-staged", token: message.token }); }); }
      if (autoAutomation && message.type === "schedule-commit") queueMicrotask(() => { this.message({ type: "automation-ack", token: message.token, revision: this.revision }); });
    });
    close = vi.fn();
    message(data: unknown) { this.onmessage?.(new MessageEvent("message", { data })); }
  }
  type ProcessorOptions = {
    controls: SharedArrayBuffer;
    stream: SharedArrayBuffer;
    header: SharedArrayBuffer;
    module: WebAssembly.Module;
    entropy: Uint8Array;
    clockOriginMs: number;
    controlAbiVersion: number;
  };
  class Node {
    port = new Port();
    onprocessorerror: (() => void) | null = null;
    connect = vi.fn();
    disconnect = vi.fn();
    constructor(_context: Context, _name: string, readonly options: { processorOptions: ProcessorOptions }) {
      nodes.push(this);
      if (autoReady) queueMicrotask(() => { this.port.message({ type: "ready" }); });
    }
  }
  const endpoint = () => ({ connect: vi.fn(), disconnect: vi.fn() });
  class Context {
    sampleRate = 48000;
    currentTime = 0;
    state = "running";
    destination = {};
    resume = vi.fn(() => { this.state = "running"; return Promise.resolve(); });
    suspend = vi.fn(() => { this.state = "suspended"; return Promise.resolve(); });
    close = vi.fn(() => { this.state = "closed"; return Promise.resolve(); });
    audioWorklet = { addModule: vi.fn().mockResolvedValue(undefined) };
    createChannelSplitter = endpoint;
    createChannelMerger = endpoint;
    createAnalyser = () => ({ ...endpoint(), fftSize: 4096, smoothingTimeConstant: 0, minDecibels: -120, maxDecibels: 0 });
    createBuffer = () => ({ copyToChannel: vi.fn() });
    createBufferSource = vi.fn(() => ({ ...endpoint(), buffer: null, loop: false, onended: null, start: vi.fn(), stop: vi.fn() }));
    listeners = new Map<string, () => void>();
    addEventListener = vi.fn((type: string, listener: () => void) => { this.listeners.set(type, listener); });
    removeEventListener = vi.fn((type: string) => { this.listeners.delete(type); });
    constructor(readonly options: AudioContextOptions = {}) {
      if (options.sampleRate !== undefined && rates === "reject") throw new DOMException("The sample rate is not supported.", "NotSupportedError");
      if (options.sampleRate !== undefined && rates === "honor") this.sampleRate = options.sampleRate;
      contexts.push(this);
    }
  }
  vi.stubGlobal("crossOriginIsolated", true);
  vi.stubGlobal("AudioContext", Context);
  vi.stubGlobal("AudioWorkletNode", Node);
  vi.stubGlobal("Worker", worker);
  vi.stubGlobal("fetch", fetchModule);
  vi.stubGlobal("requestAnimationFrame", vi.fn().mockReturnValue(1));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  return { contexts, nodes, fetchModule, compiledModule, worker };
}

async function attachedGraph() {
  const harness = graphHarness(true, true, true);
  const identity = { pcmHash: "a".repeat(64), sampleRate: 48000, frames: 48000 };
  const params = engineParams(createDefaultAdvancedParams());
  const script: ScriptV2 = { version: "2.0", source: identity, revision: 1, profile: "Warm Analog", summary: "Explicit baseline", chainParams: params, sections: [{ id: "all", name: "Section 1", roleHint: "unknown", confidence: 0, startFrame: 0, endFrame: 48000 }], moves: [], findings: [], beforeMetrics: { integratedLufs: -18, shortTermLufs: -18, truePeakDbtp: -6, samplePeakDbfs: -6, dynamicRangeDb: 12, correlation: 1, lowBassCorrelation: 1, dcLeftDbfs: -100, dcRightDbfs: -100, clippingSamples: 0, gainReductionDb: 0 } };
  vi.spyOn(automation, "verifiedSourceVector").mockResolvedValue(new Float64Array(11));
  vi.spyOn(automation, "prepareLiveAutomation").mockImplementation((candidate) => Promise.resolve({ source: new Float64Array(11), controls: new Float64Array(82), moves: new Float64Array(0), moveCount: 0, revision: candidate.revision, deviceRate: 48000 }));
  const controller = createLivePlayback(source(), createDefaultAdvancedParams(), {}, { blob: new Blob(), identity });
  await controller.applyScript(script, new AbortController().signal);
  const context = harness.contexts[0], node = harness.nodes[0]; if (!context || !node) throw new Error("Missing attached graph");
  return { ...harness, controller, context, node };
}

const LOUDNESS = { momentaryLufs: -14.2, shortTermLufs: -14.5, integratedLufs: null, loudnessRangeLu: null,
  truePeakDbtp: -1.1, recentTruePeakDbtp: -2.3, gainReductionDb: 3.4 };

describe("per-track live audio lifecycle", () => {
  it("keeps a finite native source and publishes its exact audible deadline before playback", async () => {
    const { contexts, nodes } = graphHarness();
    const controller = createLivePlayback({ sampleRate: 8001, left: new Float32Array(129), right: new Float32Array(129) }, createDefaultAdvancedParams());
    await controller.play(); const context = contexts[0], node = nodes[0]; if (!context || !node) throw new Error("Missing graph");
    expect((context.createBufferSource.mock.results[0]?.value as ReturnType<typeof context.createBufferSource> | undefined)?.loop).toBe(false);
    expect(node.port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "arm", looping: false }));
    const epoch = new Float64Array(node.options.processorOptions.stream, 8, 2);
    expect(epoch[1]).toBe((epoch[0] ?? 0) + Math.ceil(129 * 48000 / 8001) + Math.ceil(48000 * .08 / 128) * 128);
    controller.dispose();
  });
  it("rearms a changed Repeat intent before creating its source", async () => {
    const { contexts, nodes } = graphHarness(true, false); const controller = createLivePlayback(source(), createDefaultAdvancedParams());
    const playing = controller.play(); await vi.waitFor(() => { expect(nodes[0]?.port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "arm" })); });
    const node = nodes[0], context = contexts[0]; if (!node || !context) throw new Error("Missing graph");
    const first = node.port.postMessage.mock.calls.find(([message]) => message.type === "arm")?.[0]; controller.setRepeat(true);
    node.port.message({ type: "stream-armed", generation: first?.generation });
    await vi.waitFor(() => { expect(node.port.postMessage.mock.calls.filter(([message]) => message.type === "arm")).toHaveLength(2); });
    expect(context.createBufferSource).not.toHaveBeenCalled();
    const latest = node.port.postMessage.mock.calls.filter(([message]) => message.type === "arm").at(-1)?.[0]; expect(latest?.looping).toBe(true);
    node.port.message({ type: "stream-armed", generation: latest?.generation }); await playing;
    expect((context.createBufferSource.mock.results[0]?.value as ReturnType<typeof context.createBufferSource> | undefined)?.loop).toBe(true); controller.dispose();
  });
  it("finishes a finite pass before preparing Repeat and cancels a late automatic arm", async () => {
    const { contexts, nodes } = graphHarness(true, false); const controller = createLivePlayback({ sampleRate: 8001, left: new Float32Array(129), right: new Float32Array(129) }, createDefaultAdvancedParams());
    const playing = controller.play(); await vi.waitFor(() => { expect(nodes[0]?.port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "arm" })); });
    const node = nodes[0], context = contexts[0]; if (!node || !context) throw new Error("Missing graph");
    const first = node.port.postMessage.mock.calls.find(([message]) => message.type === "arm")?.[0]; node.port.message({ type: "stream-armed", generation: first?.generation }); await playing;
    controller.setRepeat(true); expect(context.createBufferSource).toHaveBeenCalledOnce();
    const epoch = new Float64Array(node.options.processorOptions.stream, 8, 2); expect(epoch[1]).toBeLessThan(Infinity);
    context.currentTime = (epoch[1] ?? 0) / context.sampleRate + .01;
    node.port.message({ type: "meter", generation: first?.generation, time: context.currentTime, peakDbfs: -6, rmsDbfs: -12, crestDb: 6, correlation: 1, ...LOUDNESS });
    expect(controller.getState()).toMatchObject({ playing: false, loading: true });
    const latest = node.port.postMessage.mock.calls.filter(([message]) => message.type === "arm").at(-1)?.[0]; expect(latest?.generation).not.toBe(first?.generation);
    controller.setRepeat(false); node.port.message({ type: "stream-armed", generation: latest?.generation }); await Promise.resolve(); await Promise.resolve();
    expect(context.createBufferSource).toHaveBeenCalledOnce(); expect(controller.getState()).toMatchObject({ playing: false, loading: false, repeat: false }); controller.dispose();
  });
  it("forwards Go loudness readings and fails on malformed meter packets", async () => {
    const { nodes } = graphHarness(true, false); const meters = vi.fn(), errors = vi.fn();
    const controller = createLivePlayback({ sampleRate: 8001, left: new Float32Array(8001), right: new Float32Array(8001) }, createDefaultAdvancedParams(), { onMeter: meters, onError: errors });
    const playing = controller.play(); await vi.waitFor(() => { expect(nodes[0]?.port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "arm" })); });
    const node = nodes[0]; if (!node) throw new Error("Missing graph");
    const first = node.port.postMessage.mock.calls.find(([message]) => message.type === "arm")?.[0]; node.port.message({ type: "stream-armed", generation: first?.generation }); await playing;
    node.port.message({ type: "meter", generation: first?.generation, time: 0.01, peakDbfs: -6, rmsDbfs: -12, crestDb: 6, correlation: 0.8, ...LOUDNESS });
    expect(meters).toHaveBeenLastCalledWith(expect.objectContaining({ ...LOUDNESS, correlation: 0.8 }));
    node.port.message({ type: "meter", generation: first?.generation, time: 0.02, peakDbfs: -6, rmsDbfs: -12, crestDb: 6, correlation: 0.8, ...LOUDNESS, integratedLufs: Number.NaN });
    expect(errors).toHaveBeenCalledWith(expect.objectContaining({ message: "The live audio meter returned invalid data." }));
    controller.dispose();
  });
  it("stops periodic playback at the next input cycle and can remove that deadline", async () => {
    const { contexts, nodes } = graphHarness(); const controller = createLivePlayback({ sampleRate: 8001, left: new Float32Array(129), right: new Float32Array(129) }, createDefaultAdvancedParams());
    controller.setRepeat(true); await controller.play(); const context = contexts[0], node = nodes[0]; if (!context || !node) throw new Error("Missing graph");
    const epoch = new Float64Array(node.options.processorOptions.stream, 8, 2), start = epoch[0] ?? 0;
    context.currentTime = (start + 1024) / context.sampleRate; controller.setRepeat(false);
    const cycle = Math.floor(1024 * 8001 / (129 * 48000)) + 1;
    expect(epoch[1]).toBe(start + Math.ceil(cycle * 129 * 48000 / 8001) + Math.ceil(48000 * .08 / 128) * 128);
    expect((context.createBufferSource.mock.results[0]?.value as ReturnType<typeof context.createBufferSource> | undefined)?.loop).toBe(true);
    controller.setRepeat(true); expect(epoch[1]).toBe(Infinity); controller.dispose();
  });

  it("rejects a Detach whose settings guard changes during context resume before publishing", async () => {
    const { controller, context, node } = await attachedGraph(); let resume: (() => void) | undefined, current = true;
    context.resume.mockImplementationOnce(() => new Promise<void>((resolve) => { resume = resolve; }));
    const pending = controller.detachScript(createDefaultAdvancedParams(), new AbortController().signal, () => current);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => { expect(resume).toBeTypeOf("function"); }); current = false; resume?.();
    await rejected;
    expect(node.port.postMessage.mock.calls.some(([message]) => message.type === "detach")).toBe(false);
    expect(context.close).not.toHaveBeenCalled(); controller.dispose();
  });
  it("pauses an uncertain Detach ACK whose settings guard became stale", async () => {
    const { controller, context, node } = await attachedGraph(); let current = true;
    const pending = controller.detachScript(createDefaultAdvancedParams(), new AbortController().signal, () => current);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => { expect(node.port.postMessage.mock.calls.some(([message]) => message.type === "detach")).toBe(true); });
    const request = node.port.postMessage.mock.calls.find(([message]) => message.type === "detach")?.[0];
    current = false; node.port.message({ type: "automation-ack", token: request?.token, revision: 0 });
    await rejected; expect(controller.getState()).toMatchObject({ ready: false, playing: false }); expect(context.close).toHaveBeenCalledOnce(); controller.dispose();
  });
  it("defers audio and network initialization until Play and starts in processed A", () => {
    const { contexts, fetchModule, worker } = graphHarness();
    const controller = createLivePlayback(source(), createDefaultAdvancedParams());
    expect(controller.getState()).toMatchObject({ original: false, repeat: false, playing: false, ready: false, loading: false, position: 0 });
    controller.setBypass(true);
    controller.setRepeat(true);
    controller.setVolume(0.25);
    controller.seek(0.5);
    expect(controller.getState()).toMatchObject({ original: true, repeat: true, volume: 0.25, position: 0.5 });
    expect(contexts).toHaveLength(0);
    expect(fetchModule).not.toHaveBeenCalled();
    expect(worker).not.toHaveBeenCalled();
    controller.dispose();
  });
  it("posts one static attenuate-only match gain to the processor and replays it on a new graph (V1-11)", async () => {
    const { contexts, nodes } = graphHarness(true, false);
    const controller = createLivePlayback(source(), createDefaultAdvancedParams());
    expect(controller.getState().loudnessMatch).toEqual({ processedDb: 0, originalDb: 0 });
    controller.setLoudnessMatch({ processedDb: -6, originalDb: 0 });
    expect(controller.getState().loudnessMatch).toEqual({ processedDb: -6, originalDb: 0 });
    // Never a boost or a non-finite value: rejected without changing the applied match.
    for (const invalid of [{ processedDb: 1, originalDb: 0 }, { processedDb: 0, originalDb: Number.NaN }, { processedDb: -Infinity, originalDb: 0 }])
      controller.setLoudnessMatch(invalid);
    expect(controller.getState().loudnessMatch).toEqual({ processedDb: -6, originalDb: 0 });
    const playing = controller.play();
    await vi.waitFor(() => { expect(nodes[0]?.port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "arm" })); });
    const context = contexts[0], node = nodes[0]; if (!context || !node) throw new Error("Missing graph");
    const posted = () => node.port.postMessage.mock.calls.map(([message]) => message as { type?: string; processed?: number; original?: number }).filter((message) => message.type === "match");
    expect(posted()).toHaveLength(1);
    expect(posted()[0]?.processed).toBeCloseTo(10 ** (-6 / 20), 12); expect(posted()[0]?.original).toBe(1);
    controller.setLoudnessMatch(null);
    expect(posted().at(-1)).toMatchObject({ processed: 1, original: 1 });
    expect(controller.getState().loudnessMatch).toEqual({ processedDb: 0, originalDb: 0 });
    const arm = node.port.postMessage.mock.calls.find(([message]) => message.type === "arm")?.[0];
    node.port.message({ type: "stream-armed", generation: arm?.generation }); await playing;
    controller.dispose();
  });
  it("waits for a delayed arm ACK before creating a native source and publishes a fresh shared quantum epoch", async () => {
    const { contexts, nodes } = graphHarness(true, false);
    const controller = createLivePlayback(source(), createDefaultAdvancedParams()); controller.seek(0.1234567);
    const playing = controller.play();
    await vi.waitFor(() => { expect(nodes[0]?.port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "arm" })); });
    const context = contexts[0], node = nodes[0]; if (!context || !node) throw new Error("Missing graph");
    expect(context.createBufferSource).not.toHaveBeenCalled();
    context.currentTime = 4 * 128 / context.sampleRate;
    const arm = node.port.postMessage.mock.calls.find(([message]) => message.type === "arm")?.[0];
    node.port.message({ type: "stream-armed", generation: arm?.generation });
    await playing;
    const created = context.createBufferSource.mock.results[0]?.value as ReturnType<typeof context.createBufferSource> | undefined;
    const start = created?.start.mock.calls[0] as unknown as [number, number];
    expect(start[0]).toBeGreaterThan(context.currentTime);
    expect(start[0] * context.sampleRate / 128).toBeCloseTo(Math.round(start[0] * context.sampleRate / 128), 9);
    expect(start[1]).toBe(Math.floor(0.1234567 * 48000) / 48000);
    const epoch = new Float64Array(node.options.processorOptions.stream, 8, 1);
    expect(epoch[0]).toBe(Math.round(start[0] * context.sampleRate));
    controller.dispose();
  });
  it("keeps the latest seek when a previous playing seek is still awaiting its arm ACK", async () => {
    const { contexts, nodes } = graphHarness(true, false); const controller = createLivePlayback(source(), createDefaultAdvancedParams());
    const playing = controller.play(); await vi.waitFor(() => { expect(nodes[0]?.port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "arm" })); });
    const context = contexts[0], node = nodes[0]; if (!context || !node) throw new Error("Missing graph");
    const first = node.port.postMessage.mock.calls.find(([message]) => message.type === "arm")?.[0]; node.port.message({ type: "stream-armed", generation: first?.generation }); await playing;
    controller.seek(.2); const second = node.port.postMessage.mock.calls.filter(([message]) => message.type === "arm").at(-1)?.[0];
    controller.seek(.7); const latest = node.port.postMessage.mock.calls.filter(([message]) => message.type === "arm").at(-1)?.[0];
    node.port.message({ type: "stream-armed", generation: second?.generation }); await Promise.resolve();
    expect(context.createBufferSource).toHaveBeenCalledTimes(1);
    node.port.message({ type: "stream-armed", generation: latest?.generation });
    await vi.waitFor(() => { expect(controller.getState()).toMatchObject({ playing: true, position: .7 }); });
    expect(context.createBufferSource).toHaveBeenCalledTimes(2); controller.dispose();
  });
  it("does not restart after Pause while the final context resume is pending", async () => {
    const { contexts } = graphHarness(); const controller = createLivePlayback(source(), createDefaultAdvancedParams()); const playing = controller.play();
    const context = contexts[0]; if (!context) throw new Error("Missing context");
    let resume: (() => void) | undefined;
    context.resume.mockResolvedValueOnce(undefined).mockImplementationOnce(() => new Promise<void>((resolve) => { resume = resolve; }));
    await vi.waitFor(() => { expect(context.resume).toHaveBeenCalledTimes(3); });
    controller.pause(); resume?.(); await playing;
    expect(context.createBufferSource).not.toHaveBeenCalled(); expect(controller.getState()).toMatchObject({ playing: false, loading: false }); controller.dispose();
  });
  it("connects before readiness and disposes pending initialization without stale callbacks", async () => {
    const { contexts, nodes, worker } = graphHarness(false);
    const states = vi.fn(), errors = vi.fn();
    const controller = createLivePlayback(source(), createDefaultAdvancedParams(), { onState: states, onError: errors });
    const playing = controller.play();
    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.resume).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => { expect(nodes).toHaveLength(1); });
    const node = nodes[0];
    if (!node) throw new Error("Missing worklet fixture");
    expect(node.connect).toHaveBeenCalledTimes(1);
    expect(controller.getState().loading).toBe(true);
    controller.dispose();
    const callsAfterDispose = states.mock.calls.length;
    node.port.message({ type: "ready" });
    await playing;
    await controller.play();
    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.close).toHaveBeenCalledTimes(1);
    expect(node.disconnect).toHaveBeenCalledTimes(1);
    expect(node.port.close).toHaveBeenCalledTimes(1);
    expect(worker).not.toHaveBeenCalled();
    expect(states).toHaveBeenCalledTimes(callsAfterDispose);
    expect(errors).not.toHaveBeenCalled();
    expect(controller.getState().playing).toBe(false);
  });
  it("publishes current numeric settings and their version together without JSON parameter messages", async () => {
    const { nodes, compiledModule, worker } = graphHarness();
    const settings = createDefaultAdvancedParams();
    const controller = createLivePlayback(source(), settings);
    await controller.play();
    const node = nodes[0];
    if (!node) throw new Error("Missing worklet fixture");
    const options = node.options.processorOptions;
    const publication = new Int32Array(options.controls, 0, 4);
    const values = new Float64Array(options.controls, 16, 81);
    const telemetry = new Int32Array(options.header);
    expect(options.module).toBe(compiledModule);
    expect(options.entropy).toHaveLength(256);
    expect(options.clockOriginMs).toBeGreaterThan(0);
    expect(Array.from(publication)).toEqual([2, 1, 0, 0]);
    expect(values[3]).toBe(settings.input);
    // V1-10: live playback renders the export algorithm and its true-peak limiter.
    expect(options.controlAbiVersion).toBe(2);
    expect(new Float64Array(options.controls, 16, 82)[81]).toBe(2);
    expect(values[50]).toBe(1);
    controller.setParams({ ...settings, input: 6 });
    expect(Array.from(publication)).toEqual([4, 2, 0, 0]);
    expect(values[3]).toBe(6);
    expect(Atomics.load(telemetry, 3)).toBe(2);
    controller.setParams({ ...settings, input: 6 });
    controller.setBypass(true);
    controller.setVolume(0.25);
    expect(Array.from(publication)).toEqual([4, 2, 0, 0]);
    expect(node.port.postMessage.mock.calls).not.toEqual(expect.arrayContaining([
      [expect.objectContaining({ type: "params" })],
    ]));
    expect(worker).not.toHaveBeenCalled();
    expect(controller.getState()).toMatchObject({ playing: true, original: true, volume: 0.25, parameterVersion: 2 });
    controller.dispose();
  });
  it("resumes inside a second Play gesture while module loading is held and rejects the stale play ticket", async () => {
    const { contexts, nodes, fetchModule } = graphHarness();
    let completeFetch: ((response: Response) => void) | undefined;
    fetchModule.mockReturnValue(new Promise<Response>((resolve) => { completeFetch = resolve; }));
    const controller = createLivePlayback(source(), createDefaultAdvancedParams());
    const firstPlay = controller.play();
    const context = contexts[0];
    if (!context) throw new Error("Missing audio context fixture");
    expect(context.resume).toHaveBeenCalledTimes(1);
    controller.pause();
    expect(context.state).toBe("suspended");
    const secondPlay = controller.play();
    // Fetch is unresolved and no worklet can send ready yet. This assertion
    // distinguishes gesture-time resume from a late resume after readiness.
    expect(nodes).toHaveLength(0);
    expect(context.resume).toHaveBeenCalledTimes(2);
    expect(context.state).toBe("running");
    expect(context.createBufferSource).not.toHaveBeenCalled();
    completeFetch?.(new Response(new Uint8Array([0]), { status: 200 }));
    await Promise.all([firstPlay, secondPlay]);
    expect(contexts).toHaveLength(1);
    expect(nodes).toHaveLength(1);
    expect(context.createBufferSource).toHaveBeenCalledOnce();
    expect(controller.getState()).toMatchObject({ ready: true, playing: true, loading: false, error: null });
    controller.dispose();
  });
  it("creates a fresh graph after a processor failure and ignores old graph events", async () => {
    const { contexts, nodes } = graphHarness();
    const errors = vi.fn();
    const controller = createLivePlayback(source(), createDefaultAdvancedParams(), { onError: errors });
    await controller.play();
    const previous = nodes[0];
    if (!previous) throw new Error("Missing worklet fixture");
    previous.onprocessorerror?.();
    expect(controller.getState()).toMatchObject({ ready: false, playing: false, loading: false });
    expect(contexts[0]?.close).toHaveBeenCalledTimes(1);
    await controller.play();
    previous.onprocessorerror?.();
    previous.port.message({ type: "error", message: "stale graph" });
    expect(nodes).toHaveLength(2);
    expect(controller.getState()).toMatchObject({ ready: true, playing: true, error: null });
    expect(errors).toHaveBeenCalledTimes(1);
    controller.dispose();
  });
  it("times out pending module loading and aborts its request", async () => {
    vi.useFakeTimers();
    const { contexts, fetchModule } = graphHarness();
    fetchModule.mockImplementation(() => new Promise<Response>(() => undefined));
    const errors = vi.fn();
    const controller = createLivePlayback(source(), createDefaultAdvancedParams(), { onError: errors });
    const playing = controller.play();
    const request = fetchModule.mock.calls[0]?.[1];
    await vi.advanceTimersByTimeAsync(15_000);
    await playing;
    expect(request?.signal?.aborted).toBe(true);
    expect(contexts[0]?.close).toHaveBeenCalledTimes(1);
    expect(controller.getState()).toMatchObject({ ready: false, playing: false, loading: false });
    expect(controller.getState().error).toContain("timed out");
    expect(errors).toHaveBeenCalledTimes(1);
    controller.dispose();
  });
  it.each(["network rejection", "timeout"])("cleans up %s after Pause and succeeds on the first retry", async (failure) => {
    vi.useFakeTimers();
    const { contexts, nodes, fetchModule } = graphHarness();
    let rejectFetch: ((error: Error) => void) | undefined;
    let completeFetch: ((response: Response) => void) | undefined;
    fetchModule.mockReturnValueOnce(new Promise<Response>((resolve, reject) => {
      completeFetch = resolve;
      rejectFetch = reject;
    }));
    const errors = vi.fn();
    const controller = createLivePlayback(source(), createDefaultAdvancedParams(), { onError: errors });
    const firstPlay = controller.play();
    const firstRequest = fetchModule.mock.calls[0]?.[1];
    controller.pause();
    if (failure === "timeout") await vi.advanceTimersByTimeAsync(15_000);
    else rejectFetch?.(new Error("Network unavailable"));
    await firstPlay;
    expect(contexts[0]?.close).toHaveBeenCalledTimes(1);
    expect(firstRequest?.signal?.aborted).toBe(true);
    expect(controller.getState()).toMatchObject({ ready: false, playing: false, loading: false });
    expect(errors).toHaveBeenCalledTimes(1);
    await controller.play();
    expect(fetchModule).toHaveBeenCalledTimes(2);
    expect(contexts).toHaveLength(2);
    expect(nodes).toHaveLength(1);
    expect(contexts[1]?.createBufferSource).toHaveBeenCalledOnce();
    expect(controller.getState()).toMatchObject({ ready: true, playing: true, loading: false, error: null });
    // A request that ignores abort must not attach a graph to a later retry.
    completeFetch?.(new Response(new Uint8Array([0]), { status: 200 }));
    await vi.waitFor(() => {
      expect(WebAssembly.compile).toHaveBeenCalledTimes(failure === "timeout" ? 2 : 1);
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(nodes).toHaveLength(1);
    expect(contexts[1]?.close).not.toHaveBeenCalled();
    expect(errors).toHaveBeenCalledTimes(1);
    controller.dispose();
  });
  it("reports a shared initialization failure once across overlapping Play attempts", async () => {
    const { contexts, fetchModule } = graphHarness();
    let rejectFetch: ((error: Error) => void) | undefined;
    fetchModule.mockReturnValueOnce(new Promise<Response>((_resolve, reject) => { rejectFetch = reject; }));
    const errors = vi.fn();
    const controller = createLivePlayback(source(), createDefaultAdvancedParams(), { onError: errors });
    const firstPlay = controller.play();
    controller.pause();
    const secondPlay = controller.play();
    rejectFetch?.(new Error("Network unavailable"));
    await Promise.all([firstPlay, secondPlay]);
    expect(contexts[0]?.close).toHaveBeenCalledTimes(1);
    expect(errors).toHaveBeenCalledTimes(1);
    await controller.play();
    expect(fetchModule).toHaveBeenCalledTimes(2);
    expect(controller.getState()).toMatchObject({ ready: true, playing: true, error: null });
    controller.dispose();
  });
  it("ignores a pending request rejection after disposal", async () => {
    const { contexts, fetchModule } = graphHarness();
    let rejectFetch: ((error: Error) => void) | undefined;
    fetchModule.mockReturnValueOnce(new Promise<Response>((_resolve, reject) => { rejectFetch = reject; }));
    const errors = vi.fn(), states = vi.fn();
    const controller = createLivePlayback(source(), createDefaultAdvancedParams(), { onError: errors, onState: states });
    const firstPlay = controller.play();
    controller.pause();
    controller.dispose();
    const callsAfterDispose = states.mock.calls.length;
    rejectFetch?.(new Error("Late network failure"));
    await firstPlay;
    expect(contexts[0]?.close).toHaveBeenCalledTimes(1);
    expect(states).toHaveBeenCalledTimes(callsAfterDispose);
    expect(errors).not.toHaveBeenCalled();
  });
  it("fails explicitly when isolation is missing and clears audible meter values", async () => {
    vi.stubGlobal("crossOriginIsolated", false);
    const meters = vi.fn(), errors = vi.fn();
    const controller = createLivePlayback(source(), createDefaultAdvancedParams(), { onMeter: meters, onError: errors });
    await controller.play();
    expect(controller.getState()).toMatchObject({ playing: false, ready: false, loading: false });
    expect(controller.getState().error).toContain("cross-origin isolation");
    expect(meters).toHaveBeenLastCalledWith(expect.objectContaining({ peakDbfs: -120, rmsDbfs: -120 }));
    expect(errors).toHaveBeenCalledTimes(1);
    controller.dispose();
  });
  it("runs the live engine at the source rate, so A is processed at the export's rate (V1-10)", async () => {
    const { contexts } = graphHarness(true, true, false, "honor");
    const controller = createLivePlayback({ sampleRate: 44100, left: new Float32Array(44100), right: new Float32Array(44100) }, createDefaultAdvancedParams());
    await controller.play();
    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.options).toMatchObject({ sampleRate: 44100, latencyHint: "interactive" });
    expect(controller.getState().liveSampleRate).toBe(44100);
    controller.dispose();
  });
  it("falls back to the device rate when the browser rejects the source rate and reports it", async () => {
    const { contexts } = graphHarness(true, true, false, "reject");
    const controller = createLivePlayback({ sampleRate: 88200, left: new Float32Array(8820), right: new Float32Array(8820) }, createDefaultAdvancedParams());
    await controller.play();
    expect(contexts).toHaveLength(1);
    expect(contexts[0]?.options.sampleRate).toBeUndefined();
    expect(controller.getState()).toMatchObject({ playing: true, liveSampleRate: 48000 });
    controller.dispose();
  });
  it.each([[96000, 48000], [192000, 48000], [88200, 44100], [176400, 44100]])("caps a %i Hz source at %i Hz, an integer ratio inside the 2x real-worklet CPU budget", async (sourceRate, liveRate) => {
    const { contexts } = graphHarness(true, true, false, "honor");
    const frames = sourceRate / 100;
    const controller = createLivePlayback({ sampleRate: sourceRate, left: new Float32Array(frames), right: new Float32Array(frames) }, createDefaultAdvancedParams());
    await controller.play();
    expect(contexts[0]?.options.sampleRate).toBe(liveRate);
    expect(controller.getState().liveSampleRate).toBe(liveRate);
    controller.dispose();
  });
  it("rewatches the worklet's deadline watch on a context state change or an audio device change", async () => {
    const devices = new EventTarget();
    vi.stubGlobal("navigator", { mediaDevices: devices });
    const { contexts, nodes } = graphHarness();
    const controller = createLivePlayback(source(), createDefaultAdvancedParams());
    await controller.play();
    const context = contexts[0], node = nodes[0]; if (!context || !node) throw new Error("Missing graph");
    context.listeners.get("statechange")?.();
    devices.dispatchEvent(new Event("devicechange"));
    expect(node.port.postMessage.mock.calls.filter(([message]) => message.type === "rewatch")).toHaveLength(2);
    controller.dispose();
    expect(context.removeEventListener).toHaveBeenCalledWith("statechange", expect.any(Function));
    node.port.postMessage.mockClear();
    devices.dispatchEvent(new Event("devicechange"));
    expect(node.port.postMessage).not.toHaveBeenCalled();
  });
  it("rejects unsupported source layouts and leaves settings immutable", () => {
    const settings = createDefaultAdvancedParams();
    const before = structuredClone(settings);
    const controller = createLivePlayback(source(), settings);
    controller.setParams({ ...settings, input: 6 });
    expect(controller.getState().parameterVersion).toBe(2);
    controller.setParams({ ...settings, input: 6 });
    expect(controller.getState().parameterVersion).toBe(2);
    expect(settings).toEqual(before);
    expect(() => createLivePlayback({ ...source(), sampleRate: 7999 }, settings)).toThrow("8–192");
    expect(() => createLivePlayback({ ...source(), right: new Float32Array(2) }, settings)).toThrow("stereo PCM");
    controller.dispose();
  });
});
