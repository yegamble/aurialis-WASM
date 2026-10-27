import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultAdvancedParams } from "@/lib/audio-dsp";
import { engineParams } from "@/lib/browser-engine";
import { automationTargets, deepSettingsSnapshot, type MeasuredProposal, type ScriptV2, type TargetMetadata } from "@/lib/deep-mastering";
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
const predicted = { integratedLufs: -19.2, shortTermLufs: -19, truePeakDbtp: -6.5, samplePeakDbfs: -6.6, dynamicRangeDb: 11.6, correlation: 1, lowBassCorrelation: 1, dcLeftDbfs: -100, dcRightDbfs: -100, clippingSamples: 0, gainReductionDb: 0 };
function measured(script: ScriptV2): MeasuredProposal { return { proposal: script, prediction: { afterMetrics: predicted } }; }
function mount(withDraft = true, withApplied = false) {
  const original = testStore.tracks[0]; if (!original) throw new Error("Missing track");
  localStorage.setItem("aurialis-state-v1", JSON.stringify({ ...testStore, tracks: [{ ...original, sourceIdentity: identity, sourceRevision: 0, ...(withDraft ? { deepMastering: { sourceRevision: 0, proposal: proposal(), targets, ...(withApplied ? { applied: proposal(), before: deepSettingsSnapshot(original) } : {}) } } : {}) }] }));
  function Panel() { const { state, dispatch } = useStore(); const track = state.tracks[0]; const [selected, setSelected] = useState(""); const [open, setOpen] = useState(false); if (!track) return null; function select(id: string) { setSelected(id); setOpen(Boolean(id)); } return <><button onClick={() => { dispatch({ type: "UPDATE_INPUT_GAIN", trackId: track.id, input: 3 }); }}>Change current settings</button><button onClick={() => { const deep = track.deepMastering; if (deep) dispatch({ type: "SAVE_DEEP_PROPOSAL", id: track.id, expectedSourceRevision: 0, expectedAudioKey: track.id, expectedProposalRevision: deep.proposal.revision, deep: { ...deep, proposal: { ...deep.proposal, revision: deep.proposal.revision + 1, summary: "Newer authored draft" } } }); }}>Change current draft</button>{track.deepMastering && <DeepTimeline script={track.deepMastering.proposal} selectedId={selected} onSelect={select} />}<DeepProposalPanel track={track} sourceReady selectedMoveId={selected} onSelectMove={select} editorOpen={open} onCloseEditor={() => { setOpen(false); }} /></>; }
  return render(<StoreProvider><Panel /></StoreProvider>);
}
function saved() { return JSON.parse(localStorage.getItem("aurialis-state-v1") ?? "{}") as { tracks: { advanced: { input: number }; deepMastering?: { proposal: ScriptV2; applied?: ScriptV2; prediction?: unknown } }[] }; }
beforeEach(() => { const storage = new Map<string, string>(); vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value); } }); mocks.getAudio.mockReset().mockResolvedValue(new Blob(["canonical"])); mocks.analyze.mockReset().mockResolvedValue(measured(proposal())); mocks.compile.mockReset().mockResolvedValue({ targets }); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("Deep proposal review interactions", () => {
  it("preserves authored points, mute and deletion when replacement confirmation is canceled or escaped", async () => {
    mount(true, true); fireEvent.change(await screen.findByRole("combobox", { name: "Automation move" }), { target: { value: "gain" } });
    const field = await screen.findByRole("spinbutton", { name: "Point 1 value" }); fireEvent.change(field, { target: { value: "-3" } }); fireEvent.blur(field);
    fireEvent.click(screen.getByRole("button", { name: "Add baseline point" })); fireEvent.click(screen.getByRole("button", { name: "Mute draft move" }));
    fireEvent.click(screen.getByRole("button", { name: "Close menu" }));
    fireEvent.click(screen.getByRole("button", { name: "Add baseline move" })); fireEvent.click(await screen.findByRole("button", { name: "Delete draft move" }));
    const before = structuredClone(saved()); fireEvent.change(screen.getByRole("combobox", { name: "Deep engineer profile" }), { target: { value: "Vocal Forward" } });
    const analyze = screen.getByRole("button", { name: "Analyze Deep proposal" }); fireEvent.click(analyze);
    expect(await screen.findByRole("dialog", { name: "Replace Deep draft?" })).toBeTruthy(); expect(mocks.analyze).not.toHaveBeenCalled(); expect(mocks.getAudio).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Keep draft" })); expect(screen.queryByRole("dialog")).toBeNull(); expect(saved()).toEqual(before);
    fireEvent.click(analyze); await screen.findByRole("dialog", { name: "Replace Deep draft?" }); fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull(); expect(saved()).toEqual(before); expect(mocks.analyze).not.toHaveBeenCalled(); expect(mocks.getAudio).not.toHaveBeenCalled();
  });
  it("replaces a draft only after confirmation and preserves the applied snapshot", async () => {
    mount(true, true); await screen.findByRole("button", { name: "Analyze Deep proposal" }); const before = structuredClone(saved());
    const fresh = { ...proposal(), profile: "Vocal Forward" as const, summary: "New measured proposal", moves: [] }; mocks.analyze.mockResolvedValueOnce(measured(fresh));
    fireEvent.change(screen.getByRole("combobox", { name: "Deep engineer profile" }), { target: { value: "Vocal Forward" } });
    fireEvent.click(screen.getByRole("button", { name: "Analyze Deep proposal" })); await screen.findByRole("dialog", { name: "Replace Deep draft?" });
    expect(mocks.analyze).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole("button", { name: "Replace draft and analyze" }));
    await screen.findByText("Measured proposal ready. Your applied processing has not changed.");
    expect(mocks.analyze.mock.calls[0]?.[1]).toBe("Vocal Forward");
    expect(saved().tracks[0]?.deepMastering?.proposal).toEqual({ ...fresh, revision: 2 }); expect(saved().tracks[0]?.deepMastering?.prediction).toEqual({ revision: 2, afterMetrics: predicted });
    expect(saved().tracks[0]?.deepMastering?.applied).toEqual(before.tracks[0]?.deepMastering?.applied); expect(saved().tracks[0]?.advanced).toEqual(before.tracks[0]?.advanced);
  });
  it.each(["settings", "draft", "profile"] as const)("refuses replacement when %s changes while its confirmation is open", async (change) => {
    mount(); fireEvent.click(await screen.findByRole("button", { name: "Analyze Deep proposal" })); await screen.findByRole("dialog", { name: "Replace Deep draft?" });
    if (change === "profile") fireEvent.change(screen.getByRole("combobox", { name: "Deep engineer profile" }), { target: { value: "Bass Heavy" } });
    else fireEvent.click(screen.getByRole("button", { name: change === "settings" ? "Change current settings" : "Change current draft" }));
    const before = structuredClone(saved()); fireEvent.click(screen.getByRole("button", { name: "Replace draft and analyze" }));
    expect((await screen.findByRole("alert")).textContent).toContain("changed"); expect(screen.queryByRole("dialog")).toBeNull();
    expect(mocks.analyze).not.toHaveBeenCalled(); expect(mocks.getAudio).not.toHaveBeenCalled(); expect(saved()).toEqual(before);
  });
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
    let finish: ((result: MeasuredProposal) => void) | undefined;
    mocks.analyze.mockImplementation(() => new Promise<MeasuredProposal>((resolve) => { finish = resolve; }));
    mount(false); fireEvent.click(await screen.findByRole("button", { name: "Analyze Deep proposal" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel Deep analysis" }));
    expect(screen.getByRole<HTMLButtonElement>("button", { name: "Analyze Deep proposal" }).disabled).toBe(false);
    expect(screen.queryByRole("button", { name: "Cancel Deep analysis" })).toBeNull();
    await act(async () => { finish?.(measured(proposal())); await Promise.resolve(); });
    expect(saved().tracks[0]?.deepMastering).toBeUndefined(); expect(mocks.compile).not.toHaveBeenCalled();
  });
  it("rejects analysis delivered after settings change while preserving the valid draft", async () => {
    let finish: ((result: MeasuredProposal) => void) | undefined; mocks.analyze.mockImplementation(() => new Promise<MeasuredProposal>((resolve) => { finish = resolve; }));
    mount(); fireEvent.click(await screen.findByRole("button", { name: "Analyze Deep proposal" }));
    fireEvent.click(await screen.findByRole("button", { name: "Replace draft and analyze" }));
    await waitFor(() => { expect(mocks.analyze).toHaveBeenCalledOnce(); });
    fireEvent.click(screen.getByRole("button", { name: "Change current settings" }));
    await act(async () => { finish?.(measured(proposal())); await Promise.resolve(); });
    expect((await screen.findByRole("alert")).textContent).toContain("settings or draft changed");
    expect(saved().tracks[0]?.advanced.input).toBe(3); expect(saved().tracks[0]?.deepMastering?.proposal.revision).toBe(1);
  });
  it("shows the export prediction, every changed setting and visible findings for the analyzed revision", async () => {
    const changed = { ...proposal(), chainParams: { ...proposal().chainParams, compressor: { ...proposal().chainParams.compressor, ratio: 1.7, makeupDb: 0 }, limiter: { ...proposal().chainParams.limiter, enabled: true } }, findings: [{ id: "predicted-loudness-increase", severity: "warning" as const, title: "Proposal raises loudness by 1.4 LU", detail: "Rendered through the export limiter, this proposal measures -16.6 LUFS against the source's -18.0 LUFS.", lane: "Volume" }] };
    mocks.analyze.mockResolvedValueOnce(measured(changed));
    mount(false); fireEvent.click(await screen.findByRole("button", { name: "Analyze Deep proposal" }));
    await screen.findByText("Measured proposal ready. Your applied processing has not changed.");
    const levels = screen.getByRole("region", { name: "Predicted export levels" });
    expect(levels.textContent).toContain("Predicted loudness−19.2 LUFS" + "source −18.0 LUFS, −1.2 LU");
    expect(levels.textContent).toContain("Predicted true peak−6.50 dBTP" + "source −6.00 dBTP");
    expect(levels.textContent).toContain("Predicted crest11.6 dB" + "source 12.0 dB, −0.4 dB");
    const list = screen.getByRole("list", { name: "Changed settings" });
    expect(list.textContent).toContain("Compressor ratio1:1 → 1.7:1"); expect(list.textContent).toContain("Limiter" + "off → on");
    expect(screen.getByText("2 settings change from your current settings, plus 1 automation move.")).toBeTruthy();
    expect(screen.getByText("Proposal raises loudness by 1.4 LU")).toBeTruthy(); expect(screen.getByText("Review warning · Volume")).toBeTruthy();
    fireEvent.change(await screen.findByRole("combobox", { name: "Automation move" }), { target: { value: "gain" } });
    const field = await screen.findByRole("spinbutton", { name: "Point 1 value" }); fireEvent.change(field, { target: { value: "-2" } }); fireEvent.blur(field);
    expect(await screen.findByText("Predicted levels were measured for draft revision 1. This draft has changed since then; analyze again to re-measure, or apply and export to measure the result.")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Predicted export levels" })).toBeNull();
  });
  it("states when a saved draft has no prediction or already matches the current settings", async () => {
    mount(); expect(await screen.findByText("No export prediction is stored for this draft. Analyze again to measure it.")).toBeTruthy();
    expect(screen.getByText("The proposal baseline matches your current settings. Apply changes only the automation moves.")).toBeTruthy();
  });
});
