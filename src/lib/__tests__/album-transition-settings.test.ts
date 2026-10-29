import { describe, expect, it } from "vitest";
import { normalizeHydratedState, reduceStoreState } from "../store";
import { DEFAULT_ALBUM_LEVEL, albumMastersKey } from "../album-levels";
import { DEFAULT_DELIVERY } from "../delivery-format";
import { testStore } from "./fixtures";
import { readAlbumTransition } from "../album-transition-settings";

describe("persisted album transitions", () => {
  it("defaults old and untrusted settings to exact gapless boundaries", () => {
    for (const value of [undefined, null, true, "crossfade", {}, { mode: "other", seconds: 4 }]) expect(readAlbumTransition(value)).toEqual({ mode: "gapless", seconds: 0 });
  });
  it("bounds durations without changing a valid transition mode", () => {
    expect(readAlbumTransition({ mode: "gap", seconds: 99 })).toEqual({ mode: "gap", seconds: 5 });
    expect(readAlbumTransition({ mode: "crossfade", seconds: -1 })).toEqual({ mode: "crossfade", seconds: 0 });
    expect(readAlbumTransition({ mode: "crossfade", seconds: 0.4 })).toEqual({ mode: "crossfade", seconds: 0.4 });
    expect(readAlbumTransition({ mode: "gap", seconds: Number.NaN })).toEqual({ mode: "gap", seconds: 0 });
  });
});

describe("album transition persistence", () => {
  it("hydrates old albums and round-trips transition edits independently of master identity", () => {
    const legacy = { id: "album", title: "Album", artist: "Artist", trackIds: ["demo-1"], mastered: false, level: DEFAULT_ALBUM_LEVEL, delivery: DEFAULT_DELIVERY };
    const state = normalizeHydratedState({ ...testStore, albums: [legacy] });
    expect(state?.albums[0]?.transition).toEqual({ mode: "gapless", seconds: 0 });
    if (!state) throw new Error("Missing hydrated state");
    const before = state.albums[0];
    if (!before) throw new Error("Missing album");
    const next = reduceStoreState(state, { type: "UPDATE_ALBUM", id: "album", patch: { transition: { mode: "crossfade", seconds: 0.5 } } });
    const after = next.albums[0];
    if (!after) throw new Error("Missing edited album");
    expect(albumMastersKey(state.tracks, before.level, before.delivery)).toBe(albumMastersKey(next.tracks, after.level, after.delivery));
    expect(after.level).toEqual(before.level); expect(after.delivery).toEqual(before.delivery);
    expect(normalizeHydratedState(next)?.albums[0]?.transition).toEqual({ mode: "crossfade", seconds: 0.5 });
  });
});
