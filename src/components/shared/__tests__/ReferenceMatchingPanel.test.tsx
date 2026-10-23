import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StoreProvider, useStore, reduceStoreState } from "@/lib/store";
import { testStore } from "@/lib/__tests__/fixtures";
import { matchReference, type ReferenceProposal } from "@/lib/reference-matching";
import { ReferenceMatchingPanel } from "../ReferenceMatchingPanel";
vi.mock("@/lib/db", () => ({ getAudio: vi.fn(() => Promise.resolve(new Blob(["canonical"]))) }));
vi.mock("@/lib/reference-matching", async (original) => ({ ...await original<typeof import("@/lib/reference-matching")>(), matchReference: vi.fn() }));
let current: ReturnType<typeof useStore> | undefined;
function Probe() { current = useStore(); return null; }
const track = () => { const source = current?.state.tracks.at(0); if (!source) throw new Error("Missing test source"); return source; };
const initial = () => ({ ...structuredClone(testStore), tracks: testStore.tracks.map((item, i) => ({ ...structuredClone(item), sourceRevision: 0, sourceIdentity: { pcmHash: (i === 0 ? "a" : "b").repeat(64), sampleRate: 48000, frames: 48000 } })) });
function result(baseline: Parameters<typeof matchReference>[2], options: Parameters<typeof matchReference>[3]): ReferenceProposal {
  const advanced = { ...baseline, eqBands: baseline.eqBands.map((band, i) => ({ ...band, gainDb: band.gainDb + (i === 2 ? options.amount : 0) })) as typeof baseline.eqBands };
  return { version: "1.0", sourceSpectrum: "baseline_rendered", source: { pcmHash: "a".repeat(64), sampleRate: 48000, frames: 48000 }, reference: { pcmHash: "b".repeat(64), sampleRate: 48000, frames: 48000 }, options, advanced, bands: [], beforeOutputResidualDb: 2, afterOutputResidualDb: 1, beforeResidualDb: 1, fitResidualDb: .1, maxPredictedBoostDb: .6, maxProtectedDeltaDb: .01, remeasuredProtectedDeltaDb: .01, protectionVerified: true, warnings: [] };
}
async function open() {
  render(<StoreProvider><Probe /><ReferenceMatchingPanel trackId="demo-1" /></StoreProvider>);
  await screen.findByRole("button", { name: "Analyze reference audio" });
  fireEvent.change(screen.getByRole("combobox", { name: "Reference track" }), { target: { value: "test-2" } });
}
beforeEach(() => {
  const saved = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => { saved.set(key, value); }, clear: () => { saved.clear(); } });
  localStorage.setItem("aurialis-state-v1", JSON.stringify(initial()));
  vi.mocked(matchReference).mockImplementation((_source, _reference, baseline, options) => Promise.resolve(result(baseline, options)));
});
afterEach(() => { cleanup(); localStorage.clear(); current = undefined; vi.clearAllMocks(); vi.unstubAllGlobals(); });
describe("measured Reference review", () => {
  it("keeps analysis separate, reapplies from one baseline and restores the complete original settings", async () => {
    await open(); const original = track().advanced;
    fireEvent.click(screen.getByRole("button", { name: "Analyze reference audio" }));
    await screen.findByText(/Measured proposal ready/u); expect(track().advanced).toBe(original);
    fireEvent.click(screen.getByRole("button", { name: "Apply measured proposal" }));
    await waitFor(() => { expect(track().advanced.eqBands[2].gainDb).toBe(.62); });
    fireEvent.click(screen.getByRole("button", { name: "Apply measured proposal" }));
    expect(track().advanced.eqBands[2].gainDb).toBe(.62);
    fireEvent.change(screen.getByRole("slider", { name: "Match amount" }), { target: { value: "100" } });
    fireEvent.click(screen.getByRole("button", { name: "Analyze reference audio" }));
    await screen.findByText(/Measured proposal ready/u);
    expect(vi.mocked(matchReference).mock.calls.at(-1)?.[2]).toBe(original);
    fireEvent.click(screen.getByRole("button", { name: "Apply measured proposal" }));
    await waitFor(() => { expect(track().advanced.eqBands[2].gainDb).toBe(1); });
    fireEvent.click(screen.getByRole("button", { name: "Revert Reference" }));
    await waitFor(() => { expect(track().advanced).toEqual(original); });
    expect(screen.getByRole("button", { name: "Apply measured proposal" })).toBeDisabled();
  });
  it("ignores late analysis after Cancel and preserves manual edits made while a job is running", async () => {
    let finish: ((value: ReferenceProposal) => void) | undefined;
    vi.mocked(matchReference).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await open(); fireEvent.click(screen.getByRole("button", { name: "Analyze reference audio" }));
    await waitFor(() => { expect(matchReference).toHaveBeenCalledTimes(1); });
    const call = vi.mocked(matchReference).mock.calls.at(0); if (!call) throw new Error("Missing job");
    fireEvent.click(screen.getByRole("button", { name: "Cancel analysis" })); expect(call[5].aborted).toBe(true);
    await act(async () => { finish?.(result(call[2], call[3])); await Promise.resolve(); });
    expect(screen.getByRole("button", { name: "Apply measured proposal" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Analyze reference audio" }));
    await waitFor(() => { expect(matchReference).toHaveBeenCalledTimes(2); });
    act(() => { current?.dispatch({ type: "UPDATE_INPUT_GAIN", trackId: "demo-1", input: 3 }); });
    await act(async () => { finish?.(result(call[2], call[3])); await Promise.resolve(); });
    expect(track().advanced.input).toBe(3); expect(screen.getByRole("button", { name: "Apply measured proposal" })).toBeDisabled();
  });
  it("rejects source/reference and attached-Deep races in the store", () => {
    const state = initial(), source = state.tracks.at(0), reference = state.tracks.at(1); if (!source || !reference) throw new Error("Missing fixture");
    const changed = reduceStoreState(state, { type: "UPDATE_INPUT_GAIN", trackId: source.id, input: 5 });
    expect(reduceStoreState(changed, { type: "APPLY_REFERENCE", expected: source, reference, advanced: source.advanced }).tracks[0]?.advanced.input).toBe(5);
    const removed = { ...state, tracks: [source] };
    expect(reduceStoreState(removed, { type: "APPLY_REFERENCE", expected: source, reference, advanced: source.advanced })).toBe(removed);
    const attached = { ...source, deepMastering: { applied: {} } };
    expect(reduceStoreState({ ...state, tracks: [attached, reference] }, { type: "APPLY_REFERENCE", expected: attached, reference, advanced: { ...attached.advanced, input: 6 } }).tracks[0]).toBe(attached);
  });
});
