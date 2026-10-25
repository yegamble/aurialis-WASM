import { Blob as NativeBlob, File as NativeFile } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { importAudio, readCanonicalWAV } from "../browser-engine";
import { importedTrack, isSourceFileName, prepareProjectFile } from "../project-import";

vi.mock("../browser-engine", () => ({ importAudio: vi.fn(), readCanonicalWAV: vi.fn(), serverRender: vi.fn(), trackMetrics: vi.fn() }));
vi.mock("../db", () => ({ newAudioAssetId: () => "track-test" }));
function canonical(change?: (view: DataView) => void): Blob {
  const bytes = new Uint8Array(52), view = new DataView(bytes.buffer);
  for (const [offset, text] of [[0, "RIFF"], [8, "WAVE"], [12, "fmt "], [36, "data"]] as const) {
    for (let index = 0; index < text.length; index++) view.setUint8(offset + index, text.charCodeAt(index));
  }
  view.setUint32(4, 44, true); view.setUint32(16, 16, true); view.setUint16(20, 3, true); view.setUint16(22, 2, true);
  view.setUint32(24, 48000, true); view.setUint32(28, 384000, true); view.setUint16(32, 8, true); view.setUint16(34, 32, true);
  view.setUint32(40, 8, true); view.setFloat32(44, 0.25, true); view.setFloat32(48, -0.125, true);
  change?.(view);
  return new Blob([bytes], { type: "audio/wav" });
}
const metrics = { integratedLufs: -20, shortTermLufs: -20, truePeakDbtp: -6, samplePeakDbfs: -6, dynamicRangeDb: 14, correlation: 0.8, lowBassCorrelation: 1, dcLeftDbfs: -100, dcRightDbfs: -100, clippingSamples: 0, gainReductionDb: 0 };
function result(blob: Blob) { return { canonical: blob, measurement: { sampleRate: 48000, frames: 1, duration: 1 / 48000, beforeMetrics: metrics, afterMetrics: metrics } }; }
let file: File;
beforeEach(() => { vi.stubGlobal("Blob", NativeBlob); vi.stubGlobal("File", NativeFile); file = new File([canonical()], "source.wav"); });
afterEach(() => { vi.resetAllMocks(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe("canonical import transfer validation", () => {
  it("checks only the reconstructed44-byte header without copying and discarding full PCM", async () => {
    const blob = canonical(), imported = result(blob);
    const wholeRead = vi.spyOn(blob, "arrayBuffer").mockRejectedValue(new Error("A full validation copy is forbidden"));
    const slice = vi.spyOn(blob, "slice"); vi.mocked(importAudio).mockResolvedValue(imported);
    expect(await prepareProjectFile(file, new AbortController().signal, () => undefined)).toBe(imported);
    expect(slice).toHaveBeenCalledExactlyOnceWith(0, 44); expect(wholeRead).not.toHaveBeenCalled(); expect(readCanonicalWAV).not.toHaveBeenCalled();
  });
  it.each([
    ["magic", (view: DataView) => { view.setUint8(0, 0); }],
    ["container size", (view: DataView) => { view.setUint32(4, 52, true); }],
    ["wave identifier", (view: DataView) => { view.setUint8(8, 0); }],
    ["format identifier", (view: DataView) => { view.setUint8(12, 0); }],
    ["format length", (view: DataView) => { view.setUint32(16, 18, true); }],
    ["integer format", (view: DataView) => { view.setUint16(20, 1, true); }],
    ["mono channels", (view: DataView) => { view.setUint16(22, 1, true); }],
    ["sample rate", (view: DataView) => { view.setUint32(24, 44100, true); view.setUint32(28, 352800, true); }],
    ["byte rate", (view: DataView) => { view.setUint32(28, 1, true); }],
    ["block alignment", (view: DataView) => { view.setUint16(32, 4, true); }],
    ["bit depth", (view: DataView) => { view.setUint16(34, 24, true); }],
    ["data identifier", (view: DataView) => { view.setUint8(36, 0); }],
    ["data length", (view: DataView) => { view.setUint32(40, 16, true); }],
  ] as const)("rejects mismatched %s before project publication", async (_label, change) => {
    vi.mocked(importAudio).mockResolvedValue(result(canonical(change)));
    await expect(prepareProjectFile(file, new AbortController().signal, () => undefined)).rejects.toThrow("does not match its measurements");
    expect(readCanonicalWAV).not.toHaveBeenCalled();
  });
  it("rejects a truncated transfer, trailing bytes and a mismatched frame receipt", async () => {
    const original = canonical();
    for (const blob of [original.slice(0, 20), new Blob([original, "trailer"])]) {
      vi.mocked(importAudio).mockResolvedValue(result(blob));
      await expect(prepareProjectFile(file, new AbortController().signal, () => undefined)).rejects.toThrow("does not match its measurements");
    }
    vi.mocked(importAudio).mockResolvedValue({ ...result(original), measurement: { ...result(original).measurement, frames: 2 } });
    await expect(prepareProjectFile(file, new AbortController().signal, () => undefined)).rejects.toThrow("does not match its measurements");
  });
  it("honors cancellation before interpreting the returned header", async () => {
    const controller = new AbortController();
    vi.mocked(importAudio).mockImplementation(() => { controller.abort(); return Promise.resolve(result(canonical())); });
    await expect(prepareProjectFile(file, controller.signal, () => undefined)).rejects.toMatchObject({ name: "AbortError" });
    expect(readCanonicalWAV).not.toHaveBeenCalled();
  });
});
describe("compressed source admission", () => {
  it("admits WAV, AIFF, FLAC and MP3 names and labels the project with the source format", async () => {
    expect(["a.wav", "b.WAVE", "c.flac", "d.MP3", "e.aif", "f.AIFF", "g.aifc"].map(isSourceFileName)).toEqual([true, true, true, true, true, true, true]);
    for (const [name, format] of [["song.flac", "FLAC"], ["song.mp3", "MP3"], ["song.wave", "WAV"], ["song.aif", "AIFF"], ["song.aifc", "AIFF"]] as const) {
      const source = new File([new Uint8Array(64)], name), imported = result(canonical());
      const progress = vi.fn<(stage: string) => void>();
      vi.mocked(importAudio).mockResolvedValue(imported);
      await prepareProjectFile(source, new AbortController().signal, progress);
      expect(progress).toHaveBeenCalledWith(`Decoding and reconstructing your ${format} on this device…`);
      expect(importedTrack(source, imported).format).toBe(format);
    }
  });
  it("rejects other codecs before any decode", async () => {
    for (const name of ["song.ogg", "song.m4a", "song.caf", "song.flac.exe"]) {
      await expect(prepareProjectFile(new File([new Uint8Array(64)], name), new AbortController().signal, () => undefined)).rejects.toThrow("WAV, AIFF, FLAC or MP3");
    }
    expect(importAudio).not.toHaveBeenCalled();
  });
});
