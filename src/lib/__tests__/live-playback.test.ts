import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultAdvancedParams } from "../audio-dsp";
import { createLivePlayback } from "../live-playback";

const source = () => ({ sampleRate: 48000, left: new Float32Array(48000), right: new Float32Array(48000) });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

function graphHarness(autoReady = true) {
  const contexts: Context[] = [];
  const nodes: Node[] = [];
  const worker = vi.fn();
  const compiledModule = new WebAssembly.Module(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
  const fetchModule = vi.fn<typeof fetch>(() => Promise.resolve(new Response(new Uint8Array([0]), { status: 200 })));
  vi.spyOn(WebAssembly, "compile").mockResolvedValue(compiledModule);
  class Port {
    onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
    postMessage = vi.fn();
    close = vi.fn();
    message(data: unknown) { this.onmessage?.(new MessageEvent("message", { data })); }
  }
  type ProcessorOptions = {
    controls: SharedArrayBuffer;
    header: SharedArrayBuffer;
    module: WebAssembly.Module;
    entropy: Uint8Array;
    clockOriginMs: number;
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
    constructor() { contexts.push(this); }
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

describe("per-track live audio lifecycle", () => {
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
