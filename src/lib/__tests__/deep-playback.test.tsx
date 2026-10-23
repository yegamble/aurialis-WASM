import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultAdvancedParams } from "../audio-dsp";
import { engineParams } from "../browser-engine";
import { automationTargets, type ScriptV2 } from "../deep-mastering";
import type { LivePlaybackController } from "../live-playback";
import { StoreProvider, useStore } from "../store";
import { useDeepPlayback } from "../use-deep-playback";
import { testStore } from "./fixtures";
const identity = { pcmHash: "a".repeat(64), sampleRate: 48000, frames: 48000 };
function script(): ScriptV2 { return { version: "2.0", source: identity, revision: 1, profile: "Warm Analog", summary: "Source bound", chainParams: engineParams(createDefaultAdvancedParams()), sections: [{ id: "all", name: "Section 1", startFrame: 0, endFrame: 48000, roleHint: "unknown", confidence: 0 }], moves: [{ id: "gain", sectionId: "all", reason: "Manually authored test move", target: "inputGainDb", operation: "add", points: [{ frame: 0, value: 2 }, { frame: 24000, value: 2 }], fadeFrames: 100, muted: false }], findings: [], beforeMetrics: { integratedLufs: -18, shortTermLufs: -18, truePeakDbtp: -6, samplePeakDbfs: -6, dynamicRangeDb: 12, correlation: 1, lowBassCorrelation: 1, dcLeftDbfs: -100, dcRightDbfs: -100, clippingSamples: 0, gainReductionDb: 0 } }; }
const player = { applyScript: vi.fn(), detachScript: vi.fn() };
function saved() { return JSON.parse(localStorage.getItem("aurialis-state-v1") ?? "{}") as typeof testStore; }
function mount() {
  const original = testStore.tracks[0]; if (!original) throw new Error("Missing track");
  const before = { advanced: { ...original.advanced, input: -2 }, profile: original.profile, genre: "Jazz", tone: "Natural", intensity: 31, target: original.target, simpleCustom: false, shortcutUndo: {} };
  const applied = script();
  const track = { ...original, sourceIdentity: identity, sourceRevision: 0, deepMastering: { sourceRevision: 0, proposal: { ...applied, revision: 9, moves: [] }, applied, before, targets: automationTargets.map((name) => ({ name, minimum: -80, maximum: 200, cellTolerance: 0.1, sampleAccurate: true })) } };
  localStorage.setItem("aurialis-state-v1", JSON.stringify({ ...testStore, tracks: [track] }));
  function Panel() { const { state, dispatch } = useStore(); const current = state.tracks[0]; const live = useRef(player as unknown as LivePlaybackController); const deep = useDeepPlayback(current, live); if (!current) return null; return <><button onClick={() => { dispatch({ type: "UPDATE_INPUT_GAIN", trackId: current.id, input: 3 }); }}>Edit baseline</button><button onClick={deep.retry}>Retry</button><button onClick={deep.revert}>Revert</button><button onClick={deep.detach}>Detach</button><button onClick={() => { dispatch({ type: "UPDATE_TRACK", id: current.id, patch: { sourceRevision: 1 } }); }}>Replace source</button><p role="status">{deep.message}</p><p role="alert">{deep.error}</p></>; }
  return render(<StoreProvider><Panel /></StoreProvider>);
}
beforeEach(() => { const storage = new Map<string, string>(); vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value); } }); player.applyScript.mockReset(); player.detachScript.mockReset().mockResolvedValue(undefined); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
describe("acknowledged Deep baseline and recovery transactions", () => {
  it("keeps the applied snapshot until ACK and compiles its authored moves again rather than the edited draft", async () => {
    let accept: ((value: ScriptV2) => void) | undefined;
    player.applyScript.mockImplementation(() => new Promise<ScriptV2>((resolve) => { accept = resolve; }));
    mount(); fireEvent.click(await screen.findByRole("button", { name: "Edit baseline" }));
    await waitFor(() => { expect(player.applyScript).toHaveBeenCalledOnce(); });
    const candidate = player.applyScript.mock.calls[0]?.[0] as ScriptV2;
    expect(candidate.moves).toEqual(script().moves); expect(candidate.chainParams.inputGainDb).toBe(3);
    expect(saved().tracks[0]?.deepMastering?.applied?.chainParams.inputGainDb).toBe(0);
    await act(async () => { accept?.({ ...candidate, revision: 2 }); await Promise.resolve(); });
    await waitFor(() => { expect(saved().tracks[0]?.deepMastering?.applied?.chainParams.inputGainDb).toBe(3); });
    expect(saved().tracks[0]?.deepMastering?.before?.advanced.input).toBe(-2);
    expect(saved().tracks[0]?.deepMastering?.proposal.moves).toEqual([]);
  });
  it("reverts the full original snapshot while a pending compile is canceled, ignoring its late result", async () => {
    let accept: ((value: ScriptV2) => void) | undefined; player.applyScript.mockImplementation(() => new Promise<ScriptV2>((resolve) => { accept = resolve; }));
    mount(); fireEvent.click(await screen.findByRole("button", { name: "Edit baseline" }));
    await waitFor(() => { expect(player.applyScript).toHaveBeenCalledOnce(); });
    const pendingSignal = player.applyScript.mock.calls[0]?.[1] as AbortSignal;
    fireEvent.click(screen.getByRole("button", { name: "Revert" }));
    await waitFor(() => { expect(saved().tracks[0]?.deepMastering?.applied).toBeUndefined(); });
    expect(pendingSignal.aborted).toBe(true); expect(saved().tracks[0]).toMatchObject({ genre: "Jazz", tone: "Natural", intensity: 31, simpleCustom: false, advanced: { input: -2 } });
    await act(async () => { accept?.({ ...script(), revision: 2 }); await Promise.resolve(); });
    expect(saved().tracks[0]?.deepMastering?.applied).toBeUndefined(); expect(saved().tracks[0]?.advanced.input).toBe(-2);
  });
  it("preserves old audio metadata after a failed compile and rejects a late result after source replacement", async () => {
    player.applyScript.mockRejectedValueOnce(new Error("Compiler unavailable"));
    mount(); fireEvent.click(await screen.findByRole("button", { name: "Edit baseline" }));
    await waitFor(() => { expect(screen.getByRole("alert").textContent).toContain("Compiler unavailable"); });
    expect(saved().tracks[0]?.deepMastering?.applied?.revision).toBe(1);
    expect(saved().tracks[0]?.advanced.input).toBe(3);
    let accept: ((value: ScriptV2) => void) | undefined; player.applyScript.mockImplementationOnce(() => new Promise<ScriptV2>((resolve) => { accept = resolve; }));
    fireEvent.click(screen.getByRole("button", { name: "Retry" })); await waitFor(() => { expect(player.applyScript).toHaveBeenCalledTimes(2); });
    const signal = player.applyScript.mock.calls[1]?.[1] as AbortSignal;
    fireEvent.click(screen.getByRole("button", { name: "Replace source" })); expect(signal.aborted).toBe(true);
    await act(async () => { accept?.({ ...script(), revision: 2 }); await Promise.resolve(); });
    expect(saved().tracks[0]?.sourceRevision).toBe(1); expect(saved().tracks[0]?.deepMastering?.applied?.revision).toBe(1);
  });
});
