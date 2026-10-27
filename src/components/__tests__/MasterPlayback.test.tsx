import { Blob as NodeBlob } from "node:buffer";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { StereoPCM } from "@/lib/browser-engine";
import * as engine from "@/lib/browser-engine";
import { clampAdvancedToSampleRate, createDefaultAdvancedParams, mapSimpleToDSP } from "@/lib/audio-dsp";
import type { AdvancedParams } from "@/lib/types";
import type { LiveMeter, LivePlaybackController, LivePlaybackState, LiveSpectrum } from "@/lib/live-playback";
import { StoreProvider } from "@/lib/store";
import { canonicalWAV, testStore } from "@/lib/__tests__/fixtures";
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
const exportMetrics = { integratedLufs: -9.0143, shortTermLufs: -9, truePeakDbtp: -0.3006, samplePeakDbfs: -0.44, dynamicRangeDb: 8, correlation: 1, lowBassCorrelation: 1, dcLeftDbfs: -120, dcRightDbfs: -120, clippingSamples: 0, gainReductionDb: 3 };

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
  mocks.getAudio.mockReset().mockResolvedValue(canonicalWAV(pcm));
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
      setLoudnessMatch: vi.fn((match: { processedDb: number; originalDb: number } | null) => { update({ loudnessMatch: match ?? { processedDb: 0, originalDb: 0 } }); }),
      setRepeat: vi.fn((repeat: boolean) => { update({ repeat }); }),
      dispose: vi.fn(), getState: () => instance.state,
    };
    instances.push(instance);
    return instance.controller;
  });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

/** Requests other than Master's read-only Smart Split availability check. */
const audioRequests = () => vi.mocked(fetch).mock.calls.filter(([input]) => input !== "/api/stems/model");

describe("master live playback lifecycle", () => {
  it("loads canonical stored PCM offline, applies settings live, and clears meters on pause", async () => {
    mount();
    await ready();
    expect(audioRequests()).toEqual([]);
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
    const calls = vi.mocked(instance.controller.setParams).mock.calls.length;
    fireEvent.click(screen.getByRole("tab", { name: "advanced" }));
    fireEvent.click(screen.getByRole("tab", { name: "simple" }));
    expect(savedTrack().advanced).toEqual(mapped);
    expect(instance.controller.setParams).toHaveBeenCalledTimes(calls);
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
    let resolveMeasured: ((result: Awaited<ReturnType<typeof engine.normalizeSimpleAudio>>) => void) | undefined;
    const normalize = vi.spyOn(engine, "normalizeSimpleAudio").mockReturnValue(new Promise((resolve) => { resolveMeasured = resolve; }));
    fireEvent.click(screen.getByRole("tab", { name: "simple" }));
    fireEvent.click(screen.getByRole("button", { name: "Set target loudness" }));
    expect(normalize).toHaveBeenCalledWith(expect.any(Blob), expected, expected.limiter.targetLufs, expect.any(AbortSignal));
    const calls = vi.mocked(instance.controller.setParams).mock.calls.length;
    fireEvent.click(screen.getByRole("tab", { name: "advanced" }));
    expect(instance.controller.setParams).toHaveBeenCalledTimes(calls);
    await act(async () => { resolveMeasured?.({ advanced: { ...expected, input: 4, stereo: { ...expected.stereo, width: 199 } }, measurement: { sampleRate: 48000, frames: 4800, duration: 0.1, beforeMetrics: exportMetrics, afterMetrics: exportMetrics } }); await Promise.resolve(); });
    const prepared = { ...expected, input: 4 };
    // The export is what was measured; live playback is the preview, so no second WAV is rendered.
    expect(await screen.findByText("Target set. Export measures −9.01 LUFS, −0.30 dBTP. Live playback runs the same chain.")).toBeTruthy();
    expect(savedTrack().advanced).toEqual(prepared);
    expect(savedTrack().status).toBe("mastered");
    expect(instance.controller.setParams).toHaveBeenLastCalledWith(prepared);
    expect(audioRequests()).toEqual([]);
    fireEvent.click(screen.getByRole("tab", { name: "simple" }));
    expect(screen.getByText("Custom settings")).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox", { name: "Output target" }), { target: { value: "Loud" } });
    expect(savedTrack().advanced).toEqual({ ...prepared, limiter: { ...prepared.limiter, targetLufs: -9, ceiling: -1 } });
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
    const custom = { ...savedTrack().advanced, limiter: { ...savedTrack().advanced.limiter, targetLufs: -12, ceiling: -1.5 } };
    cleanup();
    localStorage.setItem("aurialis-state-v1", JSON.stringify({ ...testStore, tracks: testStore.tracks.slice(0, 1).map((track) => ({ ...track, mode: "simple", target: "Streaming", advanced: custom })) }));
    mount(); await ready();
    expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "Output target" }).value).toBe("custom");
    expect(screen.getByRole("option", { name: "Custom (−12 LUFS)" })).toBeTruthy();
    expect(screen.getByText(/Current target: −12 LUFS · ceiling −1.5 dBTP/)).toBeTruthy();
    const normalize = vi.spyOn(engine, "normalizeSimpleAudio").mockResolvedValue({ advanced: custom, measurement: { sampleRate: 48000, frames: 4800, duration: 0.1, beforeMetrics: exportMetrics, afterMetrics: exportMetrics } });
    fireEvent.click(screen.getByRole("button", { name: "Set target loudness" }));
    await waitFor(() => { expect(normalize).toHaveBeenCalledWith(expect.any(Blob), custom, -12, expect.any(AbortSignal)); });
  }, 30000);

  it("lowers a saved ceiling above −1 dBTP with a visible, dismissible note", async () => {
    const track = testStore.tracks[0]; if (!track) throw new Error("Missing track");
    localStorage.setItem("aurialis-state-v1", JSON.stringify({ ...testStore, tracks: [{ ...track, mode: "simple", target: "Loud", advanced: { ...track.advanced, limiter: { ...track.advanced.limiter, enabled: true, targetLufs: -9, ceiling: -0.2 } } }] }));
    mount(); await ready();
    expect(screen.getByText("This project's saved limiter ceiling of −0.2 dBTP was lowered to −1 dBTP, the highest ceiling Aurialis offers. Set target loudness or export again to re-measure.")).toBeTruthy();
    expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "Output target" }).value).toBe("Loud");
    await waitFor(() => { expect(savedTrack().advanced.limiter.ceiling).toBe(-1); });
    fireEvent.click(screen.getByRole("button", { name: "Dismiss ceiling note" }));
    expect(screen.queryByText(/saved limiter ceiling/u)).toBeNull();
  }, 30000);

  it("offers one Deep profile control and no legacy static profile cards", async () => {
    mount(); await ready();
    fireEvent.click(screen.getByRole("tab", { name: "deep" }));
    expect(screen.getAllByRole("combobox", { name: /profile/iu })).toHaveLength(1);
    expect(screen.getByRole("combobox", { name: "Deep engineer profile" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Apply profile" })).toBeNull();
    expect(screen.queryByText("Engineer profiles")).toBeNull();
    for (const legacy of ["Modern Pop Polish", "Hip-Hop Low-End", "Indie Warmth", "Metal Wall", "Pop Punk Air"]) expect(screen.queryByText(legacy)).toBeNull();
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
    expect(audioRequests()).toEqual([]);
  }, 20000);

  it("offers an honest retry for missing audio and enables A/B only after it is restored", async () => {
    mocks.getAudio.mockResolvedValueOnce(undefined);
    mount();
    await screen.findByRole("button", { name: "Retry source" });
    expect(mocks.createLivePlayback).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: /offline preview/u })).toBeNull();
    for (const name of ["A Processed", "B Original", "Play"]) expect(screen.getByRole<HTMLButtonElement>("button", { name }).disabled).toBe(true);
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
    mocks.getAudio.mockResolvedValue(canonicalWAV({ ...pcm, sampleRate: 8000 }));
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

  it("offers the source rate once, sends no sampleRate for it, and reports the delivered true peak", async () => {
    mount();
    await ready();
    const render = vi.spyOn(engine, "renderDelivery").mockResolvedValueOnce({ blob: canonicalWAV(pcm), truePeakDbtp: null }).mockResolvedValueOnce({ blob: canonicalWAV(pcm), truePeakDbtp: -1.04 });
    // jsdom has no object URLs; restoreAllMocks does not reach defineProperty.
    // Export revokes its URL 1 s after the click, so keep the stub until that
    // timer has fired; otherwise it throws into a later test on a slow runner.
    const originals = (["createObjectURL", "revokeObjectURL"] as const).map((key) => [key, Object.getOwnPropertyDescriptor(URL, key)] as const);
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: () => "blob:export" });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: () => undefined });
    onTestFinished(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1100));
      for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(URL, key, descriptor); else Reflect.deleteProperty(URL, key); }
    });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    const rates = within(screen.getByRole("group", { name: "Sample rate" })).getAllByRole("button");
    expect(rates.map((button) => button.textContent)).toEqual(["44.1 kHz", "48 kHz (source)", "88.2 kHz", "96 kHz"]);
    expect(rates.map((button) => button.getAttribute("aria-pressed"))).toEqual(["false", "true", "false", "false"]);
    expect(screen.getByRole("group", { name: "Bit depth" })).toBeTruthy();
    expect(screen.getByRole("group", { name: "Dither" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Render & download WAV" }));
    await waitFor(() => { expect(render).toHaveBeenCalledOnce(); });
    expect(render.mock.calls[0]?.[3]).toEqual({});
    await within(screen.getByRole("dialog")).findByText(/Exported 24-bit PCM WAV with TPDF dither at the source rate using the same Go DSP parameters\.$/);
    // Live playback is the preview; a finished export is what marks the project mastered.
    expect(savedTrack().status).toBe("mastered");
    fireEvent.click(screen.getByRole("button", { name: "44.1 kHz" }));
    fireEvent.click(screen.getByRole("button", { name: "Off" }));
    await waitFor(() => { expect(screen.getByRole<HTMLButtonElement>("button", { name: "Render & download WAV" }).disabled).toBe(false); });
    fireEvent.click(screen.getByRole("button", { name: "Render & download WAV" }));
    await waitFor(() => { expect(render).toHaveBeenCalledTimes(2); });
    expect(render.mock.calls[1]?.[3]).toEqual({ sampleRate: 44100, dither: "none" });
    await within(screen.getByRole("dialog")).findByText(/without dither at 44\.1 kHz \(converted from 48 kHz\) using the same Go DSP parameters\. Delivered true peak -1\.04 dBTP at 44\.1 kHz\.$/);
  }, 20000);

  it("matches A and B with one static measured offset, re-measures stale settings at unity, and never changes export (V1-11)", async () => {
    const storage = new Map<string, string>([["aurialis-state-v1", JSON.stringify({ ...testStore, tracks: testStore.tracks.slice(0, 1) })]]);
    vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value); } });
    const measure = vi.spyOn(engine, "measureRender").mockImplementation((_file, render) => {
      const input = "params" in render ? (render.params as { inputGainDb: number }).inputGainDb : 0;
      return Promise.resolve({ sampleRate: 48000, frames: 4800, duration: 0.1, beforeMetrics: { ...exportMetrics, integratedLufs: -14 }, afterMetrics: { ...exportMetrics, integratedLufs: -14 + input } });
    });
    const delivery = vi.spyOn(engine, "renderDelivery").mockResolvedValue({ blob: canonicalWAV(pcm), truePeakDbtp: -1 });
    const originals = (["createObjectURL", "revokeObjectURL"] as const).map((key) => [key, Object.getOwnPropertyDescriptor(URL, key)] as const);
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: () => "blob:export" });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: () => undefined });
    onTestFinished(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1100));
      for (const [key, descriptor] of originals) { if (descriptor) Object.defineProperty(URL, key, descriptor); else Reflect.deleteProperty(URL, key); }
    });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
    mount(); await ready();
    const instance = latest();
    const exportOnce = async (calls: number) => {
      fireEvent.click(screen.getByRole("button", { name: "Export" }));
      fireEvent.click(screen.getByRole("button", { name: "Render & download WAV" }));
      await waitFor(() => { expect(delivery).toHaveBeenCalledTimes(calls); });
      const close = within(screen.getByRole("dialog")).getAllByRole("button", { name: /Close/ })[0];
      if (!close) throw new Error("Missing export close button");
      fireEvent.click(close);
    };
    const toggle = screen.getByRole("button", { name: "Equal-loudness A/B" });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(measure).not.toHaveBeenCalled();
    await exportOnce(1);
    fireEvent.change(screen.getByRole("slider", { name: "Input gain" }), { target: { value: "-4.5" } });
    fireEvent.click(toggle);
    expect(storage.get("aurialis-match-loudness-v1")).toBe("1");
    await waitFor(() => { expect(document.querySelector(".match-status")?.textContent).toBe("B −4.5 dB to match A"); }, { timeout: 5000 });
    expect(instance.controller.setLoudnessMatch).toHaveBeenLastCalledWith({ processedDb: 0, originalDb: -4.5 });
    // A is measured on what live playback plays: the export algorithm since V1-10.
    expect(measure.mock.calls.at(-1)?.[1]).toMatchObject({ params: { inputGainDb: -4.5, limiter: { truePeak: true }, algorithmVersion: 2 } });
    // A settings change makes the reading stale: the last static offset is held, then replaced.
    fireEvent.change(screen.getByRole("slider", { name: "Input gain" }), { target: { value: "3" } });
    await waitFor(() => { expect(document.querySelector(".match-status")?.textContent).toBe("Re-measuring (holding B −4.5 dB)"); });
    expect(instance.controller.setLoudnessMatch).toHaveBeenLastCalledWith({ processedDb: 0, originalDb: -4.5 });
    await waitFor(() => { expect(document.querySelector(".match-status")?.textContent).toBe("A −3.0 dB to match B"); }, { timeout: 5000 });
    expect(instance.controller.setLoudnessMatch).toHaveBeenLastCalledWith({ processedDb: -3, originalDb: 0 });
    fireEvent.change(screen.getByRole("slider", { name: "Input gain" }), { target: { value: "0" } });
    await waitFor(() => { expect(document.querySelector(".match-status")?.textContent).toBe("A and B already match"); }, { timeout: 5000 });
    // Export with the match on sends exactly the request it sent with the match off.
    await exportOnce(2);
    // Same source blob and the byte-identical serialized render request (the fourth argument is the abort signal).
    expect(delivery.mock.calls[1]?.[0]).toBe(delivery.mock.calls[0]?.[0]);
    expect(JSON.stringify(delivery.mock.calls[1]?.slice(1, 4))).toBe(JSON.stringify(delivery.mock.calls[0]?.slice(1, 4)));
    fireEvent.click(toggle);
    expect(storage.get("aurialis-match-loudness-v1")).toBe("0");
    await waitFor(() => { expect(document.querySelector(".match-status")?.textContent).toBe(""); });
  }, 30000);

  it("re-measures after Export or Deep preempts the background loudness measurement instead of failing", async () => {
    const storage = new Map<string, string>([["aurialis-state-v1", JSON.stringify({ ...testStore, tracks: testStore.tracks.slice(0, 1) })], ["aurialis-match-loudness-v1", "1"]]);
    vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value); } });
    const measure = vi.spyOn(engine, "measureRender")
      .mockRejectedValueOnce(new DOMException("A foreground audio job preempted this measurement.", "AbortError"))
      .mockResolvedValue({ sampleRate: 48000, frames: 4800, duration: 0.1, beforeMetrics: { ...exportMetrics, integratedLufs: -14 }, afterMetrics: { ...exportMetrics, integratedLufs: -11 } });
    mount(); await ready();
    await waitFor(() => { expect(document.querySelector(".match-status")?.textContent).toBe("A −3.0 dB to match B"); }, { timeout: 8000 });
    expect(measure).toHaveBeenCalledTimes(2);
    expect(measure.mock.calls.every((call) => call[3] === "background")).toBe(true);
  }, 20000);

  it("does not create an engine when an old source load resolves after navigation", async () => {
    let resolveSource: ((value: Blob) => void) | undefined;
    mocks.getAudio.mockReturnValueOnce(new Promise<Blob>((resolve) => { resolveSource = resolve; }));
    const view = mount();
    await waitFor(() => { expect(mocks.getAudio).toHaveBeenCalledOnce(); });
    view.unmount();
    await act(async () => { resolveSource?.(canonicalWAV(pcm)); await Promise.resolve(); });
    expect(mocks.createLivePlayback).not.toHaveBeenCalled();
  }, 20000);
});
