import { describe, expect, it } from "vitest";
import { createDefaultAdvancedParams } from "../audio-dsp";
import { EXPORT_ALGORITHM_VERSION, engineParams, exportParams, exportScript } from "../engine-params";

describe("export parameters", () => {
  it("select the true-peak limiter while live parameters stay on algorithm 1", () => {
    const advanced = createDefaultAdvancedParams();
    const live = engineParams(advanced), exported = exportParams(advanced);
    expect(live).not.toHaveProperty("algorithmVersion");
    expect(live.limiter.truePeak).toBe(false);
    expect(exported).toEqual({ ...live, limiter: { ...live.limiter, truePeak: true }, algorithmVersion: EXPORT_ALGORITHM_VERSION });
    expect(EXPORT_ALGORITHM_VERSION).toBe(2);
  });
  it("copy an applied script without changing the stored one", () => {
    const applied = { revision: 3, chainParams: { ...engineParams(createDefaultAdvancedParams()), algorithmVersion: 1 } };
    const exported = exportScript(applied);
    expect(exported.chainParams).toMatchObject({ algorithmVersion: 2, limiter: { truePeak: true } });
    expect(exported.revision).toBe(3);
    expect(applied.chainParams).toMatchObject({ algorithmVersion: 1, limiter: { truePeak: false } });
  });
});
