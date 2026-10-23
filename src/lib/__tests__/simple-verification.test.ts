import { afterEach, describe, expect, it, vi } from "vitest";
import { engineParams, measureAudio } from "../browser-engine";
import { verifyCanonicalSource } from "../project-import";
import { prepareSimpleChange } from "../simple-directions";
import { verifyElevatedChange } from "../simple-verification";
import { testStore } from "./fixtures";
vi.mock("../browser-engine", async (original) => ({ ...await original<typeof import("../browser-engine")>(), measureAudio: vi.fn() }));
vi.mock("../project-import", () => ({ verifyCanonicalSource: vi.fn((_blob: Blob, expected: unknown, signal: AbortSignal) => { signal.throwIfAborted(); return Promise.resolve(expected); }) }));
const original = testStore.tracks[0]; if (!original) throw new Error("Missing source");
const identity = { pcmHash: "a".repeat(64), sampleRate: 48000, frames: 48000 };
const track = { ...original, sourceIdentity: identity };
const change = prepareSimpleChange(track, { style: "elevated" });
const source = new Blob(["canonical fixture"]);
function measured() {
  const metrics = { integratedLufs: -20, shortTermLufs: -20, truePeakDbtp: -6, samplePeakDbfs: -6.1, dynamicRangeDb: 8, correlation: 0.7, lowBassCorrelation: 1, dcLeftDbfs: -120, dcRightDbfs: -120, clippingSamples: 0, gainReductionDb: 1 };
  return { sampleRate: 48000, frames: 48000, duration: 1, beforeMetrics: metrics, afterMetrics: { ...metrics } };
}
afterEach(() => { vi.clearAllMocks(); });
describe("measured Elevated acceptance", () => {
  it("measures the exact candidate without adding gain and verifies actual loaded PCM before and after", async () => {
    vi.mocked(measureAudio).mockResolvedValue(measured());
    const signal = new AbortController().signal;
    const before = JSON.stringify(change);
    expect(await verifyElevatedChange(source, track, change, signal)).toEqual({ lufs: -20, peak: -6 });
    expect(measureAudio).toHaveBeenCalledWith(source, engineParams(change.advanced), signal);
    expect(verifyCanonicalSource).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(change)).toBe(before);
  });
  it("rejects over-ceiling true peaks, samples and excess loudness without changing settings", async () => {
    for (const patch of [{ truePeakDbtp: -.8 }, { samplePeakDbfs: 0 }, { integratedLufs: -12 }]) {
      const result = measured(); Object.assign(result.afterMetrics, patch); vi.mocked(measureAudio).mockResolvedValue(result);
      await expect(verifyElevatedChange(source, track, change, new AbortController().signal)).rejects.toThrow(/exceeds/u);
    }
    expect(change.advanced.input).toBe(track.advanced.input);
  });
  it("discards changed identities and late measurements after cancellation", async () => {
    vi.mocked(measureAudio).mockResolvedValue({ ...measured(), frames: 47999 });
    await expect(verifyElevatedChange(source, track, change, new AbortController().signal)).rejects.toThrow(/source changed/u);
    const controller = new AbortController();
    vi.mocked(measureAudio).mockImplementation(() => { controller.abort(); return Promise.resolve(measured()); });
    await expect(verifyElevatedChange(source, track, change, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});
