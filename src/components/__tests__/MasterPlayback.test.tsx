import { Blob as NodeBlob } from "node:buffer";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { previewWAV, type StereoPCM } from "@/lib/browser-engine";
import * as engine from "@/lib/browser-engine";
import { clampAdvancedToSampleRate, createDefaultAdvancedParams, mapSimpleToDSP } from "@/lib/audio-dsp";
import type { AdvancedParams } from "@/lib/types";
import type { LiveMeter, LivePlaybackController, LivePlaybackState, LiveSpectrum } from "@/lib/live-playback";
import { StoreProvider } from "@/lib/store";
import { testStore } from "@/lib/__tests__/fixtures";
import { AurialisWorkstation } from "../AurialisWorkstation";

// cspell:words seekto previoustrack nexttrack

const mocks = vi.hoisted(() => ({ getAudio: vi.fn(), createLivePlayback: vi.fn(), push: vi.fn() }));
vi.mock("@/lib/db", () => ({ getAudio: mocks.getAudio, saveAudio: vi.fn(), deleteAudio: vi.fn() }));
vi.mock("@/lib/live-playback", () => ({ createLivePlayback: mocks.createLivePlayback }));
vi.mock("next/navigation", () => ({ usePathname: () => null }));
vi.mock("@/lib/workspace-navigation", async (original) => ({ ...await original<typeof import("@/lib/workspace-navigation")>(), navigateWorkspace: mocks.push }));

type Callbacks = {
  onState?: (state: LivePlaybackState) => void;
  onMeter?: (meter: LiveMeter) => void;
  onSpectrum?: (spectrum: LiveSpectrum) => void;
  onError?: (error: Error) => void;
};
type Instance = { controller: LivePlaybackController; callbacks: Callbacks; state: LivePlaybackState };
const instances: Instance[] = [];
const pcm: StereoPCM = { left: Float32Array.from({ length: 4800 }, (_, index) => 0.25 * Math.sin(index / 13)), right: new Float32Array(4800), sampleRate: 48000 };

function mount() { return render(<StoreProvider><AurialisWorkstation route="master" paramId="demo-1" /></StoreProvider>); }
async function ready() { await waitFor(() => { expect(screen.getByRole<HTMLButtonElement>("button", { name: "A Processed" }).disabled).toBe(false); }, { timeout: 10000 }); }
function savedTrack() { const saved = JSON.parse(localStorage.getItem("aurialis-state-v1") ?? "{}") as typeof testStore; const track = saved.tracks[0]; if (!track) throw new Error("No persisted track"); return track; }
function latest() { const instance = instances.at(-1); if (!instance) throw new Error("No live controller was constructed"); return instance; }

beforeEach(() => {
  vi.spyOn(window, "scrollTo").mockImplementation(() => undefined);
  vi.stubGlobal("Blob", NodeBlob);
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Network unavailable")));
  const storage = new Map([["aurialis-state-v1", JSON.stringify({ ...testStore, tracks: testStore.tracks.slice(0, 1) })]]);
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value); } });
  instances.length = 0;
  window.history.replaceState(null, "", "/master/demo-1");
  mocks.push.mockReset().mockImplementation((href: string) => { window.history.replaceState(null, "", href); });
  mocks.getAudio.mockReset().mockResolvedValue(previewWAV(pcm));
  mocks.createLivePlayback.mockReset().mockImplementation((_source: StereoPCM, _settings: AdvancedParams, callbacks: Callbacks) => {
    const instance: Instance = { controller: {} as LivePlaybackController, callbacks,
      state: { position: 0, duration: 0.1, playing: false, ready: false, loading: false, original: false, volume: 0.8, repeat: false, underruns: 0, parameterVersion: 1, appliedVersion: 1, error: null } };
    const update = (patch: Partial<LivePlaybackState>) => { instance.state = { ...instance.state, ...patch }; callbacks.onState?.(instance.state); };
    instance.controller = {
      play: vi.fn(() => { update({ playing: true, ready: true }); return Promise.resolve(); }),
      pause: vi.fn(() => { update({ playing: false }); }),
      seek: vi.fn((position: number) => { update({ position }); }),
      setParams: vi.fn(), applyScript: vi.fn(), detachScript: vi.fn(), setBypass: vi.fn((original: boolean) => { update({ original }); }),
      setVolume: vi.fn((volume: number) => { update({ volume }); }),
      setRepeat: vi.fn((repeat: boolean) => { update({ repeat }); }),
      dispose: vi.fn(), getState: () => instance.state,
    };
    instances.push(instance);
    return instance.controller;
  });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("master live playback lifecycle", () => {
  it("loads canonical stored PCM offline, applies settings live, and clears meters on pause", async () => {
    mount();
    await ready();
    expect(fetch).not.toHaveBeenCalled();
    const instance = latest();
    expect(mocks.createLivePlayback.mock.calls[0]?.[0]).toEqual(pcm);
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    await screen.findByRole("button", { name: "Pause" });
    act(() => { instance.callbacks.onMeter?.({ peakDbfs: -12.3, rmsDbfs: -20.1, crestDb: 7.8, correlation: 0.5, position: 0.02, underruns: 0,
      momentaryLufs: -13.94, shortTermLufs: -14.26, integratedLufs: null, loudnessRangeLu: 4.04, truePeakDbtp: -0.96, recentTruePeakDbtp: -2.31, gainReductionDb: 3.36 }); });
    expect(screen.getByRole("region", { name: "Measured audio levels" }).textContent).toContain("-12.3");
    const loudness = screen.getByRole("region", { name: "Live loudness of the processed output" }).textContent;
    for (const text of ["-14.3", "M -13.9", "4.0", "-1.0", "now -2.3", "3.4", "0.50"]) expect(loudness).toContain(text);
    fireEvent.change(screen.getByRole("slider", { name: "Input gain" }), { target: { value: "6" } });
    await waitFor(() => { expect(instance.controller.setParams).toHaveBeenLastCalledWith(expect.objectContaining({ input: 6 })); });
    expect(instance.controller.play).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "B Original" }));
    expect(instance.controller.setBypass).toHaveBeenCalledWith(true);
    expect(screen.getByRole("button", { name: "Pause" })).toBeTruthy();
    act(() => { instance.callbacks.onMeter?.({ peakDbfs: -120, rmsDbfs: -120, crestDb: 0, correlation: 0, position: 0.03, underruns: 0,
      momentaryLufs: null, shortTermLufs: null, integratedLufs: null, loudnessRangeLu: null, truePeakDbtp: -120, recentTruePeakDbtp: -120, gainReductionDb: 0 }); });
    expect(screen.getByRole("region", { name: "Live loudness of the processed output" }).textContent).toContain("−∞");
    expect(screen.getByRole("region", { name: "Measured audio levels" }).textContent).toContain("−∞");
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(screen.getByRole("region", { name: "Measured audio levels" }).textContent).not.toContain("−∞");
  }, 20000);

  it("shows pro-convention readouts for shelf midpoint, bell Q, mono bass and compressor times", async () => {
    mount(); await ready();
    const description = (name: string) => {
      const ids = screen.getByRole("slider", { name }).getAttribute("aria-describedby")?.split(" ") ?? [];
      return ids.map((id) => document.getElementById(id)?.textContent ?? "").join(" ");
    };
    fireEvent.click(screen.getByRole("tab", { name: "advanced" }));
    fireEvent.click(screen.getByRole("tab", { name: "Sub" }));
    expect(description("Sub frequency")).toContain("Shelf midpoint (half gain) ≈ 111 Hz");
    fireEvent.click(screen.getByRole("tab", { name: "Mid" }));
    fireEvent.change(screen.getByRole("slider", { name: "Mid gain" }), { target: { value: "6" } });
    expect(description("Mid Q")).toContain("Effective bell Q at +6 dB ≈ 2.50");
    expect(description("Attack")).toContain("time constant ≈ 10.0 ms");
    expect(description("Bass mono frequency")).toContain("Side is −3 dB at ≈ 242 Hz");
  }, 20000);
  it.each(["Media Session", "Space"])("accepts %s pause and resume while playback initialization is pending", async (input) => {
    const handlers = new Map<MediaSessionAction, MediaSessionActionHandler | null>();
    vi.stubGlobal("navigator", { mediaSession: {
      metadata: null, playbackState: "none", setPositionState: vi.fn(),
      setActionHandler: (action: MediaSessionAction, handler: MediaSessionActionHandler | null) => { handlers.set(action, handler); },
    } });
    mount(); await ready();
    const instance = latest();
    let release: (() => void) | undefined;
    const initialized = new Promise<void>((resolve) => { release = resolve; });
    let ticket = 0;
    const update = (patch: Partial<LivePlaybackState>) => {
      instance.state = { ...instance.state, ...patch };
      instance.callbacks.onState?.(instance.state);
    };
    vi.mocked(instance.controller.play).mockImplementation(async () => {
      const current = ++ticket;
      update({ loading: true });
      await initialized;
      if (current === ticket) update({ loading: false, playing: true, ready: true });
    });
    vi.mocked(instance.controller.pause).mockImplementation(() => { ticket++; update({ loading: false, playing: false }); });
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Starting playback" }).disabled).toBe(true);
    act(() => {
      handlers.get("seekto")?.({ action: "seekto", seekTime: 0.05 });
      handlers.get("previoustrack")?.({ action: "previoustrack" });
      handlers.get("nexttrack")?.({ action: "nexttrack" });
    });
    fireEvent.keyDown(document.body, { key: "ArrowRight" });
    expect(instance.controller.seek).not.toHaveBeenCalled();
    expect(mocks.push).not.toHaveBeenCalled();
    function press(action: "play" | "pause") {
      if (input === "Space") fireEvent.keyDown(document.body, { key: " ", code: "Space" });
      else act(() => { handlers.get(action)?.({ action }); });
    }
    press("pause");
    expect(instance.controller.pause).toHaveBeenCalledOnce();
    expect(instance.state.playing).toBe(false);
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Play" }).disabled).toBe(false);
    press("play");
    expect(instance.controller.play).toHaveBeenCalledTimes(2);
    expect(instance.state.loading).toBe(true);
    expect(instance.state.playing).toBe(false);
    await act(async () => { release?.(); await initialized; });
    await screen.findByRole("button", { name: "Pause" });
    expect(instance.state.playing).toBe(true);
    expect(instance.controller.play).toHaveBeenCalledTimes(2);
  }, 20000);

  it("persists Simple choices to shared params and keeps modes neutral before and after manual edits", async () => {
    mount(); await ready();
    const instance = latest();
    fireEvent.click(screen.getByRole("tab", { name: "simple" }));
    expect(screen.getByText("Custom settings")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Warm" }));
    const mapped = mapSimpleToDSP("Pop", "Warm", 50, "Streaming");
    expect(savedTrack().advanced).toEqual(mapped);
    expect(instance.controller.setParams).toHaveBeenLastCalledWith(mapped);
    const offline = vi.spyOn(engine, "processPreview").mockResolvedValue(pcm);
    fireEvent.click(screen.getByRole("button", { name: "Render offline preview" }));
    await screen.findByRole("button", { name: "Download offline preview" });
    const calls = vi.mocked(instance.controller.setParams).mock.calls.length;
    fireEvent.click(screen.getByRole("tab", { name: "advanced" }));
    fireEvent.click(screen.getByRole("tab", { name: "simple" }));
    expect(savedTrack().advanced).toEqual(mapped);
    expect(instance.controller.setParams).toHaveBeenCalledTimes(calls);
    expect(screen.getByRole("button", { name: "Download offline preview" })).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Export" }).disabled).toBe(false);
    fireEvent.click(screen.getByRole("tab", { name: "advanced" }));
    fireEvent.change(screen.getByRole("slider", { name: "Input gain" }), { target: { value: "6" } });
    fireEvent.click(screen.getByRole("tab", { name: "Mid" }));
    fireEvent.change(screen.getByRole("slider", { name: "Mid gain" }), { target: { value: "5" } });
    const custom = savedTrack().advanced; const customCalls = vi.mocked(instance.controller.setParams).mock.calls.length;
    fireEvent.click(screen.getByRole("tab", { name: "simple" }));
    expect(screen.getByText("Custom settings")).toBeTruthy();
    for (const name of ["Pop", "Hip-hop", "Rock", "Electronic", "Acoustic", "R&B", "Warm", "Open", "Punchy", "Intimate", "Wide", "Clean"]) expect(screen.getByRole("button", { name }).getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(screen.getByRole("tab", { name: "advanced" }));
    expect(savedTrack().advanced).toEqual(custom);
    expect(instance.controller.setParams).toHaveBeenCalledTimes(customCalls);
    expect(offline).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("tab", { name: "simple" }));
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    // Retain explicit input gain so a headroom correction survives a new direction.
    expect(savedTrack().advanced).toEqual({ ...mapSimpleToDSP("Pop", "Open", 50, "Streaming"), input: 6 });
    expect(screen.queryByText("Custom settings")).toBeNull();
  }, 30000);

  it("normalizes only current canonical input gain and preserves an in-flight operation across view changes", async () => {
    mount(); await ready();
    const instance = latest();
    fireEvent.change(screen.getByRole("slider", { name: "Input gain" }), { target: { value: "6" } });
    fireEvent.click(screen.getByRole("tab", { name: "Mid" }));
    fireEvent.change(screen.getByRole("slider", { name: "Mid gain" }), { target: { value: "5" } });
    const expected = savedTrack().advanced;
    let resolveMeasured: ((params: AdvancedParams) => void) | undefined;
    const normalize = vi.spyOn(engine, "normalizeSimpleAudio").mockReturnValue(new Promise((resolve) => { resolveMeasured = resolve; }));
    const offline = vi.spyOn(engine, "processPreview").mockResolvedValue(pcm);
    fireEvent.click(screen.getByRole("tab", { name: "simple" }));
    fireEvent.click(screen.getByRole("button", { name: "Set target loudness" }));
    expect(normalize).toHaveBeenCalledWith(expect.any(Blob), expected, expected.limiter.targetLufs, expect.any(AbortSignal));
    const calls = vi.mocked(instance.controller.setParams).mock.calls.length;
    fireEvent.click(screen.getByRole("tab", { name: "advanced" }));
    expect(instance.controller.setParams).toHaveBeenCalledTimes(calls);
    await act(async () => { resolveMeasured?.({ ...expected, input: 4, stereo: { ...expected.stereo, width: 199 } }); await Promise.resolve(); });
    const prepared = { ...expected, input: 4 };
    expect(savedTrack().advanced).toEqual(prepared);
    expect(instance.controller.setParams).toHaveBeenLastCalledWith(prepared);
    expect(offline).toHaveBeenCalledWith(pcm, prepared, expect.any(AbortSignal));
    fireEvent.click(screen.getByRole("tab", { name: "simple" }));
    expect(screen.getByText("Custom settings")).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox", { name: "Output target" }), { target: { value: "Loud" } });
    expect(savedTrack().advanced).toEqual({ ...prepared, limiter: { ...prepared.limiter, targetLufs: -9, ceiling: -0.2 } });
    expect(screen.getByText("Custom settings")).toBeTruthy();
  }, 30000);

  it("displays and measures the canonical target after reset or an unmatched profile", async () => {
    mount(); await ready();
    fireEvent.click(screen.getByRole("tab", { name: "simple" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Output target" }), { target: { value: "Loud" } });
    fireEvent.click(screen.getByRole("tab", { name: "advanced" }));
    fireEvent.click(screen.getByRole("button", { name: "Reset modules" }));
    const reset = savedTrack().advanced;
    fireEvent.click(screen.getByRole("tab", { name: "simple" }));
    expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "Output target" }).value).toBe("Streaming");
    expect(savedTrack().advanced).toEqual(reset);
    fireEvent.click(screen.getByRole("button", { name: "Rock" }));
    expect(savedTrack().advanced.limiter.targetLufs).toBe(-14);
    const custom = { ...savedTrack().advanced, limiter: { ...savedTrack().advanced.limiter, targetLufs: -12, ceiling: -0.7 } };
    cleanup();
    localStorage.setItem("aurialis-state-v1", JSON.stringify({ ...testStore, tracks: testStore.tracks.slice(0, 1).map((track) => ({ ...track, mode: "simple", target: "Streaming", advanced: custom })) }));
    mount(); await ready();
    expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "Output target" }).value).toBe("custom");
    expect(screen.getByRole("option", { name: "Custom (−12 LUFS)" })).toBeTruthy();
    expect(screen.getByText(/Current target: −12 LUFS · ceiling −0.7 dBFS/)).toBeTruthy();
    const normalize = vi.spyOn(engine, "normalizeSimpleAudio").mockResolvedValue(custom);
    vi.spyOn(engine, "processPreview").mockResolvedValue(pcm);
    fireEvent.click(screen.getByRole("button", { name: "Set target loudness" }));
    await waitFor(() => { expect(normalize).toHaveBeenCalledWith(expect.any(Blob), custom, -12, expect.any(AbortSignal)); });
  }, 30000);

  it("disposes on leaving and constructs a new playable engine on return without stale callbacks", async () => {
    const first = mount();
    await ready();
    const previous = latest();
    first.unmount();
    expect(previous.controller.dispose).toHaveBeenCalledOnce();
    mount();
    await ready();
    const current = latest();
    expect(current.controller).not.toBe(previous.controller);
    act(() => { previous.callbacks.onState?.({ ...previous.state, playing: true, position: 0.09, original: true }); previous.callbacks.onError?.(new Error("Disposed engine")); });
    expect(screen.getByRole("button", { name: "A Processed" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryByText("Disposed engine")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    await screen.findByRole("button", { name: "Pause" });
    expect(current.controller.play).toHaveBeenCalledOnce();
    expect(previous.controller.play).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  }, 20000);

  it("offers an honest retry for missing audio and enables A/B only after it is restored", async () => {
    mocks.getAudio.mockResolvedValueOnce(undefined);
    mount();
    await screen.findByRole("button", { name: "Retry source" });
    expect(mocks.createLivePlayback).not.toHaveBeenCalled();
    for (const name of ["A Processed", "B Original", "Play", "Render offline preview"]) expect(screen.getByRole<HTMLButtonElement>("button", { name }).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Retry source" }));
    await ready();
    expect(mocks.createLivePlayback).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "Retry source" })).toBeNull();
  }, 20000);

  it("resets sliders to canonical module and sample-rate-safe EQ defaults without changing other fields", async () => {
    const defaults = clampAdvancedToSampleRate(createDefaultAdvancedParams(), 8000);
    const advanced = { ...defaults, input: 6,
      compressor: { ...defaults.compressor, threshold: -24, ratio: 4, attack: 47, release: 300 },
      stereo: { ...defaults.stereo, width: 140 }, saturationModule: { ...defaults.saturationModule, drive: 35 },
      limiter: { ...defaults.limiter, ceiling: -2 },
      eqBands: defaults.eqBands.map((band) => band.id === "air" ? { ...band, freqHz: 1000, gainDb: 6, q: 2, enabled: false } : band),
    };
    localStorage.setItem("aurialis-state-v1", JSON.stringify({ ...testStore, tracks: testStore.tracks.slice(0, 1).map((track) => ({ ...track, sampleRate: 8000, advanced })) }));
    mocks.getAudio.mockResolvedValue(previewWAV({ ...pcm, sampleRate: 8000 }));
    mount();
    await ready();
    const instance = latest();
    fireEvent.doubleClick(screen.getByRole("slider", { name: "Input gain" }));
    expect(instance.controller.setParams).toHaveBeenLastCalledWith(expect.objectContaining({ input: 0, compressor: advanced.compressor }));
    for (const label of ["Threshold", "Ratio", "Attack", "Release", "Stereo width", "Saturation", "Limiter ceiling"]) fireEvent.doubleClick(screen.getByRole("slider", { name: label }));
    fireEvent.click(screen.getByRole("tab", { name: "Air" }));
    for (const label of ["Air frequency", "Air gain", "Air Q"]) fireEvent.doubleClick(screen.getByRole("slider", { name: label }));
    const actual = vi.mocked(instance.controller.setParams).mock.lastCall?.[0];
    expect(actual?.compressor).toEqual(defaults.compressor);
    expect(actual?.stereo).toEqual(defaults.stereo);
    expect(actual?.saturationModule).toEqual(defaults.saturationModule);
    expect(actual?.limiter).toEqual(defaults.limiter);
    expect(actual?.eqBands.find((band) => band.id === "air")).toEqual({ ...defaults.eqBands.find((band) => band.id === "air"), enabled: false });
    fireEvent.click(screen.getByRole("tab", { name: "simple" }));
    fireEvent.change(screen.getByRole("slider", { name: "Intensity" }), { target: { value: "87" } });
    fireEvent.doubleClick(screen.getByRole("slider", { name: "Intensity" }));
    expect(screen.getByRole<HTMLInputElement>("slider", { name: "Intensity" }).value).toBe("50");
  }, 30000);

  it("restarts and skips within the current track without changing play or repeat state", async () => {
    mount();
    await ready();
    const instance = latest();
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    fireEvent.click(screen.getByRole("button", { name: "Repeat track" }));
    expect(instance.controller.setRepeat).toHaveBeenCalledWith(true);
    expect(screen.getByRole("button", { name: "Repeat track" }).getAttribute("aria-pressed")).toBe("true");
    act(() => { instance.state = { ...instance.state, position: 0.05 }; instance.callbacks.onState?.(instance.state); });
    fireEvent.click(screen.getByRole("button", { name: "Restart track" }));
    expect(instance.controller.seek).toHaveBeenLastCalledWith(0);
    expect(instance.state.playing).toBe(true);
    expect(instance.state.repeat).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Skip forward 10 seconds" }));
    expect(instance.controller.seek).toHaveBeenLastCalledWith(0.1);
    expect(instance.state.playing).toBe(true);
    expect(mocks.push).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    fireEvent.click(screen.getByRole("button", { name: "Restart track" }));
    expect(instance.state.playing).toBe(false);
  }, 20000);

  it.each([{ wasPlaying: true, atEnd: false }, { wasPlaying: false, atEnd: false }, { wasPlaying: true, atEnd: true }])("scrubs without Next and restores playing=$wasPlaying unless reaching the end=$atEnd", async ({ wasPlaying, atEnd }) => {
    localStorage.setItem("aurialis-state-v1", JSON.stringify(testStore));
    mount(); await ready();
    const instance = latest();
    if (wasPlaying) fireEvent.click(screen.getByRole("button", { name: "Play" }));
    const start = atEnd ? 99.95 : 20;
    act(() => { instance.state = { ...instance.state, position: start, duration: 100 }; instance.callbacks.onState?.(instance.state); });
    const frames = new Map<number, FrameRequestCallback>(); let frameId = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => { frames.delete(id); });
    const clock = vi.spyOn(performance, "now").mockReturnValue(1000);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const button = screen.getByRole("button", { name: "Next track: Test source" });
    fireEvent.keyDown(button, { key: "Enter" });
    act(() => { vi.advanceTimersByTime(300); });
    expect(instance.state.playing).toBe(false);
    function frame(time: number) { clock.mockReturnValue(time); const callbacks = [...frames.values()]; frames.clear(); act(() => { for (const callback of callbacks) callback(time); }); }
    frame(1050); expect(instance.state.position).toBeCloseTo(Math.min(100, start + 0.1));
    frame(2100); expect(instance.state.position).toBeCloseTo(Math.min(100, start + 1.1));
    frame(4100); expect(instance.state.position).toBeCloseTo(Math.min(100, start + 3.1));
    fireEvent.keyUp(button, { key: "Enter" });
    fireEvent.click(button);
    expect(instance.state.playing).toBe(wasPlaying && !atEnd);
    expect(instance.controller.play).toHaveBeenCalledTimes(wasPlaying ? atEnd ? 1 : 2 : 0);
    expect(mocks.push).not.toHaveBeenCalled();
    expect(frames.size).toBe(0);
  }, 20000);

  it("opens the next Library project with a fresh graph and preserves only play intent and volume", async () => {
    localStorage.setItem("aurialis-state-v1", JSON.stringify({ ...testStore, tracks: testStore.tracks.map((track, index) => ({ ...track, title: index === 0 ? "First source" : "Next source" })) }));
    const view = mount();
    await ready();
    const previous = latest();
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    fireEvent.change(screen.getByRole("slider", { name: "Playback volume" }), { target: { value: "0.4" } });
    fireEvent.click(screen.getByRole("button", { name: "Repeat track" }));
    fireEvent.click(screen.getByRole("button", { name: "B Original" }));
    fireEvent.click(screen.getByRole("button", { name: "Next track: Next source" }));
    expect(mocks.push).toHaveBeenCalledExactlyOnceWith("/master/test-2");
    expect(previous.controller.pause).toHaveBeenCalledOnce();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Next track: Next source" }).disabled).toBe(true);
    view.rerender(<StoreProvider><AurialisWorkstation route="master" paramId="test-2" /></StoreProvider>);
    await ready();
    const current = latest();
    expect(current.controller).not.toBe(previous.controller);
    expect(previous.controller.dispose).toHaveBeenCalledOnce();
    expect(current.controller.play).toHaveBeenCalledOnce();
    expect(current.controller.setVolume).toHaveBeenCalledWith(0.4);
    expect(current.state.original).toBe(false);
    expect(current.state.repeat).toBe(false);
    expect(mocks.getAudio).toHaveBeenLastCalledWith("test-2");
    expect(screen.getByRole("button", { name: "Skip forward 10 seconds" })).toBeTruthy();
  }, 20000);

  it("does not create an engine when an old source load resolves after navigation", async () => {
    let resolveSource: ((value: Blob) => void) | undefined;
    mocks.getAudio.mockReturnValueOnce(new Promise<Blob>((resolve) => { resolveSource = resolve; }));
    const view = mount();
    await waitFor(() => { expect(mocks.getAudio).toHaveBeenCalledOnce(); });
    view.unmount();
    await act(async () => { resolveSource?.(previewWAV(pcm)); await Promise.resolve(); });
    expect(mocks.createLivePlayback).not.toHaveBeenCalled();
  }, 20000);
});
