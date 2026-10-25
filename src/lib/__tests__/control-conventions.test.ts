import { describe, expect, it } from "vitest";
import { effectiveBellQ, monoBassMinus3dBHz, shelfMidpointHz, timeConstantMs } from "../control-conventions";

// Expected values were measured from the Go engine with sine sweeps
// (docs/audits/2026-10-24-mastering-tools-audit.md, findings 7, 8, 9 and 11).
describe("pro-convention readouts of engine controls", () => {
  it("reports shelf midpoints", () => {
    expect(shelfMidpointHz("lowshelf", 100, 48000)).toBeCloseTo(185, 6);
    expect(shelfMidpointHz("lowshelf", 250, 48000)).toBeCloseTo(462.5, 6);
    expect(shelfMidpointHz("highshelf", 8000, 48000)).toBeCloseTo(5194.8, 1);
    expect(shelfMidpointHz("highshelf", 12000, 48000)).toBeCloseTo(7792.2, 1);
    expect(shelfMidpointHz("lowshelf", 18000, 44100)).toBeCloseTo(21388.5, 6);
  });
  it("reports gain-dependent bell Q", () => {
    expect(effectiveBellQ(1, 0)).toBe(1);
    expect(effectiveBellQ(1, 6)).toBe(2.5);
    expect(effectiveBellQ(0.7, -12)).toBeCloseTo(2.8, 10);
  });
  it("reports the mono-bass −3 dB point", () => {
    expect(monoBassMinus3dBHz(110)).toBeCloseTo(242, 0);
  });
  it("reports 63% time constants", () => {
    expect(timeConstantMs(10)).toBe(4);
    expect(timeConstantMs(220)).toBe(88);
  });
});
