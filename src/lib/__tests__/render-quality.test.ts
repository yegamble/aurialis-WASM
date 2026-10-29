import { describe, expect, it } from "vitest";
import { exportChain, exportParams, renderAlgorithm } from "../engine-params";
import { createDefaultAdvancedParams } from "../audio-dsp";
import { packLiveControls } from "../live-controls";

describe("persisted render quality", () => {
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
