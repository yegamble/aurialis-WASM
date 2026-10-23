import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDefaultAdvancedParams, clampAdvancedToSampleRate } from "@/lib/audio-dsp";
import { reserveBrowserAudioMemory } from "@/lib/browser-jobs";
import { discardStagedAudio, newAudioAssetId, saveAudio } from "@/lib/db";
import { readLegacyWav, scanLegacySources, type LegacyPage, type LegacySource } from "@/lib/legacy-library";
import { prepareProjectFile } from "@/lib/project-import";
import type { Track } from "@/lib/types";
import { LegacyLibraryRecovery } from "../LegacyLibraryRecovery";

const { dispatch } = vi.hoisted(() => ({ dispatch: vi.fn<(action: { type: "ADD_TRACK"; track: Track }) => void>() }));
vi.mock("@/lib/store", () => ({ useStore: () => ({ dispatch }) }));
vi.mock("@/lib/db", () => ({ discardStagedAudio: vi.fn(), newAudioAssetId: vi.fn(), saveAudio: vi.fn() }));
vi.mock("@/lib/legacy-library", () => ({ readLegacyWav: vi.fn(), scanLegacySources: vi.fn() }));
vi.mock("@/lib/project-import", async (original) => ({
  ...await original<typeof import("@/lib/project-import")>(), prepareProjectFile: vi.fn(),
}));

type Imported = Awaited<ReturnType<typeof prepareProjectFile>>;
const source: LegacySource = { key: "old-mix.wav|52|1700000000000", name: "old-mix.wav", size: 52, modified: 1700000000000 };
const page: LegacyPage = { sources: [source], next: null, skipped: 0, stopped: false };
const metrics = { integratedLufs: -20, shortTermLufs: -20, truePeakDbtp: -6, samplePeakDbfs: -6, dynamicRangeDb: 14, correlation: 0.8, lowBassCorrelation: 1, dcLeftDbfs: -100, dcRightDbfs: -100, clippingSamples: 0, gainReductionDb: 0 };
const identity = { pcmHash: "a".repeat(64), sampleRate: 8000, frames: 1 };
const maximumResident = 448 * 1024 * 1024; // Default 512 MiB budget minus 64 MiB processing headroom.
let file: File;
let imported: Imported;
let verify: ReturnType<typeof vi.fn<() => Promise<void>>>;

function deferred<T>() {
  let complete: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => { complete = resolve; });
  return { promise, resolve(value: T) { if (!complete) throw new Error("Missing resolver"); complete(value); } };
}
async function findSources() {
  const view = render(<LegacyLibraryRecovery />);
  fireEvent.click(screen.getByRole("button", { name: "Find old projects" }));
  await screen.findByRole("button", { name: `Recover WAV: ${source.name}` });
  return view;
}
function recover() { fireEvent.click(screen.getByRole("button", { name: `Recover WAV: ${source.name}` })); }
async function settled() { await waitFor(() => { expect(screen.getByRole("button", { name: "Find old projects" })).toBeEnabled(); }); }
async function prepareStarted() {
  await waitFor(() => { expect(prepareProjectFile).toHaveBeenCalledOnce(); });
  const signal = vi.mocked(prepareProjectFile).mock.calls[0]?.[1];
  if (!signal) throw new Error("Missing recovery signal");
  return signal;
}

beforeEach(() => {
  file = new File(["opaque original fixture; codec validation is mocked"], source.name, { type: "audio/wav", lastModified: source.modified });
  // Controller evidence only: actual Go/WASM CDR and encoded PCM need separate qualification.
  imported = { canonical: new Blob(["reconstructed PCM fixture"], { type: "audio/wav" }), measurement: {
    sampleRate: identity.sampleRate, frames: identity.frames, duration: identity.frames / identity.sampleRate,
    sourceIdentity: identity, beforeMetrics: metrics, afterMetrics: metrics,
  } };
  verify = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
  vi.mocked(scanLegacySources).mockResolvedValue(page);
  vi.mocked(readLegacyWav).mockResolvedValue({ file, verify });
  vi.mocked(prepareProjectFile).mockResolvedValue(imported);
  vi.mocked(newAudioAssetId).mockReturnValue("track-new-recovery");
  vi.mocked(saveAudio).mockResolvedValue({ durable: true });
  vi.mocked(discardStagedAudio).mockResolvedValue(undefined);
});
afterEach(() => { cleanup(); vi.resetAllMocks(); vi.restoreAllMocks(); });

describe("old library recovery controller", () => {
  it("reads nothing before an explicit scan and publishes a default project only after durable save and source rechecks", async () => {
    const order: string[] = [];
    const view = render(<LegacyLibraryRecovery />);
    expect(scanLegacySources).not.toHaveBeenCalled(); expect(readLegacyWav).not.toHaveBeenCalled();
    expect(prepareProjectFile).not.toHaveBeenCalled(); expect(saveAudio).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    vi.mocked(readLegacyWav).mockImplementation(() => { order.push("read selected original"); return Promise.resolve({ file, verify }); });
    vi.mocked(prepareProjectFile).mockImplementation(() => { order.push("CDR reconstruction"); return Promise.resolve(imported); });
    verify.mockImplementation(() => { order.push("check old source"); return Promise.resolve(); });
    vi.mocked(saveAudio).mockImplementation(() => { order.push("durable new source"); return Promise.resolve({ durable: true }); });
    dispatch.mockImplementation(() => { order.push("publish project"); });
    fireEvent.click(screen.getByRole("button", { name: "Find old projects" }));
    await screen.findByRole("button", { name: `Recover WAV: ${source.name}` }); recover(); await settled();
    expect(order).toEqual(["read selected original", "CDR reconstruction", "check old source", "durable new source", "check old source", "publish project"]);
    expect(scanLegacySources).toHaveBeenCalledWith(expect.any(AbortSignal), null);
    expect(readLegacyWav).toHaveBeenCalledWith(source, expect.any(AbortSignal));
    expect(prepareProjectFile).toHaveBeenCalledWith(file, expect.any(AbortSignal), expect.any(Function));
    expect(saveAudio).toHaveBeenCalledExactlyOnceWith("track-new-recovery", imported.canonical, false);
    expect(dispatch).toHaveBeenCalledOnce();
    const track = dispatch.mock.calls[0]?.[0].track;
    expect(track).toMatchObject({ id: "track-new-recovery", title: "old mix", filename: source.name, sourceIdentity: identity,
      sourceRevision: 0, measurementKind: "source", measurements: metrics, mode: "advanced", profile: "modern_pop_polish" });
    expect(track?.advanced).toEqual(clampAdvancedToSampleRate(createDefaultAdvancedParams(), identity.sampleRate));
    expect(track).not.toHaveProperty("deep"); expect(track).not.toHaveProperty("script"); expect(track).not.toHaveProperty("releaseReview");
    expect(discardStagedAudio).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: `Recover WAV: ${source.name}` })).toBeDisabled();
    view.unmount();
  });

  it("retains an unsupported original without invoking CDR, saving or publishing", async () => {
    vi.mocked(readLegacyWav).mockRejectedValue(new Error("Codec recovery is unavailable; old audio and settings are retained."));
    await findSources(); recover();
    expect(await screen.findByRole("alert")).toHaveTextContent("old audio and settings are retained"); await settled();
    expect(prepareProjectFile).not.toHaveBeenCalled(); expect(newAudioAssetId).not.toHaveBeenCalled();
    expect(saveAudio).not.toHaveBeenCalled(); expect(dispatch).not.toHaveBeenCalled(); expect(discardStagedAudio).not.toHaveBeenCalled();
  });

  it("publishes no project when durable browser storage rejects", async () => {
    vi.mocked(saveAudio).mockRejectedValue(new Error("Browser storage is full."));
    await findSources(); recover();
    expect(await screen.findByRole("alert")).toHaveTextContent("Browser storage is full"); await settled();
    expect(saveAudio).toHaveBeenCalledExactlyOnceWith("track-new-recovery", imported.canonical, false);
    expect(verify).toHaveBeenCalledOnce(); expect(dispatch).not.toHaveBeenCalled(); expect(discardStagedAudio).not.toHaveBeenCalled();
  });

  it("rejects a failed CDR result before allocation and allows a fresh explicit retry", async () => {
    vi.mocked(prepareProjectFile).mockRejectedValueOnce(new Error("Embedded non-audio payload rejected by CDR."));
    await findSources(); recover();
    expect(await screen.findByRole("alert")).toHaveTextContent("rejected by CDR"); await settled();
    expect(newAudioAssetId).not.toHaveBeenCalled(); expect(saveAudio).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled(); expect(dispatch).not.toHaveBeenCalled();
    recover(); await settled();
    expect(prepareProjectFile).toHaveBeenCalledTimes(2); expect(dispatch).toHaveBeenCalledOnce();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument(); expect(discardStagedAudio).not.toHaveBeenCalled();
  });

  it("cancels a key scan and ignores its late page without reading source audio", async () => {
    const held = deferred<LegacyPage>(); vi.mocked(scanLegacySources).mockReturnValueOnce(held.promise);
    render(<LegacyLibraryRecovery />);
    fireEvent.click(screen.getByRole("button", { name: "Find old projects" }));
    const signal = vi.mocked(scanLegacySources).mock.calls[0]?.[0];
    fireEvent.click(screen.getByRole("button", { name: "Cancel recovery" })); expect(signal?.aborted).toBe(true);
    await act(async () => { held.resolve(page); await held.promise; }); await settled();
    expect(screen.queryByRole("button", { name: `Recover WAV: ${source.name}` })).not.toBeInTheDocument();
    expect(readLegacyWav).not.toHaveBeenCalled(); expect(saveAudio).not.toHaveBeenCalled(); expect(dispatch).not.toHaveBeenCalled();
  });

  it("cancels reconstruction and rejects its late result without allocating a new source", async () => {
    const held = deferred<Imported>(); vi.mocked(prepareProjectFile).mockReturnValueOnce(held.promise);
    await findSources(); recover(); const signal = await prepareStarted();
    fireEvent.click(screen.getByRole("button", { name: "Cancel recovery" })); expect(signal.aborted).toBe(true);
    await act(async () => { held.resolve(imported); await held.promise; }); await settled();
    expect(newAudioAssetId).not.toHaveBeenCalled(); expect(saveAudio).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled(); expect(discardStagedAudio).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("cancels a pending durable save and removes only its newly staged source after settlement", async () => {
    const held = deferred<Awaited<ReturnType<typeof saveAudio>>>(); vi.mocked(saveAudio).mockReturnValueOnce(held.promise);
    await findSources(); recover(); await waitFor(() => { expect(saveAudio).toHaveBeenCalledOnce(); });
    fireEvent.click(screen.getByRole("button", { name: "Cancel recovery" }));
    expect(dispatch).not.toHaveBeenCalled(); expect(discardStagedAudio).not.toHaveBeenCalled();
    expect(() => reserveBrowserAudioMemory(maximumResident)).toThrow("memory budget");
    await act(async () => { held.resolve({ durable: true }); await held.promise; }); await settled();
    expect(discardStagedAudio).toHaveBeenCalledExactlyOnceWith("track-new-recovery", true); expect(dispatch).not.toHaveBeenCalled();
    expect(vi.mocked(readLegacyWav).mock.calls.map(([selected]) => selected.key)).toEqual([source.key]);
    const available = reserveBrowserAudioMemory(maximumResident); available.dispose();
  });

  it("admits the selected source before reading its old audio", async () => {
    const other = reserveBrowserAudioMemory(maximumResident - source.size + 1);
    try {
      await findSources(); recover();
      expect(await screen.findByRole("alert")).toHaveTextContent("memory budget"); await settled();
      expect(readLegacyWav).not.toHaveBeenCalled(); expect(prepareProjectFile).not.toHaveBeenCalled(); expect(saveAudio).not.toHaveBeenCalled();
    } finally { other.dispose(); }
  });

  it("admits canonical and storage-copy bytes before saving and releases ownership after rejection", async () => {
    const other = reserveBrowserAudioMemory(maximumResident - source.size - imported.canonical.size * 2 + 1);
    try {
      await findSources(); recover();
      expect(await screen.findByRole("alert")).toHaveTextContent("memory budget"); await settled();
      expect(prepareProjectFile).toHaveBeenCalledOnce(); expect(verify).not.toHaveBeenCalled();
      expect(saveAudio).not.toHaveBeenCalled(); expect(dispatch).not.toHaveBeenCalled();
      expect(() => { other.update(maximumResident); }).not.toThrow();
    } finally { other.dispose(); }
  });

  it.each([1, 2])("rejects old-source verification failure %s and rolls back a new copy only if staged", async (failure) => {
    if (failure === 2) verify.mockResolvedValueOnce(undefined);
    verify.mockRejectedValueOnce(new Error("The old source changed during recovery."));
    await findSources(); recover();
    expect(await screen.findByRole("alert")).toHaveTextContent("old source changed"); await settled();
    expect(dispatch).not.toHaveBeenCalled();
    if (failure === 2) {
      expect(saveAudio).toHaveBeenCalledExactlyOnceWith("track-new-recovery", imported.canonical, false);
      expect(discardStagedAudio).toHaveBeenCalledExactlyOnceWith("track-new-recovery", true);
    } else { expect(saveAudio).not.toHaveBeenCalled(); expect(discardStagedAudio).not.toHaveBeenCalled(); }
  });

  it.each(["reconstruction", "durable save"] as const)("aborts on unmount during %s and never publishes a late result", async (phase) => {
    const rendering = deferred<Imported>(), saving = deferred<Awaited<ReturnType<typeof saveAudio>>>();
    if (phase === "reconstruction") vi.mocked(prepareProjectFile).mockReturnValueOnce(rendering.promise);
    else vi.mocked(saveAudio).mockReturnValueOnce(saving.promise);
    const view = await findSources(); recover(); const signal = await prepareStarted();
    if (phase === "durable save") await waitFor(() => { expect(saveAudio).toHaveBeenCalledOnce(); });
    view.unmount(); expect(signal.aborted).toBe(true);
    await act(async () => {
      if (phase === "reconstruction") { rendering.resolve(imported); await rendering.promise; }
      else { saving.resolve({ durable: true }); await saving.promise; }
    });
    expect(dispatch).not.toHaveBeenCalled();
    if (phase === "durable save") await waitFor(() => { expect(discardStagedAudio).toHaveBeenCalledExactlyOnceWith("track-new-recovery", true); });
    else { expect(saveAudio).not.toHaveBeenCalled(); expect(discardStagedAudio).not.toHaveBeenCalled(); }
  });
});
