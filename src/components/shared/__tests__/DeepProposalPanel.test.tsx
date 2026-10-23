import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultAdvancedParams } from "@/lib/audio-dsp";
import { engineParams } from "@/lib/browser-engine";
import { automationTargets, type ScriptV2, type TargetMetadata } from "@/lib/deep-mastering";
import { StoreProvider, useStore } from "@/lib/store";
import { testStore } from "@/lib/__tests__/fixtures";
import { DeepProposalPanel } from "../DeepProposalPanel";
import { DeepTimeline } from "../DeepTimeline";

const mocks = vi.hoisted(() => ({ analyze: vi.fn(), compile: vi.fn(), getAudio: vi.fn() }));
vi.mock("@/lib/db", () => ({ getAudio: mocks.getAudio }));
vi.mock("@/lib/deep-mastering", async (original) => ({ ...await original<typeof import("@/lib/deep-mastering")>(), analyzeDeep: mocks.analyze, compileScript: mocks.compile }));
const identity = { pcmHash: "a".repeat(64), sampleRate: 48000, frames: 48000 };
const targets: TargetMetadata[] = automationTargets.map((name) => ({ name, minimum: -24, maximum: 24, cellTolerance: 0.1, sampleAccurate: name === "inputGainDb" || name === "stereo.widthPct" }));
function proposal(): ScriptV2 { return { version: "2.0", source: identity, revision: 1, profile: "Warm Analog", summary: "Measured source with neutral sections", chainParams: engineParams(createDefaultAdvancedParams()), sections: [{ id: "section-1", name: "Section 1", roleHint: "unknown", startFrame: 0, endFrame: 48000, confidence: 0.8 }], moves: [{ id: "gain", sectionId: "section-1", target: "inputGainDb", operation: "add", points: [{ frame: 12000, value: -1 }, { frame: 36000, value: -1 }], muted: false, fadeFrames: 100, reason: "Measured headroom" }], findings: [], beforeMetrics: { integratedLufs: -18, shortTermLufs: -18, truePeakDbtp: -6, samplePeakDbfs: -6, dynamicRangeDb: 12, correlation: 1, lowBassCorrelation: 1, dcLeftDbfs: -100, dcRightDbfs: -100, clippingSamples: 0, gainReductionDb: 0 } }; }
function mount(withDraft = true) {
  const original = testStore.tracks[0]; if (!original) throw new Error("Missing track");
  localStorage.setItem("aurialis-state-v1", JSON.stringify({ ...testStore, tracks: [{ ...original, sourceIdentity: identity, sourceRevision: 0, ...(withDraft ? { deepMastering: { sourceRevision: 0, proposal: proposal(), targets } } : {}) }] }));
  function Panel() { const { state, dispatch } = useStore(); const track = state.tracks[0]; const [selected, setSelected] = useState(""); const [open, setOpen] = useState(false); if (!track) return null; function select(id: string) { setSelected(id); setOpen(Boolean(id)); } return <><button onClick={() => { dispatch({ type: "UPDATE_INPUT_GAIN", trackId: track.id, input: 3 }); }}>Change current settings</button>{track.deepMastering && <DeepTimeline script={track.deepMastering.proposal} selectedId={selected} onSelect={select} />}<DeepProposalPanel track={track} sourceReady selectedMoveId={selected} onSelectMove={select} editorOpen={open} onCloseEditor={() => { setOpen(false); }} /></>; }
  return render(<StoreProvider><Panel /></StoreProvider>);
}
function saved() { return JSON.parse(localStorage.getItem("aurialis-state-v1") ?? "{}") as { tracks: { advanced: { input: number }; deepMastering?: { proposal: ScriptV2; applied?: ScriptV2 } }[] }; }
beforeEach(() => { const storage = new Map<string, string>(); vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value); } }); mocks.getAudio.mockReset().mockResolvedValue(new Blob(["canonical"])); mocks.analyze.mockReset().mockResolvedValue(proposal()); mocks.compile.mockReset().mockResolvedValue({ targets }); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("Deep proposal review interactions", () => {
  it("edits a bounded draft without changing current processing, and can reopen the same selection", async () => {
    mount(); fireEvent.change(await screen.findByRole("combobox", { name: "Automation move" }), { target: { value: "gain" } });
    const field = await screen.findByRole<HTMLInputElement>("spinbutton", { name: "Point 1 value" });
    fireEvent.change(field, { target: { value: "-3" } }); fireEvent.blur(field);
    await waitFor(() => { expect(saved().tracks[0]?.deepMastering?.proposal.moves[0]?.points[0]?.value).toBe(-3); });
    expect(saved().tracks[0]?.advanced.input).toBe(0); expect(saved().tracks[0]?.deepMastering?.applied).toBeUndefined();
    fireEvent.change(field, { target: { value: "-99" } }); fireEvent.blur(field); expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(saved().tracks[0]?.deepMastering?.proposal.moves[0]?.points[0]?.value).toBe(-3);
    fireEvent.click(screen.getByRole("button", { name: "Close menu" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Edit selected move" }));
    expect(await screen.findByRole("spinbutton", { name: "Point 1 value" })).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Apply Deep proposal" }).disabled).toBe(true);
  });
  it("adds and deletes bounded authored points and removes a draft move without applying processing", async () => {
    mount(); fireEvent.change(await screen.findByRole("combobox", { name: "Automation move" }), { target: { value: "gain" } });
    fireEvent.click(await screen.findByRole("button", { name: "Add baseline point" }));
    await waitFor(() => { expect(saved().tracks[0]?.deepMastering?.proposal.moves[0]?.points).toEqual([{ frame: 12000, value: -1 }, { frame: 24000, value: 0 }, { frame: 36000, value: -1 }]); });
    fireEvent.click(screen.getByRole("button", { name: "Delete point 2" }));
    await waitFor(() => { expect(saved().tracks[0]?.deepMastering?.proposal.moves[0]?.points.length).toBe(2); });
    fireEvent.click(screen.getByRole("button", { name: "Delete draft move" }));
    await waitFor(() => { expect(saved().tracks[0]?.deepMastering?.proposal.moves).toEqual([]); });
    expect(saved().tracks[0]?.deepMastering?.applied).toBeUndefined(); expect(saved().tracks[0]?.advanced.input).toBe(0);
  });
  it("cancels immediately and ignores a late admitted analysis result", async () => {
    let finish: ((script: ScriptV2) => void) | undefined;
    mocks.analyze.mockImplementation(() => new Promise<ScriptV2>((resolve) => { finish = resolve; }));
    mount(false); fireEvent.click(await screen.findByRole("button", { name: "Analyze Deep proposal" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel Deep analysis" }));
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Analyze Deep proposal" }).disabled).toBe(false);
    expect(screen.queryByRole("button", { name: "Cancel Deep analysis" })).toBeNull();
    await act(async () => { finish?.(proposal()); await Promise.resolve(); });
    expect(saved().tracks[0]?.deepMastering).toBeUndefined(); expect(mocks.compile).not.toHaveBeenCalled();
  });
  it("rejects analysis delivered after settings change while preserving the valid draft", async () => {
    let finish: ((script: ScriptV2) => void) | undefined; mocks.analyze.mockImplementation(() => new Promise<ScriptV2>((resolve) => { finish = resolve; }));
    mount(); fireEvent.click(await screen.findByRole("button", { name: "Analyze Deep proposal" }));
    await waitFor(() => { expect(mocks.analyze).toHaveBeenCalledOnce(); });
    fireEvent.click(screen.getByRole("button", { name: "Change current settings" }));
    await act(async () => { finish?.(proposal()); await Promise.resolve(); });
    expect((await screen.findByRole("alert")).textContent).toContain("settings or draft changed");
    expect(saved().tracks[0]?.advanced.input).toBe(3); expect(saved().tracks[0]?.deepMastering?.proposal.revision).toBe(1);
  });
});
