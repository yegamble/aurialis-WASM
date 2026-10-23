import "@testing-library/jest-dom/vitest";
import { Blob as NativeBlob } from "node:buffer";
import { webcrypto } from "node:crypto";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { reserveBrowserAudioMemory } from "@/lib/browser-jobs";
import { discardStagedAudio, saveAudio } from "@/lib/db";
import { prepareProjectFile } from "@/lib/project-import";
import { StoreProvider, useStore } from "@/lib/store";
import { AlbumView } from "../AlbumsView";

vi.mock("@/lib/db", async (original) => ({
  ...await original<typeof import("@/lib/db")>(), saveAudio: vi.fn(), discardStagedAudio: vi.fn(),
}));
vi.mock("@/lib/project-import", async (original) => ({
  ...await original<typeof import("@/lib/project-import")>(), prepareProjectFile: vi.fn(),
}));
type Imported = Awaited<ReturnType<typeof prepareProjectFile>>;
const maximumResident = 448 * 1024 * 1024;
const metrics = { integratedLufs: -20, shortTermLufs: -20, truePeakDbtp: -6, samplePeakDbfs: -6, dynamicRangeDb: 14,
  correlation: 1, lowBassCorrelation: 1, dcLeftDbfs: -120, dcRightDbfs: -120, clippingSamples: 0, gainReductionDb: 0 };
let store: ReturnType<typeof useStore> | undefined, file: File, imported: Imported;
function Probe() { store = useStore(); return null; }
function state() { if (!store) throw new Error("Missing store"); return store.state; }
function deferred<T>() {
  let complete: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => { complete = resolve; });
  return { promise, resolve(value: T) { if (!complete) throw new Error("Missing resolver"); complete(value); } };
}
async function open() {
  const view = render(<StoreProvider><Probe /><AlbumView albumId="import-album" /></StoreProvider>);
  await screen.findByRole("button", { name: "Import a WAV to this album" }); return view;
}
function start() { fireEvent.change(screen.getByLabelText("Import album audio"), { target: { files: [file] } }); }
async function settled() { await waitFor(() => { expect(screen.getByRole("button", { name: "Import a WAV to this album" })).toBeEnabled(); }); }
function allReleased() { const available = reserveBrowserAudioMemory(maximumResident); available.dispose(); }
function remainsCharged() {
  let attempted: ReturnType<typeof reserveBrowserAudioMemory> | undefined;
  try { expect(() => { attempted = reserveBrowserAudioMemory(maximumResident); }).toThrow("memory budget"); }
  finally { attempted?.dispose(); }
}
beforeEach(() => {
  vi.stubGlobal("Blob", NativeBlob); vi.stubGlobal("crypto", webcrypto);
  const storage = new Map([["aurialis-state-v1", JSON.stringify({ tracks: [], albums: [{ id: "import-album", title: "Imports", artist: "", target: "−14 LUFS", trackIds: [], mastered: false }], stems: [] })]]);
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value); } });
  file = new File([new Uint8Array(64)], "new-source.wav", { type: "audio/wav" });
  // Controller ownership only; the shared import and native E2E tests qualify actual CDR/PCM.
  imported = { canonical: new Blob([new Uint8Array(128)]), measurement: { sampleRate: 8000, frames: 1, duration: 1 / 8000,
    sourceIdentity: { pcmHash: "a".repeat(64), sampleRate: 8000, frames: 1 }, beforeMetrics: metrics, afterMetrics: metrics } };
  vi.mocked(prepareProjectFile).mockResolvedValue(imported); vi.mocked(saveAudio).mockResolvedValue({ durable: true });
  vi.mocked(discardStagedAudio).mockResolvedValue(undefined);
});
afterEach(() => { cleanup(); store = undefined; vi.resetAllMocks(); vi.unstubAllGlobals(); });

describe("direct album import memory", () => {
  it("rejects source admission before reconstruction and releases its failed scope", async () => {
    const other = reserveBrowserAudioMemory(maximumResident - file.size + 1);
    try {
      await open(); start(); await expect(screen.findByRole("alert")).resolves.toHaveTextContent("memory budget"); await settled();
      expect(prepareProjectFile).not.toHaveBeenCalled(); expect(saveAudio).not.toHaveBeenCalled(); expect(state().tracks).toEqual([]);
      expect(() => { other.update(maximumResident); }).not.toThrow();
    } finally { other.dispose(); }
    allReleased();
  });
  it("claims canonical and storage-copy bytes before saving", async () => {
    const other = reserveBrowserAudioMemory(maximumResident - file.size - imported.canonical.size * 2 + 1);
    try {
      await open(); start(); await expect(screen.findByRole("alert")).resolves.toHaveTextContent("memory budget"); await settled();
      expect(prepareProjectFile).toHaveBeenCalledOnce(); expect(saveAudio).not.toHaveBeenCalled(); expect(state().tracks).toEqual([]);
      expect(() => { other.update(maximumResident); }).not.toThrow();
    } finally { other.dispose(); }
    allReleased();
  });
  it.each(["cancel", "unmount"] as const)("keeps a pending save and rollback charged after %s and rejects its late project", async (action) => {
    const saving = deferred<Awaited<ReturnType<typeof saveAudio>>>(), rollback = deferred<void>();
    vi.mocked(saveAudio).mockReturnValueOnce(saving.promise); vi.mocked(discardStagedAudio).mockReturnValueOnce(rollback.promise);
    const view = await open(); start(); await waitFor(() => { expect(saveAudio).toHaveBeenCalledOnce(); });
    remainsCharged();
    if (action === "cancel") fireEvent.click(screen.getByRole("button", { name: "Cancel album import" })); else view.unmount();
    remainsCharged();
    await act(async () => { saving.resolve({ durable: true }); await saving.promise; });
    await waitFor(() => { expect(discardStagedAudio).toHaveBeenCalledOnce(); });
    expect(discardStagedAudio).toHaveBeenCalledWith(vi.mocked(saveAudio).mock.calls[0]?.[0], true);
    remainsCharged();
    await act(async () => { rollback.resolve(); await rollback.promise; });
    if (action === "cancel") { await settled(); expect(state().tracks).toEqual([]); }
    allReleased();
  });
  it("surfaces failed staged cleanup after cancellation and releases its owner", async () => {
    const saving = deferred<Awaited<ReturnType<typeof saveAudio>>>(); vi.mocked(saveAudio).mockReturnValueOnce(saving.promise);
    vi.mocked(discardStagedAudio).mockRejectedValueOnce(new Error("Storage denied during rollback"));
    await open(); start(); await waitFor(() => { expect(saveAudio).toHaveBeenCalledOnce(); });
    fireEvent.click(screen.getByRole("button", { name: "Cancel album import" }));
    await act(async () => { saving.resolve({ durable: true }); await saving.promise; });
    await expect(screen.findByRole("alert")).resolves.toHaveTextContent("new temporary copy could not be removed"); await settled();
    expect(state().tracks).toEqual([]); allReleased();
  });
});
