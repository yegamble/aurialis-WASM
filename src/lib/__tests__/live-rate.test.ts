import { describe, expect, it } from "vitest";
import { liveContextRate, liveRateNote, liveRateStatus } from "../live-rate";

describe("live playback rate (V1-10)", () => {
  it("plays up to 48 kHz at the source rate and caps higher rates at an integer ratio", () => {
    expect([8000, 44100, 48000, 88200, 96000, 176400, 192000].map(liveContextRate)).toEqual([8000, 44100, 48000, 44100, 48000, 44100, 48000]);
  });
  it("claims nothing before the context exists unless the source is above the cap", () => {
    expect(liveRateStatus(48000, undefined)).toEqual({ kind: "pending" });
    expect(liveRateStatus(48000, 48000)).toEqual({ kind: "source" });
    expect(liveRateStatus(96000, undefined)).toEqual({ kind: "capped", liveRate: 48000, sourceRate: 96000 });
    expect(liveRateStatus(96000, 48000)).toEqual({ kind: "capped", liveRate: 48000, sourceRate: 96000 });
    expect(liveRateStatus(48000, 44100)).toEqual({ kind: "resampled", liveRate: 44100, targetRate: 48000, sourceRate: 48000 });
    expect(liveRateNote({ kind: "pending" })).toBeNull();
    expect(liveRateNote({ kind: "source" })).toBeNull();
  });
  it("blames the CPU budget for a cap and the device only for a refusal", () => {
    expect(liveRateNote(liveRateStatus(88200, 44100))).toBe("Aurialis plays this 88.2 kHz source live at 44.1 kHz to stay within its live CPU budget, so live A may differ slightly from the export (about 0.2 LU). Use Audition export for an exact listen; the export keeps the source's 88.2 kHz.");
    expect(liveRateNote(liveRateStatus(48000, 44100))).toBe("This device plays A at 44.1 kHz, not the source's 48 kHz, so live A is resampled before processing and may differ slightly from the export (about 0.2 LU). Use Audition export for an exact listen.");
    expect(liveRateNote(liveRateStatus(96000, 44100))).toBe("This device plays A at 44.1 kHz, not 48 kHz, so live A is resampled before processing and may differ slightly from the export (about 0.2 LU). Use Audition export for an exact listen.");
  });
});
