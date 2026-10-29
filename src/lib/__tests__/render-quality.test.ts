import { describe, expect, it } from "vitest";
import { exportChain, exportParams, renderAlgorithm } from "../engine-params";
import { createDefaultAdvancedParams } from "../audio-dsp";
import { normalizeHydratedState, reduceStoreState } from "../store";
import { testStore } from "./fixtures";
import { prepareSimpleChange } from "../simple-directions";
import { packLiveControls } from "../live-controls";

describe("persisted render quality", () => {
  it("restores only an explicitly saved quality, keeps old sessions classic and clears invalid values", () => {
    const original = testStore.tracks[0]; if (!original) throw new Error("Missing project");
    expect(normalizeHydratedState(testStore)?.tracks[0]?.advanced.renderQuality).toBeUndefined();
    const track = { ...original, status: "mastered" as const, advanced: { ...original.advanced, renderQuality: "oversampled" as const } };
    expect(normalizeHydratedState({ ...testStore, tracks: [track] })?.tracks[0]?.advanced.renderQuality).toBe("oversampled");
    const invalid = normalizeHydratedState({ ...testStore, tracks: [{ ...track, advanced: { ...track.advanced, renderQuality: "unknown" } }] })?.tracks[0];
    expect(invalid?.advanced.renderQuality).toBeUndefined(); expect(invalid?.status).toBe("ready"); expect(invalid?.importNotice).toContain("unsupported render quality");
    const exported = { ...testStore, tracks: [{ ...original, status: "mastered" as const }] };
    expect(reduceStoreState(exported, { type: "UPDATE_TRACK", id: original.id, patch: { advanced: track.advanced } }).tracks[0]?.status).toBe("ready");
    expect(prepareSimpleChange(track, { genre: "Jazz" }).advanced.renderQuality).toBe("oversampled");
    expect(reduceStoreState({ ...testStore, tracks: [track] }, { type: "RESET_ADVANCED", trackId: track.id }).tracks[0]?.advanced.renderQuality).toBe("oversampled");
  });
  it("keeps old projects classic and selects the same oversampled algorithm for export and live", () => {
    const settings = createDefaultAdvancedParams();
    expect(renderAlgorithm()).toBe(2);
    expect(exportParams(settings).algorithmVersion).toBe(2);
    settings.renderQuality = "oversampled";
    const params = exportParams(settings);
    expect(params.algorithmVersion).toBe(3);
    expect(packLiveControls(params, 2)[81]).toBe(3);
    expect(() => packLiveControls(params, 1)).toThrow();
    expect(exportChain(params).algorithmVersion).toBe(3);
    expect(exportChain(params, "classic").algorithmVersion).toBe(2);
  });
});
