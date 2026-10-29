import { Blob as NativeBlob } from "node:buffer";
import { afterEach, expect, it, vi } from "vitest";
import { assembleAlbumSequence } from "../album-transitions";

afterEach(() => { vi.unstubAllGlobals(); });
function wav(samples: number[], rate = 8000): Blob {
  const data = new ArrayBuffer(44 + samples.length * 8), view = new DataView(data);
  const text = (offset: number, value: string) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
  text(0, "RIFF"); text(8, "WAVEfmt "); text(36, "data");
  view.setUint32(4, data.byteLength - 8, true); view.setUint32(16, 16, true); view.setUint16(20, 3, true); view.setUint16(22, 2, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * 8, true); view.setUint16(32, 8, true); view.setUint16(34, 32, true); view.setUint32(40, samples.length * 8, true);
  samples.forEach((value, i) => { view.setFloat32(44 + i * 8, value, true); view.setFloat32(48 + i * 8, -value, true); });
  return new NativeBlob([data]) as Blob;
}
async function samples(blob: Blob): Promise<number[]> {
  const data = new DataView(await blob.arrayBuffer());
  return Array.from({ length: (data.byteLength - 44) / 8 }, (_, i) => data.getFloat32(44 + i * 8, true));
}
it("copies every gapless sample and inserts exactly the chosen silent frames", async () => {
  vi.stubGlobal("Blob", NativeBlob);
  const a = wav([.25, .5]), b = wav([-.25, -.5]), admit = vi.fn();
  const gapless = await assembleAlbumSequence([a, b], { mode: "gapless", seconds: 0 }, new AbortController().signal, admit);
  expect(await samples(gapless)).toEqual([.25, .5, -.25, -.5]);
  const gap = await assembleAlbumSequence([a, b], { mode: "gap", seconds: 2 / 8000 }, new AbortController().signal, admit);
  expect(await samples(gap)).toEqual([.25, .5, 0, 0, -.25, -.5]);
  expect(new DataView(await gap.arrayBuffer()).getUint32(4, true)).toBe(gap.size - 8);
  expect(admit).toHaveBeenCalled();
});
it("sends only the bounded edges to Go and keeps both untouched bodies", async () => {
  vi.stubGlobal("Blob", NativeBlob);
  const mix = vi.fn(async (a: Blob, b: Blob) => { expect(await samples(a)).toEqual(Array.from({ length: 8 }, (_, i) => i + 8)); expect(await samples(b)).toEqual(Array.from({ length: 8 }, (_, i) => i + 16)); return wav(Array.from({ length: 8 }, () => 0)); });
  const result = await assembleAlbumSequence([wav(Array.from({ length: 16 }, (_, i) => i)), wav(Array.from({ length: 16 }, (_, i) => i + 16))], { mode: "crossfade", seconds: 8 / 8000 }, new AbortController().signal, vi.fn(), mix);
  expect(await samples(result)).toEqual([...Array.from({ length: 8 }, (_, i) => i), ...Array.from({ length: 8 }, () => 0), ...Array.from({ length: 8 }, (_, i) => i + 24)]);
  expect(mix).toHaveBeenCalledOnce();
});
it("refuses mismatched formats, oversized overlap, cancellation and denied admission", async () => {
  vi.stubGlobal("Blob", NativeBlob);
  const signal = new AbortController().signal, a = wav([0, 0, 0, 0]);
  await expect(assembleAlbumSequence([a, wav([0], 44100)], { mode: "gapless", seconds: 0 }, signal, vi.fn())).rejects.toThrow("common delivery rate");
  await expect(assembleAlbumSequence([a, a], { mode: "crossfade", seconds: 1 }, signal, vi.fn())).rejects.toThrow("half the shortest");
  await expect(assembleAlbumSequence([a], { mode: "gapless", seconds: 0 }, signal, () => { throw new Error("capacity"); })).rejects.toThrow("capacity");
  const controller = new AbortController(); controller.abort();
  await expect(assembleAlbumSequence([a], { mode: "gapless", seconds: 0 }, controller.signal, vi.fn())).rejects.toMatchObject({ name: "AbortError" });
});
