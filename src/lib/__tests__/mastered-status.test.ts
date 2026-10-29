import { describe, expect, it } from "vitest";
import { reduceStoreState } from "../store";
import { testStore } from "./fixtures";
import type { Track } from "../types";

const fixture = testStore.tracks[0];
if (!fixture) throw new Error("Missing fixture");
const exported: Track = { ...fixture, status: "mastered" };
const state = { ...testStore, tracks: [exported] };
const first = (value: Parameters<typeof reduceStoreState>[0]) => {
  const track = value.tracks[0];
  if (!track) throw new Error("Missing track");
  return track;
};

describe("exported project readiness", () => {
  it.each([
    { type: "UPDATE_INPUT_GAIN", trackId: exported.id, input: exported.advanced.input + 1 },
    { type: "UPDATE_SIMPLE", id: exported.id, patch: { tone: "Warm" } },
    { type: "UPDATE_COMPRESSOR", trackId: exported.id, patch: { ratio: 8 } },
    { type: "TOGGLE_MASTERING_SHORTCUT", trackId: exported.id, shortcut: "glue" },
    { type: "APPLY_REFERENCE", expected: exported, advanced: { ...exported.advanced, input: 2 } },
    { type: "UPDATE_TRACK", id: exported.id, patch: { sourceRevision: 2 } },
    { type: "INVALIDATE_EXPORT", id: exported.id },
  ] satisfies Parameters<typeof reduceStoreState>[1][])("invalidates an exported project on $type", (action) => {
    expect(first(reduceStoreState(state, action)).status).toBe("ready");
  });

  it("preserves readiness for metadata, identical settings and rejected stale changes", () => {
    for (const action of [
      { type: "UPDATE_TRACK", id: exported.id, patch: { title: "Renamed" } },
      { type: "UPDATE_INPUT_GAIN", trackId: exported.id, input: exported.advanced.input },
      { type: "APPLY_REFERENCE", expected: { ...exported }, advanced: { ...exported.advanced, input: 2 } },
    ] satisfies Parameters<typeof reduceStoreState>[1][]) {
      expect(first(reduceStoreState(state, action)).status).toBe("mastered");
    }
  });

  it("rejects an old render after an edit, but accepts identical source and payload after reverting", () => {
    const edited = reduceStoreState(state, { type: "UPDATE_INPUT_GAIN", trackId: exported.id, input: exported.advanced.input + 3 });
    expect(first(reduceStoreState(edited, { type: "COMPLETE_EXPORT", expected: exported })).status).toBe("ready");
    const reverted = reduceStoreState(edited, { type: "UPDATE_INPUT_GAIN", trackId: exported.id, input: exported.advanced.input });
    expect(first(reverted).status).toBe("ready");
    expect(first(reduceStoreState(reverted, { type: "COMPLETE_EXPORT", expected: exported })).status).toBe("mastered");
    const replaced = reduceStoreState(reverted, { type: "UPDATE_TRACK", id: exported.id, patch: { sourceRevision: 1 } });
    expect(first(reduceStoreState(replaced, { type: "COMPLETE_EXPORT", expected: exported })).status).toBe("ready");
  });
});
