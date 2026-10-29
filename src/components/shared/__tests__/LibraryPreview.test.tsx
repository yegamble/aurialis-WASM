import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LibraryPreview } from "../LibraryTools";
import { testStore } from "@/lib/__tests__/fixtures";
import { engineParams } from "@/lib/engine-params";
import type { ScriptV2 } from "@/lib/deep-mastering";
import type { Track } from "@/lib/types";
import { getAudio } from "@/lib/db";
import * as loudness from "@/lib/loudness-match";
import * as playback from "@/lib/live-playback";
const mocks = vi.hoisted(() => ({ blob: new Blob(["source"]) }));
vi.mock("@/lib/db", () => ({ getAudio: vi.fn(() => Promise.resolve(mocks.blob)) }));
vi.mock("@/lib/project-import", () => ({ readStoredSource: vi.fn(() => Promise.resolve({ blob: mocks.blob, pcm: { left: new Float32Array(48000), right: new Float32Array(48000), sampleRate: 48000 } })), SOURCE_ACCEPT: "audio/*" }));
const original = testStore.tracks[0]; if (!original) throw new Error("Missing project");
const source = { pcmHash: "a".repeat(64), sampleRate: 48000, frames: 48000 };
const base: Track = { ...original, sourceIdentity: source };
const script: ScriptV2 = { version: "2.0", source, revision: 1, profile: "Warm Analog", summary: "Applied", chainParams: engineParams(base.advanced), sections: [{ id: "all", name: "Section 1", startFrame: 0, endFrame: 48000, roleHint: "unknown", confidence: 0 }], moves: [], findings: [], beforeMetrics: { integratedLufs: -18, shortTermLufs: -18, truePeakDbtp: -6, samplePeakDbfs: -6, dynamicRangeDb: 12, correlation: 1, lowBassCorrelation: 1, dcLeftDbfs: -100, dcRightDbfs: -100, clippingSamples: 0, gainReductionDb: 0 } };
function player() {
  const state = { position: 0, duration: 1, playing: false, ready: true, loading: false, original: false, repeat: false, volume: 1, underruns: 0, parameterVersion: 1, appliedVersion: 1, error: null };
  return { getState: () => state, play: vi.fn(() => Promise.resolve()), pause: vi.fn(), seek: vi.fn(), setBypass: vi.fn(), setVolume: vi.fn(), setRepeat: vi.fn(), setLoudnessMatch: vi.fn(), dispose: vi.fn() };
}
beforeEach(() => { const values = new Map<string, string>(); vi.stubGlobal("localStorage", { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } }); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });
describe("Library equal-loudness preview", () => {
  it.each([false, true])("measures the current export chain and applies monitor-only gain (Deep=%s)", async (deep) => {
    const track: Track = deep ? { ...base, deepMastering: { sourceRevision: 0, proposal: script, applied: script, targets: [] } } : base;
    const controller = player();
    const create = vi.spyOn(playback, "createLivePlayback").mockReturnValue(controller as unknown as playback.LivePlaybackController);
    const measure = vi.spyOn(loudness, "measureLoudnessMatch").mockImplementation((_blob, request) => Promise.resolve({ key: request.key, scope: request.scope, processedLufs: -12, originalLufs: -18 }));
    const view = render(<LibraryPreview track={track} onClose={vi.fn()} />);
    await waitFor(() => { expect(create).toHaveBeenCalledOnce(); });
    fireEvent.click(screen.getByRole("button", { name: "Equal-loudness A/B" }));
    await waitFor(() => { expect(controller.setLoudnessMatch).toHaveBeenLastCalledWith({ processedDb: -6, originalDb: 0 }); });
    expect(measure.mock.calls[0]?.[1].render).toHaveProperty(deep ? "script" : "params");
    if (deep) expect(create.mock.calls[0]?.[3]?.applied).toEqual(script);
    fireEvent.click(screen.getByRole("button", { name: "Equal-loudness A/B" }));
    await waitFor(() => { expect(controller.setLoudnessMatch).toHaveBeenLastCalledWith({ processedDb: 0, originalDb: 0 }); });
    view.unmount(); expect(controller.dispose).toHaveBeenCalledOnce();
  });
  it("does not measure a new project with the previous project’s Blob while its source loads", async () => {
    const controller = player(); vi.spyOn(playback, "createLivePlayback").mockReturnValue(controller as unknown as playback.LivePlaybackController);
    const measure = vi.spyOn(loudness, "measureLoudnessMatch").mockImplementation((_blob, request) => Promise.resolve({ key: request.key, scope: request.scope, processedLufs: -12, originalLufs: -18 }));
    const view = render(<LibraryPreview track={base} onClose={vi.fn()} />);
    await waitFor(() => { expect(screen.getByRole<HTMLButtonElement>("button", { name: "Equal-loudness A/B" }).disabled).toBe(false); });
    fireEvent.click(screen.getByRole("button", { name: "Equal-loudness A/B" }));
    await waitFor(() => { expect(measure).toHaveBeenCalledOnce(); });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let loaded: ((blob: Blob) => void) | undefined;
    vi.mocked(getAudio).mockReturnValueOnce(new Promise((resolve) => { loaded = resolve; }));
    view.rerender(<LibraryPreview track={{ ...base, id: "track-other" }} onClose={vi.fn()} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(measure).toHaveBeenCalledOnce();
    view.unmount(); await act(async () => { loaded?.(mocks.blob); await Promise.resolve(); });
  });
  it("aborts a pending match when preview closes and ignores its late result", async () => {
    const controller = player(); vi.spyOn(playback, "createLivePlayback").mockReturnValue(controller as unknown as playback.LivePlaybackController);
    let signal: AbortSignal | undefined;
    const measure = vi.spyOn(loudness, "measureLoudnessMatch").mockImplementation((_blob, _request, abort) => { signal = abort; return new Promise(() => undefined); });
    const view = render(<LibraryPreview track={base} onClose={vi.fn()} />);
    await waitFor(() => { expect(screen.getByRole<HTMLButtonElement>("button", { name: "Equal-loudness A/B" }).disabled).toBe(false); });
    fireEvent.click(screen.getByRole("button", { name: "Equal-loudness A/B" }));
    await waitFor(() => { expect(measure).toHaveBeenCalledOnce(); });
    act(() => { view.unmount(); }); expect(signal?.aborted).toBe(true); expect(controller.dispose).toHaveBeenCalledOnce();
  });
});
