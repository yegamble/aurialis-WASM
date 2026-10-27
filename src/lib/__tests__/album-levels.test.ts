import { describe, expect, it, vi } from "vitest";
import { albumLevelSummary, albumMastersKey, albumOffset, DEFAULT_ALBUM_LEVEL, planAlbumLevels, readAlbumLevel, renderAlbumTrack, withAlbumOffset, type AlbumLevel, type AlbumRenderEngine } from "../album-levels";
import { exportParams, exportRender, exportScript } from "../engine-params";
import { CD_DELIVERY, DEFAULT_DELIVERY } from "../delivery-format";
import type { ScriptV2 } from "../deep-mastering";
import type { MeasuredAudioMetrics, Track } from "../types";
import { normalizeHydratedState, reduceStoreState } from "../store";
import { testStore } from "./fixtures";

const [first, second] = testStore.tracks as [Track, Track];
const script = { revision: 3, source: { pcmHash: "a".repeat(64), sampleRate: 48000, frames: 48000 }, chainParams: { limiter: { enabled: true, ceilingDb: -1 } } } as unknown as ScriptV2;
const deep: Track = { ...second, sourceRevision: 0, deepMastering: { sourceRevision: 0, applied: script } as NonNullable<Track["deepMastering"]> };
const normalize = (offsets: AlbumLevel["offsets"] = []): AlbumLevel => ({ mode: "normalize", targetLufs: -14, offsets });
const metrics = (integratedLufs: number, truePeakDbtp: number) => ({ integratedLufs, truePeakDbtp }) as MeasuredAudioMetrics;

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) { for (const item of Object.values(value)) deepFreeze(item); Object.freeze(value); }
  return value;
}
function engine(): AlbumRenderEngine & { [K in keyof AlbumRenderEngine]: ReturnType<typeof vi.fn> } {
  const rendered = new Blob(["rendered master"]);
  return {
    normalize: vi.fn((_file: Blob, settings: Track["advanced"]) => Promise.resolve({ advanced: { ...structuredClone(settings), input: 4.5 } })),
    render: vi.fn(() => Promise.resolve(rendered)),
    measure: vi.fn(() => Promise.resolve({ beforeMetrics: metrics(-15.96, -1.2), afterMetrics: metrics(-15.96, -1.2) })),
  };
}

describe("album level plan", () => {
  it("keeps every master at its own single-export level by default, Deep scripts included", () => {
    expect(DEFAULT_ALBUM_LEVEL.mode).toBe("keep");
    expect(planAlbumLevels(DEFAULT_ALBUM_LEVEL, [first, deep])).toEqual({ ok: true, tracks: [
      { trackId: first.id, mode: "keep" }, { trackId: deep.id, mode: "keep" },
    ] });
    // Offsets are ignored while keeping each level; nothing is normalized.
    expect(planAlbumLevels({ ...DEFAULT_ALBUM_LEVEL, offsets: [{ trackId: first.id, offsetDb: 3 }] }, [first])).toEqual({ ok: true, tracks: [{ trackId: first.id, mode: "keep" }] });
  });

  it("normalizes each track to the displayed target plus its own album offset", () => {
    expect(planAlbumLevels(normalize([{ trackId: second.id, offsetDb: -2 }]), [first, second])).toEqual({ ok: true, tracks: [
      { trackId: first.id, mode: "normalize", targetLufs: -14, offsetDb: 0, requestedLufs: -14 },
      { trackId: second.id, mode: "normalize", targetLufs: -14, offsetDb: -2, requestedLufs: -16 },
    ] });
  });

  it("refuses normalization it cannot honour instead of rendering a different level", () => {
    const blocked = planAlbumLevels(normalize(), [first, deep]);
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.error).toMatch(/Deep/u);
    const loud = planAlbumLevels({ mode: "normalize", targetLufs: -9, offsets: [{ trackId: first.id, offsetDb: 5 }] }, [first]);
    expect(loud.ok).toBe(false);
    if (!loud.ok) expect(loud.error).toMatch(/−5 LUFS/u);
  });

  it("restores saved levels and falls back to keeping each level for legacy or corrupt albums", () => {
    expect(readAlbumLevel(undefined)).toEqual(DEFAULT_ALBUM_LEVEL);
    expect(readAlbumLevel("−14 LUFS")).toEqual(DEFAULT_ALBUM_LEVEL);
    expect(readAlbumLevel({ mode: "normalize", targetLufs: -16, offsets: [{ trackId: "a", offsetDb: 1.5 }] })).toEqual({ mode: "normalize", targetLufs: -16, offsets: [{ trackId: "a", offsetDb: 1.5 }] });
    expect(readAlbumLevel({ mode: "louder", targetLufs: -3, offsets: [{ trackId: "a", offsetDb: 40 }, { trackId: 4, offsetDb: 1 }, { trackId: "b", offsetDb: Number.NaN }] }))
      .toEqual({ mode: "keep", targetLufs: -14, offsets: [{ trackId: "a", offsetDb: 6 }] });
  });

  it("edits one track's offset on the album, bounded to six dB, without touching others", () => {
    const level = withAlbumOffset(withAlbumOffset(normalize(), first.id, 2), second.id, -9);
    expect(level.offsets).toEqual([{ trackId: first.id, offsetDb: 2 }, { trackId: second.id, offsetDb: -6 }]);
    expect(albumOffset(level, second.id)).toBe(-6);
    expect(withAlbumOffset(level, first.id, 0).offsets).toEqual([{ trackId: second.id, offsetDb: -6 }]);
    expect(albumOffset(level, "missing")).toBe(0);
  });

  it("describes the level that will be used", () => {
    expect(albumLevelSummary(DEFAULT_ALBUM_LEVEL)).toBe("Keeps each master’s level");
    expect(albumLevelSummary(normalize())).toBe("Normalizes to −14 LUFS");
  });

  it("invalidates saved masters when the used level changes", () => {
    const keep = albumMastersKey([first, second], DEFAULT_ALBUM_LEVEL, DEFAULT_DELIVERY);
    expect(albumMastersKey([first, second], { ...DEFAULT_ALBUM_LEVEL, targetLufs: -16 }, DEFAULT_DELIVERY)).toBe(keep);
    const normalized = albumMastersKey([first, second], normalize(), DEFAULT_DELIVERY);
    expect(normalized).not.toBe(keep);
    expect(albumMastersKey([first, second], normalize([{ trackId: second.id, offsetDb: 1 }]), DEFAULT_DELIVERY)).not.toBe(normalized);
    expect(albumMastersKey([second, first], DEFAULT_ALBUM_LEVEL, DEFAULT_DELIVERY)).not.toBe(keep);
  });

  it("invalidates saved masters when the delivery format changes, dither included", () => {
    const keep = albumMastersKey([first, second], DEFAULT_ALBUM_LEVEL, DEFAULT_DELIVERY);
    const cd = albumMastersKey([first, second], DEFAULT_ALBUM_LEVEL, CD_DELIVERY);
    expect(cd).not.toBe(keep);
    expect(albumMastersKey([first, second], DEFAULT_ALBUM_LEVEL, { ...CD_DELIVERY, dither: false })).not.toBe(cd);
    expect(albumMastersKey([first, second], normalize(), CD_DELIVERY)).not.toBe(albumMastersKey([first, second], normalize(), DEFAULT_DELIVERY));
    // 32-bit float carries no dither, so that choice names the same masters.
    expect(albumMastersKey([first], DEFAULT_ALBUM_LEVEL, { bitDepth: 32, sampleRate: 44100, dither: false })).toBe(albumMastersKey([first], DEFAULT_ALBUM_LEVEL, { bitDepth: 32, sampleRate: 44100, dither: true }));
  });

  it("invalidates a Deep master when loading lowers its applied ceiling at the same revision", () => {
    const applied = (ceilingDbtp: number): Track => ({ ...deep, deepMastering: { sourceRevision: 0, applied: { ...script, chainParams: { limiter: { enabled: true, ceilingDbtp } } } } as NonNullable<Track["deepMastering"]> });
    expect(albumMastersKey([first, applied(-1)], DEFAULT_ALBUM_LEVEL, DEFAULT_DELIVERY)).not.toBe(albumMastersKey([first, applied(-0.2)], DEFAULT_ALBUM_LEVEL, DEFAULT_DELIVERY));
    expect(albumMastersKey([first, applied(-1)], DEFAULT_ALBUM_LEVEL, DEFAULT_DELIVERY)).toBe(albumMastersKey([first, applied(-1)], DEFAULT_ALBUM_LEVEL, DEFAULT_DELIVERY));
  });

  it("never lets a blocked normalize plan reuse the masters kept at each level", () => {
    const keep = albumMastersKey([first], DEFAULT_ALBUM_LEVEL, DEFAULT_DELIVERY);
    const blocked = albumMastersKey([first], { mode: "normalize", targetLufs: -9, offsets: [{ trackId: first.id, offsetDb: 5 }] }, DEFAULT_DELIVERY);
    expect(blocked).not.toBe(keep);
    expect(albumMastersKey([first, deep], normalize(), DEFAULT_DELIVERY)).not.toBe(albumMastersKey([first, deep], DEFAULT_ALBUM_LEVEL, DEFAULT_DELIVERY));
    // Each blocked normalize choice is its own key, never another level's.
    expect(albumMastersKey([first], { mode: "normalize", targetLufs: -9, offsets: [{ trackId: first.id, offsetDb: 6 }] }, DEFAULT_DELIVERY)).not.toBe(blocked);
  });
});

describe("album track render", () => {
  it("keeps a master's level by rendering exactly its single-export parameters, then measures the rendered file", async () => {
    const owned = engine(), track = deepFreeze(structuredClone(first)), file = new Blob(["source"]);
    const result = await renderAlbumTrack(track, file, { trackId: track.id, mode: "keep" }, DEFAULT_DELIVERY, owned);
    expect(owned.normalize).not.toHaveBeenCalled();
    expect(owned.render).toHaveBeenCalledWith(file, exportRender(first), DEFAULT_DELIVERY, undefined);
    expect(owned.measure).toHaveBeenCalledWith(await owned.render.mock.results[0]?.value, { bypass: true }, undefined);
    expect(result.measured).toEqual({ integratedLufs: -15.96, truePeakDbtp: -1.2 });
    expect(track.advanced).toEqual(first.advanced);
  });

  it("keeps an applied Deep master on its script, like its single export", async () => {
    const owned = engine(), track = deepFreeze(structuredClone(deep));
    await renderAlbumTrack(track, new Blob(["source"]), { trackId: track.id, mode: "keep" }, CD_DELIVERY, owned);
    expect(owned.render).toHaveBeenCalledWith(expect.any(Blob), { script: exportScript(script) }, CD_DELIVERY, undefined);
  });

  it("normalizes a copy of the project's settings and never writes the album level into the project", async () => {
    const owned = engine(), track = deepFreeze(structuredClone(first)), controller = new AbortController();
    await renderAlbumTrack(track, new Blob(["source"]), { trackId: track.id, mode: "normalize", targetLufs: -14, offsetDb: -2, requestedLufs: -16 }, CD_DELIVERY, owned, controller.signal);
    expect(owned.normalize).toHaveBeenCalledWith(expect.any(Blob), first.advanced, -16, controller.signal);
    expect(owned.render).toHaveBeenCalledWith(expect.any(Blob), { params: exportParams({ ...first.advanced, input: 4.5 }) }, CD_DELIVERY, controller.signal);
    expect(track.advanced).toEqual(first.advanced);
    expect(track.advanced.input).toBe(first.advanced.input);
  });
});

describe("album level persistence", () => {
  it("hydrates legacy albums to keep each level, drops the old display target and keeps saved levels", () => {
    const legacy = { id: "legacy", title: "Old", artist: "", target: "−14 LUFS", trackIds: [first.id], mastered: true };
    const saved = { id: "saved", title: "New", artist: "", level: { mode: "normalize", targetLufs: -16, offsets: [{ trackId: first.id, offsetDb: -1 }] }, trackIds: [first.id], mastered: false };
    const state = normalizeHydratedState({ tracks: [first], albums: [legacy, saved] });
    expect(state?.albums[0]).toEqual({ id: "legacy", title: "Old", artist: "", level: DEFAULT_ALBUM_LEVEL, delivery: DEFAULT_DELIVERY, trackIds: [first.id], mastered: false });
    expect(state?.albums[1]?.level).toEqual(saved.level);
    const cd = normalizeHydratedState({ tracks: [first], albums: [{ ...saved, delivery: CD_DELIVERY }, { ...saved, id: "corrupt", delivery: { bitDepth: 8 } }] });
    expect(cd?.albums.map((album) => album.delivery)).toEqual([CD_DELIVERY, DEFAULT_DELIVERY]);
  });

  it("drops offsets for tracks that are no longer on the album", () => {
    const level: AlbumLevel = { mode: "normalize", targetLufs: -16, offsets: [{ trackId: first.id, offsetDb: -1 }, { trackId: second.id, offsetDb: 2 }, { trackId: "gone", offsetDb: 3 }] };
    const album = { id: "pruned", title: "Pruned", artist: "", level, trackIds: [first.id, second.id, "gone"], mastered: false };
    const hydrated = normalizeHydratedState({ tracks: [first, second], albums: [album] });
    expect(hydrated?.albums[0]?.level.offsets).toEqual([{ trackId: first.id, offsetDb: -1 }, { trackId: second.id, offsetDb: 2 }]);
    if (!hydrated) throw new Error("hydration failed");
    const removed = reduceStoreState(hydrated, { type: "UPDATE_ALBUM", id: "pruned", patch: { trackIds: [second.id] } });
    expect(removed.albums[0]?.level.offsets).toEqual([{ trackId: second.id, offsetDb: 2 }]);
    const deleted = reduceStoreState(hydrated, { type: "DELETE_TRACK", id: second.id });
    expect(deleted.albums[0]?.level.offsets).toEqual([{ trackId: first.id, offsetDb: -1 }]);
  });
});
