import { afterEach, describe, expect, it, vi } from "vitest";
import { testStore } from "./fixtures";
import { audioKey, duplicateProject, replacementProject, sameSource, sortedTracks } from "../library";
import type { prepareProjectFile } from "../project-import";
const storage = vi.hoisted(() => ({ getAudio: vi.fn(), saveAudio: vi.fn(), discardStagedAudio: vi.fn() }));
vi.mock("../db", () => storage);
afterEach(() => { vi.clearAllMocks(); });
const track = testStore.tracks[0];
if (!track) throw new Error("Missing track");
const identity = { pcmHash: "a".repeat(64), sampleRate: 48000, frames: 48000 };
describe("Library project lifecycle", () => {
  it("sorts filtered copies deterministically without changing the playback queue", () => {
    const source = [{ ...track, id: "b", title: "Zulu", duration: 2 }, { ...track, id: "a", title: "Alpha", duration: 1 }];
    expect(sortedTracks(source, "name").map((item) => item.id)).toEqual(["a", "b"]);
    expect(sortedTracks(source, "duration").map((item) => item.id)).toEqual(["a", "b"]);
    expect(source.map((item) => item.id)).toEqual(["b", "a"]);
  });
  it("requires the complete authoritative identity, allowing equivalent containers", () => {
    expect(sameSource(identity, { ...identity })).toBe(true);
    expect(sameSource(identity, { ...identity, frames: 1 })).toBe(false);
    expect(sameSource(undefined, undefined)).toBe(false);
    expect(sameSource(identity, { ...identity, pcmHash: "b".repeat(64) })).toBe(false);
  });
  it("duplicates independent settings and audio only after successful storage", async () => {
    const blob = new Blob(["audio"]); storage.getAudio.mockResolvedValue(blob); storage.saveAudio.mockResolvedValue({ durable: true });
    const result = await duplicateProject({ ...track, sourceAudioId: "replacement", retiredSourceAudioIds: ["old"] }, new AbortController().signal);
    expect(storage.getAudio).toHaveBeenCalledWith("replacement");
    expect(storage.saveAudio).toHaveBeenCalledWith(result.id, blob);
    expect(result.id).not.toBe(track.id); expect(result.advanced).toEqual(track.advanced); expect(result.advanced).not.toBe(track.advanced);
    expect(audioKey(result)).toBe(result.id); expect(result.retiredSourceAudioIds).toBeUndefined();
    result.advanced.eqBands[0].gainDb = 4; expect(track.advanced.eqBands[0].gainDb).toBe(0);
  });
  it("rolls back a canceled post-write duplicate before metadata can be added", async () => {
    const controller = new AbortController(); storage.getAudio.mockResolvedValue(new Blob(["audio"]));
    storage.saveAudio.mockImplementation(() => { controller.abort(); return Promise.resolve({ durable: true }); });
    await expect(duplicateProject(track, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    expect(storage.discardStagedAudio).toHaveBeenCalledWith(expect.stringMatching(/^track-/u), true);
  });
  it("does not create a duplicate when source storage is missing or cannot retain the copy", async () => {
    storage.getAudio.mockResolvedValue(undefined); await expect(duplicateProject(track, new AbortController().signal)).rejects.toThrow("missing");
    storage.getAudio.mockResolvedValue(new Blob(["audio"])); storage.saveAudio.mockRejectedValue(new Error("full"));
    await expect(duplicateProject(track, new AbortController().signal)).rejects.toThrow("full");
  });
  it("explicit replacement preserves project identity, validates new bandwidth and invalidates results", () => {
    const measurement = { sampleRate: 8000, frames: 8000, duration: 1, sourceIdentity: { ...identity, sampleRate: 8000, frames: 8000 }, beforeMetrics: { integratedLufs: -20, truePeakDbtp: -3, dynamicRangeDb: 10, correlation: 0.5 }, afterMetrics: { integratedLufs: -20, truePeakDbtp: -3, dynamicRangeDb: 10, correlation: 0.5 } };
    const imported = { canonical: new Blob(), measurement } as Awaited<ReturnType<typeof prepareProjectFile>>;
    const next = replacementProject({ ...track, releaseScore: 100, measurements: { ...measurement.afterMetrics } as NonNullable<typeof track.measurements> }, { name: "new.wav", size: 100 } as File, imported);
    expect(next.id).toBe(track.id); expect(next.title).toBe(track.title); expect(next.sourceIdentity?.sampleRate).toBe(8000); expect(next.releaseScore).toBeUndefined();
    expect(next.advanced.eqBands[4].freqHz).toBe(3760); expect(next.measurementKind).toBe("source"); expect(next.measurements?.integratedLufs).toBe(-20);
  });
});
