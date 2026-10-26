import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as engine from "@/lib/browser-engine";
import * as memory from "@/lib/browser-jobs";
import { StoreProvider } from "@/lib/store";
import { testStore } from "@/lib/__tests__/fixtures";
import { engineParams } from "@/lib/engine-params";
import { AurialisWorkstation } from "../AurialisWorkstation";

const mocks = vi.hoisted(() => ({ getAudio: vi.fn(), saveAudio: vi.fn(), deleteAudio: vi.fn(), loadAlbumMasters: vi.fn(), saveAlbumMasters: vi.fn() }));
// Browser storage is unavailable by default, exercising the bounded in-memory album cache.
vi.mock("@/lib/db", () => ({ getAudio: mocks.getAudio, saveAudio: mocks.saveAudio, deleteAudio: mocks.deleteAudio, newAudioAssetId: (prefix: string) => `${prefix}-${String(Math.random()).slice(2)}`, loadAlbumMasters: mocks.loadAlbumMasters, saveAlbumMasters: mocks.saveAlbumMasters, deleteAlbumMasters: vi.fn(), ensureStorageFor: () => Promise.resolve() }));
vi.mock("next/navigation", () => ({ usePathname: () => null }));
const reserve = memory.reserveBrowserAudioMemory;
const owners: { update: ReturnType<typeof vi.fn<(bytes: number) => void>>; dispose: ReturnType<typeof vi.fn<() => void>> }[] = [];
const metrics = { integratedLufs: -14, shortTermLufs: -14, truePeakDbtp: -6, samplePeakDbfs: -6, dynamicRangeDb: 8, correlation: 1, lowBassCorrelation: 1, dcLeftDbfs: -120, dcRightDbfs: -120, clippingSamples: 0, gainReductionDb: 0 };
const wav = new Blob([new Uint8Array(44 + 48000 * 6)]);
function mount() { return render(<StoreProvider><AurialisWorkstation route="album" paramId="memory-album" /></StoreProvider>); }
async function start() { fireEvent.click(await screen.findByRole("button", { name: "Render album masters" })); }

beforeEach(() => {
  owners.length = 0;
  const tracks = testStore.tracks.map((track, index) => ({ ...track, title: "Album source " + String(index + 1) }));
  const storage = new Map([["aurialis-state-v1", JSON.stringify({ tracks, albums: [{ id: "memory-album", title: "Memory album", artist: "", target: "−14 LUFS", trackIds: tracks.map((track) => track.id), mastered: false }], stems: [] })]]);
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value); } });
  window.history.replaceState(null, "", "/albums/memory-album");
  mocks.getAudio.mockReset().mockResolvedValue(new Blob(["source fixture"]));
  mocks.saveAudio.mockReset().mockRejectedValue(new Error("Storage unavailable"));
  mocks.deleteAudio.mockReset().mockResolvedValue(undefined);
  mocks.loadAlbumMasters.mockReset().mockResolvedValue(undefined);
  mocks.saveAlbumMasters.mockReset().mockResolvedValue(undefined);
  vi.spyOn(memory, "reserveBrowserAudioMemory").mockImplementation((bytes = 0) => {
    const owned = reserve(bytes);
    const observed = { update: vi.fn(owned.update), dispose: vi.fn(owned.dispose) };
    owners.push(observed); return observed;
  });
  vi.spyOn(engine, "normalizeSimpleAudio").mockImplementation((_source, advanced) => Promise.resolve({ advanced, measurement: { sampleRate: 48000, frames: 48000, duration: 1, beforeMetrics: metrics, afterMetrics: metrics } }));
  vi.spyOn(engine, "measureAudio").mockRejectedValue(new Error("Album render must reuse the normalization measurement"));
  vi.spyOn(engine, "serverRender").mockResolvedValue(wav);
});
afterEach(() => { cleanup(); for (const owner of owners) owner.dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("owns the growing download cache before each render and releases it when its order is invalidated", async () => {
  mount();
  vi.mocked(engine.serverRender).mockImplementation(() => {
    expect(owners[0]?.update).toHaveBeenLastCalledWith((vi.mocked(engine.serverRender).mock.calls.length) * wav.size);
    return Promise.resolve(wav);
  });
  await start();
  await screen.findByRole("button", { name: "Download Album source 2" });
  expect(owners).toHaveLength(1);
  expect(owners[0]?.dispose).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Move Album source 1 down" }));
  await waitFor(() => { expect(owners[0]?.dispose).toHaveBeenCalledOnce(); });
  expect(screen.queryByRole("region", { name: "Rendered album downloads" })).toBeNull();
});

it("releases completed prefix bytes when a later render fails", async () => {
  mount(); vi.mocked(engine.serverRender).mockResolvedValueOnce(wav).mockRejectedValueOnce(new Error("Controlled second-render failure"));
  await start();
  await screen.findByText("Controlled second-render failure");
  expect(owners[0]?.update).toHaveBeenCalledWith(2 * wav.size);
  expect(owners[0]?.dispose).toHaveBeenCalledOnce();
  expect(screen.queryByRole("region", { name: "Rendered album downloads" })).toBeNull();
});

it("releases a pending reservation on unmount and never retains its late rendered WAV", async () => {
  const mounted = mount();
  let finish: ((value: Blob) => void) | undefined;
  vi.mocked(engine.serverRender).mockImplementation(() => new Promise<Blob>((resolve) => { finish = resolve; }));
  await start(); await waitFor(() => { expect(finish).toBeTypeOf("function"); });
  expect(owners[0]?.update).toHaveBeenCalledWith(wav.size);
  mounted.unmount(); expect(owners[0]?.dispose).toHaveBeenCalledOnce();
  await act(async () => { finish?.(wav); await Promise.resolve(); });
  expect(owners[0]?.dispose).toHaveBeenCalledTimes(2);
});

it("surfaces download allocation failure while preserving the already rendered cache", async () => {
  mount(); await start();
  const download = await screen.findByRole("button", { name: "Download Album source 2" });
  vi.mocked(memory.reserveBrowserAudioMemory).mockImplementationOnce(() => { throw new Error("Controlled download memory budget"); });
  fireEvent.click(download);
  expect(await screen.findByText("Controlled download memory budget")).toBeDefined();
  expect(screen.getByRole("region", { name: "Rendered album downloads" })).toBeDefined();
  expect(owners[0]?.dispose).not.toHaveBeenCalled();
});

it("saves masters to browser storage as they render, holding only the current track in memory", async () => {
  mocks.saveAudio.mockResolvedValue({ durable: true });
  mount(); await start();
  await waitFor(() => { expect(mocks.saveAlbumMasters).toHaveBeenCalled(); });
  await screen.findByRole("button", { name: "Download all as ZIP" });
  expect(mocks.saveAudio).toHaveBeenCalledTimes(2);
  expect(owners[0]?.update).toHaveBeenLastCalledWith(0);
  expect(owners[0]?.dispose).toHaveBeenCalledOnce();
  const [albumId, record] = mocks.saveAlbumMasters.mock.calls[0] as [string, { files: { title: string; audioId: string }[] }];
  expect(albumId).toBe("memory-album");
  expect(record.files.map((file) => file.title)).toEqual(["Album source 1", "Album source 2"]);
  expect(mocks.deleteAudio).not.toHaveBeenCalled();
});

it("deletes partially saved masters when a later render fails", async () => {
  mocks.saveAudio.mockResolvedValue({ durable: true });
  mount(); vi.mocked(engine.serverRender).mockResolvedValueOnce(wav).mockRejectedValueOnce(new Error("Controlled second-render failure"));
  await start();
  await screen.findByText("Controlled second-render failure");
  const saved = mocks.saveAudio.mock.calls[0]?.[0] as string;
  expect(mocks.deleteAudio).toHaveBeenCalledWith(saved);
  expect(mocks.saveAlbumMasters).not.toHaveBeenCalled();
});

it("offers saved masters after a reload when the sequence and settings still match", async () => {
  const tracks = testStore.tracks;
  const key = JSON.stringify(tracks.map((track) => [track.id, track.sourceRevision, engineParams(track.advanced)]));
  mocks.loadAlbumMasters.mockResolvedValue({ key, createdAt: "2026-10-26T00:00:00Z", files: tracks.map((track, index) => ({ trackId: track.id, title: "Album source " + String(index + 1), audioId: "master-" + String(index), bytes: 10 })) });
  mount();
  expect(await screen.findByRole("button", { name: "Download Album source 2" })).toBeDefined();
  expect(screen.getByRole("button", { name: "Download all as ZIP" })).toBeDefined();
});

it("explains that saved masters are stale once the sequence changes", async () => {
  mocks.loadAlbumMasters.mockResolvedValue({ key: "an earlier sequence", createdAt: "2026-10-26T00:00:00Z", files: [{ trackId: "x", title: "Old", audioId: "master-old", bytes: 10 }] });
  mount();
  expect(await screen.findByText(/Saved masters no longer match/u)).toBeDefined();
  expect(screen.queryByRole("region", { name: "Rendered album downloads" })).toBeNull();
});
