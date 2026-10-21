import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultAdvancedParams } from "../audio-dsp";
import { createLivePlayback } from "../live-playback";

const source = () => ({ sampleRate: 48000, left: new Float32Array(48000), right: new Float32Array(48000) });
afterEach(() => vi.unstubAllGlobals());

describe("per-track live audio lifecycle", () => {
  it("defers all audio/network initialization until Play and starts in processed A", () => {
    const context = vi.fn();
    const worker = vi.fn();
    vi.stubGlobal("AudioContext", context);
    vi.stubGlobal("Worker", worker);
    const controller = createLivePlayback(source(), createDefaultAdvancedParams());
    expect(controller.getState()).toMatchObject({ original: false, repeat: false, playing: false, ready: false, loading: false, position: 0 });
    controller.setBypass(true);
    controller.setRepeat(true);
    controller.setVolume(0.25);
    controller.seek(0.5);
    expect(controller.getState()).toMatchObject({ original: true, repeat: true, volume: 0.25, position: 0.5 });
    expect(context).not.toHaveBeenCalled();
    expect(worker).not.toHaveBeenCalled();
    controller.dispose();
  });
  it("settles a disposed initialization without stale callbacks or recreating a closed graph", async () => {
    const states = vi.fn(), errors = vi.fn();
    const close = vi.fn().mockResolvedValue(undefined), terminate = vi.fn();
    const contexts: object[] = [];
    const workers: { onmessage?: ((event: MessageEvent<unknown>) => void) | null }[] = [];
    class Context {
      sampleRate = 48000;
      state = "running";
      resume = vi.fn().mockResolvedValue(undefined);
      close = close;
      audioWorklet = { addModule: vi.fn().mockResolvedValue(undefined) };
      constructor() { contexts.push(this); }
    }
    class Worker {
      onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
      onerror = null;
      postMessage = vi.fn();
      terminate = terminate;
      constructor() { workers.push(this); }
    }
    vi.stubGlobal("crossOriginIsolated", true);
    vi.stubGlobal("AudioContext", Context);
    vi.stubGlobal("Worker", Worker);
    const controller = createLivePlayback(source(), createDefaultAdvancedParams(), { onState: states, onError: errors });
    const playing = controller.play();
    expect(contexts).toHaveLength(1);
    controller.dispose();
    const callsAfterDispose = states.mock.calls.length;
    workers[0]?.onmessage?.(new MessageEvent("message", { data: { type: "ready" } }));
    await playing;
    await controller.play();
    expect(contexts).toHaveLength(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(terminate).toHaveBeenCalledTimes(1);
    expect(states).toHaveBeenCalledTimes(callsAfterDispose);
    expect(errors).not.toHaveBeenCalled();
    expect(controller.getState().playing).toBe(false);
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
