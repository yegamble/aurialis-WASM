import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as engine from "@/lib/browser-engine";
import * as memory from "@/lib/browser-jobs";
import { StoreProvider } from "@/lib/store";
import { testStore } from "@/lib/__tests__/fixtures";
import { albumMastersKey, DEFAULT_ALBUM_LEVEL } from "@/lib/album-levels";
import { CD_DELIVERY, DEFAULT_DELIVERY } from "@/lib/delivery-format";
import { exportParams } from "@/lib/engine-params";
import type { Track } from "@/lib/types";
import { AurialisWorkstation } from "../AurialisWorkstation";

const mocks = vi.hoisted(() => ({ getAudio: vi.fn(), saveAudio: vi.fn(), deleteAudio: vi.fn(), loadAlbumMasters: vi.fn(), saveAlbumMasters: vi.fn() }));
// Browser storage is unavailable by default, exercising the bounded in-memory album cache.
vi.mock("@/lib/db", () => ({ getAudio: mocks.getAudio, saveAudio: mocks.saveAudio, deleteAudio: mocks.deleteAudio, newAudioAssetId: (prefix: string) => `${prefix}-${String(Math.random()).slice(2)}`, loadAlbumMasters: mocks.loadAlbumMasters, saveAlbumMasters: mocks.saveAlbumMasters, deleteAlbumMasters: vi.fn(), ensureStorageFor: () => Promise.resolve() }));
vi.mock("next/navigation", () => ({ usePathname: () => null }));
const reserve = memory.reserveBrowserAudioMemory;
const owners: { update: ReturnType<typeof vi.fn<(bytes: number) => void>>; dispose: ReturnType<typeof vi.fn<() => void>> }[] = [];
const metrics = { integratedLufs: -14, shortTermLufs: -14, truePeakDbtp: -6, samplePeakDbfs: -6, dynamicRangeDb: 8, correlation: 1, lowBassCorrelation: 1, dcLeftDbfs: -120, dcRightDbfs: -120, clippingSamples: 0, gainReductionDb: 0 };
const wav = new Blob([new Uint8Array(44 + 48000 * 6)]);
const delivered = { blob: wav, truePeakDbtp: null };
let storage = new Map<string, string>();
let tracks: Track[] = [];
function seed(level?: unknown, delivery?: unknown) {
  const album = { id: "memory-album", title: "Memory album", artist: "", ...(level === undefined ? { target: "−14 LUFS" } : { level }), ...(delivery === undefined ? {} : { delivery }), trackIds: tracks.map((track) => track.id), mastered: false };
  storage.set("aurialis-state-v1", JSON.stringify({ tracks, albums: [album], stems: [] }));
}
function saved() { return JSON.parse(storage.get("aurialis-state-v1") ?? "{}") as { tracks: Track[]; albums: { level: unknown; delivery: unknown }[] }; }
function mount() { return render(<StoreProvider><AurialisWorkstation route="album" paramId="memory-album" /></StoreProvider>); }
async function start() { fireEvent.click(await screen.findByRole("button", { name: "Render album masters" })); }

beforeEach(() => {
  owners.length = 0;
  tracks = testStore.tracks.map((track, index) => ({ ...track, title: "Album source " + String(index + 1), measurements: { ...metrics, integratedLufs: -20 - index }, measurementKind: "source" as const }));
  storage = new Map();
  seed();
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
  vi.spyOn(engine, "measureAudio").mockImplementation((file) => {
    expect(file).toBe(wav);
    return Promise.resolve({ sampleRate: 48000, frames: 48000, duration: 1, beforeMetrics: { ...metrics, integratedLufs: -15.96, truePeakDbtp: -1.24 }, afterMetrics: metrics });
  });
  vi.spyOn(engine, "renderDelivery").mockResolvedValue(delivered);
});
afterEach(() => { cleanup(); for (const owner of owners) owner.dispose(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("owns the growing download cache before each render and releases it when its order is invalidated", async () => {
  mount();
  vi.mocked(engine.renderDelivery).mockImplementation(() => {
    expect(owners[0]?.update).toHaveBeenLastCalledWith((vi.mocked(engine.renderDelivery).mock.calls.length) * wav.size);
    return Promise.resolve(delivered);
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
  mount(); vi.mocked(engine.renderDelivery).mockResolvedValueOnce(delivered).mockRejectedValueOnce(new Error("Controlled second-render failure"));
  await start();
  await screen.findByText(`“${tracks[1]?.title ?? ""}” could not be rendered: Controlled second-render failure`);
  expect(owners[0]?.update).toHaveBeenCalledWith(2 * wav.size);
  expect(owners[0]?.dispose).toHaveBeenCalledOnce();
  expect(screen.queryByRole("region", { name: "Rendered album downloads" })).toBeNull();
});

it("releases a pending reservation on unmount and never retains its late rendered WAV", async () => {
  const mounted = mount();
  let finish: ((value: typeof delivered) => void) | undefined;
  vi.mocked(engine.renderDelivery).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  await start(); await waitFor(() => { expect(finish).toBeTypeOf("function"); });
  expect(owners[0]?.update).toHaveBeenCalledWith(wav.size);
  mounted.unmount(); expect(owners[0]?.dispose).toHaveBeenCalledOnce();
  await act(async () => { finish?.(delivered); await Promise.resolve(); });
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
  mount(); vi.mocked(engine.renderDelivery).mockResolvedValueOnce(delivered).mockRejectedValueOnce(new Error("Controlled second-render failure"));
  await start();
  await screen.findByText(`“${tracks[1]?.title ?? ""}” could not be rendered: Controlled second-render failure`);
  const saved = mocks.saveAudio.mock.calls[0]?.[0] as string;
  expect(mocks.deleteAudio).toHaveBeenCalledWith(saved);
  expect(mocks.saveAlbumMasters).not.toHaveBeenCalled();
});

it("offers saved masters after a reload when the sequence and settings still match", async () => {
  const key = albumMastersKey(tracks, DEFAULT_ALBUM_LEVEL, DEFAULT_DELIVERY);
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

it("never offers masters kept at each level while a blocked normalize level is chosen", async () => {
  seed({ mode: "normalize", targetLufs: -9, offsets: [{ trackId: tracks[0]?.id, offsetDb: 5 }] });
  const key = albumMastersKey(tracks, DEFAULT_ALBUM_LEVEL, DEFAULT_DELIVERY);
  mocks.loadAlbumMasters.mockResolvedValue({ key, createdAt: "2026-10-26T00:00:00Z", files: tracks.map((track, index) => ({ trackId: track.id, title: track.title, audioId: "master-" + String(index), bytes: 10 })) });
  mount();
  expect(await screen.findByText(/Saved masters no longer match/u)).toBeDefined();
  expect(screen.getAllByText("Normalizes to −9 LUFS").length).toBeGreaterThan(0);
  expect(screen.queryByText("Masters ready to download")).toBeNull();
  expect(screen.queryByRole("region", { name: "Rendered album downloads" })).toBeNull();
  expect(screen.getByRole("button", { name: "Render album masters" }).hasAttribute("disabled")).toBe(true);
});

it("replaces the render success notice with the stale notice once the level or sequence changes", async () => {
  mocks.saveAudio.mockResolvedValue({ durable: true });
  mount(); await start();
  expect(await screen.findByText(/masters are saved in this browser/u)).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "Normalize to a target" }));
  expect(await screen.findByText(/Saved masters no longer match/u)).toBeDefined();
  expect(screen.queryByText(/masters are saved in this browser/u)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Keep each master’s level" }));
  await screen.findByRole("button", { name: "Download all as ZIP" });
  fireEvent.click(screen.getByRole("button", { name: "Remove Album source 2 from album" }));
  expect(await screen.findByText(/Saved masters no longer match/u)).toBeDefined();
});

it("announces why a normalize level cannot render next to the offset controls", async () => {
  seed({ mode: "normalize", targetLufs: -9, offsets: [] });
  mount();
  const panel = await screen.findByRole("region", { name: "Album level" });
  const status = within(panel).getByRole("status");
  expect(status.textContent).toBe("");
  fireEvent.change(within(panel).getByRole("slider", { name: "Album source 1 album offset" }), { target: { value: "5" } });
  expect(status.textContent).toMatch(/“Album source 1” would need −4 LUFS/u);
  expect(screen.getByRole("button", { name: "Render album masters" }).hasAttribute("disabled")).toBe(true);
});

it("keeps each master's single-export level by default and never writes into the projects", async () => {
  mount();
  expect((await screen.findAllByText("Keeps each master’s level")).length).toBeGreaterThan(0);
  expect(screen.queryByRole("table", { name: "Measured album masters" })).toBeNull();
  const before = saved().tracks;
  expect(before.map((track) => track.advanced)).toEqual(tracks.map((track) => track.advanced));
  await start();
  await screen.findByRole("button", { name: "Download Album source 2" });
  expect(engine.normalizeSimpleAudio).not.toHaveBeenCalled();
  expect(vi.mocked(engine.renderDelivery).mock.calls.map((call) => call.slice(1, 4))).toEqual(tracks.map((track) => [{ params: exportParams(track.advanced) }, 24, {}]));
  expect(saved().tracks).toEqual(before);
  expect(saved().tracks.map((track) => track.measurementKind)).toEqual(["source", "source"]);
});

it("normalizes to the displayed target plus each track's album offset, leaving the projects untouched", async () => {
  mount();
  fireEvent.click(await screen.findByRole("button", { name: "Normalize to a target" }));
  fireEvent.click(screen.getByRole("button", { name: "−16 LUFS" }));
  fireEvent.change(screen.getByRole("slider", { name: "Album source 2 album offset" }), { target: { value: "-2" } });
  expect(screen.getAllByText("Normalizes to −16 LUFS").length).toBeGreaterThan(0);
  expect(screen.getByText("Renders at −18 LUFS")).toBeDefined();
  const before = saved().tracks;
  await start();
  await screen.findByRole("button", { name: "Download Album source 2" });
  expect(vi.mocked(engine.normalizeSimpleAudio).mock.calls.map((call) => [call[1], call[2]])).toEqual(tracks.map((track, index) => [track.advanced, index ? -18 : -16]));
  const state = saved();
  expect(state.tracks).toEqual(before);
  expect(state.albums[0]?.level).toEqual({ mode: "normalize", targetLufs: -16, offsets: [{ trackId: "test-2", offsetDb: -2 }] });
});

it("charts only levels measured from the rendered masters", async () => {
  seed({ mode: "normalize", targetLufs: -16, offsets: [] });
  mount(); await start();
  const table = await screen.findByRole("table", { name: "Measured album masters" });
  expect(engine.measureAudio).toHaveBeenCalledTimes(2);
  expect(vi.mocked(engine.measureAudio).mock.calls[0]?.[1]).toEqual({ bypass: true });
  expect(table.textContent).toContain("−15.96 LUFS");
  expect(table.textContent).toContain("−1.24 dBTP");
  expect(table.textContent).toContain("−16 LUFS");
  expect(table.textContent).not.toContain("−20");
});

it("names the track whose normalize render failed", async () => {
  seed({ mode: "normalize", targetLufs: -16, offsets: [] });
  vi.mocked(engine.normalizeSimpleAudio).mockReset().mockImplementation((_source, advanced) => Promise.resolve({ advanced, measurement: { sampleRate: 48000, frames: 48000, duration: 1, beforeMetrics: metrics, afterMetrics: metrics } }))
    .mockImplementationOnce((_source, advanced) => Promise.resolve({ advanced, measurement: { sampleRate: 48000, frames: 48000, duration: 1, beforeMetrics: metrics, afterMetrics: metrics } }))
    .mockRejectedValueOnce(new Error("The source is too quiet to normalize reliably."));
  mount(); await start();
  await screen.findByText(`“${tracks[1]?.title ?? ""}” could not be rendered: The source is too quiet to normalize reliably.`);
  expect(screen.queryByRole("region", { name: "Rendered album downloads" })).toBeNull();
});

it("renders a mixed-rate album at one chosen delivery format, the same request a single export sends", async () => {
  tracks = [{ ...tracks[0], sampleRate: 48000 } as Track, { ...tracks[1], sampleRate: 44100, duration: 1, sourceIdentity: { pcmHash: "f".repeat(64), sampleRate: 44100, frames: 44100 } } as Track];
  seed({ mode: "keep", targetLufs: -14, offsets: [] });
  mount();
  const panel = await screen.findByRole("region", { name: "Album delivery format" });
  // The format is its own region, never part of the album level controls.
  expect(within(screen.getByRole("region", { name: "Album level" })).queryByRole("group", { name: "Sample rate" })).toBeNull();
  expect(within(panel).getByText("These sources use 44.1 kHz and 48 kHz. Choose one sample rate for a uniform album.")).toBeDefined();
  fireEvent.click(within(within(panel).getByRole("group", { name: "Sample rate" })).getByRole("button", { name: "44.1 kHz" }));
  fireEvent.click(within(within(panel).getByRole("group", { name: "Bit depth" })).getByRole("button", { name: "16-bit PCM" }));
  expect(saved().albums[0]?.delivery).toEqual(CD_DELIVERY);
  expect(screen.getAllByText("44.1 kHz · 16-bit PCM · TPDF dither").length).toBeGreaterThan(0);
  await start();
  await screen.findByRole("button", { name: "Download Album source 2" });
  expect(vi.mocked(engine.renderDelivery).mock.calls.map((call) => call.slice(1, 4))).toEqual(tracks.map((track) => [{ params: exportParams(track.advanced) }, 16, { sampleRate: 44100 }]));
  // Each master's reservation is its 44.1 kHz 16-bit length, not its source layout.
  expect(owners[0]?.update).toHaveBeenCalledWith(44 + 44100 * 4);
  expect(screen.getByText(/Rendered WAV masters are ready below \(44\.1 kHz · 16-bit PCM · TPDF dither\)/u)).toBeDefined();
  // Masters rendered at one format are never offered for another.
  fireEvent.click(within(within(panel).getByRole("group", { name: "Dither" })).getByRole("button", { name: "Off" }));
  await waitFor(() => { expect(screen.queryByRole("region", { name: "Rendered album downloads" })).toBeNull(); });
});

it("offers one tap to CD format when the album mixes source rates", async () => {
  tracks = [{ ...tracks[0], sampleRate: 48000 } as Track, { ...tracks[1], sampleRate: 44100, duration: 1, sourceIdentity: { pcmHash: "f".repeat(64), sampleRate: 44100, frames: 44100 } } as Track];
  seed({ mode: "keep", targetLufs: -14, offsets: [] });
  mount();
  const panel = await screen.findByRole("region", { name: "Album delivery format" });
  fireEvent.click(within(panel).getByRole("button", { name: "Use CD format: 44.1 kHz, 16-bit" }));
  expect(saved().albums[0]?.delivery).toEqual(CD_DELIVERY);
  expect(within(panel).queryByRole("button", { name: "Use CD format: 44.1 kHz, 16-bit" })).toBeNull();
});

it("hides the CD shortcut for an album at one source rate", async () => {
  mount();
  const panel = await screen.findByRole("region", { name: "Album delivery format" });
  expect(within(panel).queryByRole("button", { name: "Use CD format: 44.1 kHz, 16-bit" })).toBeNull();
});

it("says in the album status when a track cannot reach the saved rate and masters fall back to each source rate", async () => {
  // 8017 Hz has no exact polyphase ratio to 44.1 kHz, so the saved CD rate is unavailable.
  tracks = [tracks[0] as Track, { ...tracks[1], sampleRate: 8017, duration: 1, sourceIdentity: { pcmHash: "f".repeat(64), sampleRate: 8017, frames: 8017 } } as Track];
  seed({ mode: "keep", targetLufs: -14, offsets: [] }, CD_DELIVERY);
  mount();
  const status = await screen.findByText(/“Album source 2” cannot be delivered at 44\.1 kHz/u);
  expect(status.getAttribute("role")).toBe("status");
  expect(status.textContent).toContain("each source rate");
  expect(saved().albums[0]?.delivery).toEqual(CD_DELIVERY);
});
