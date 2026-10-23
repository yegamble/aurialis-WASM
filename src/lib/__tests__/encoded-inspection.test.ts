import { Blob as NativeBlob } from "node:buffer";
import { createHash, webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inspectEncodedWAV } from "../encoded-inspection";
import type { OutputBits } from "../release-policy";

function fixture(bits: OutputBits, samples: number[]): ArrayBuffer {
  const stride = bits / 8, data = new ArrayBuffer(44 + samples.length * 2 * stride), view = new DataView(data);
  function text(offset: number, value: string) { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); }
  text(0, "RIFF"); view.setUint32(4, data.byteLength - 8, true); text(8, "WAVE"); text(12, "fmt "); view.setUint32(16, 16, true);
  view.setUint16(20, bits === 32 ? 3 : 1, true); view.setUint16(22, 2, true); view.setUint32(24, 48000, true);
  view.setUint32(28, 48000 * 2 * stride, true); view.setUint16(32, 2 * stride, true); view.setUint16(34, bits, true); text(36, "data"); view.setUint32(40, data.byteLength - 44, true);
  for (let i = 0; i < samples.length; i++) for (let channel = 0; channel < 2; channel++) {
    const offset = 44 + (i * 2 + channel) * stride, value = samples.at(i) ?? 0;
    if (bits === 32) view.setFloat32(offset, value, true);
    else if (bits === 16) view.setInt16(offset, Math.round(value * 32767), true);
    else { const integer = Math.round(value * 8388607); view.setUint8(offset, integer & 255); view.setUint8(offset + 1, integer >> 8 & 255); view.setUint8(offset + 2, integer >> 16 & 255); }
  }
  return data;
}
beforeEach(() => { vi.stubGlobal("Blob", NativeBlob); vi.stubGlobal("crypto", webcrypto); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe("exact encoded output inspection", () => {
  it("hashes actual bytes and counts quantized full-scale/quiet frames at all three depths", async () => {
    for (const bits of [16, 24, 32] as const) {
      const data = fixture(bits, [0, 0.0001, -1, 0.25, 1, 0, 0]);
      const result = await inspectEncodedWAV(new Blob([data]), bits, { sampleRate: 48000, frames: 7 }, new AbortController().signal);
      expect(result.sha256).toBe(createHash("sha256").update(new Uint8Array(data)).digest("hex"));
      expect(result.encoding).toMatchObject({ bitDepth: bits, frames: 7, fullScaleFrames: 2, leadingSilenceFrames: 2, trailingSilenceFrames: 2 });
    }
  });
  it("copies only verified layout fields instead of propagating an original source identity into encoded metadata", async () => {
    const original = { sampleRate: 48000, frames: 2, pcmHash: "a".repeat(64) };
    const result = await inspectEncodedWAV(new Blob([fixture(24, [0.25, -0.25])]), 24, original, new AbortController().signal);
    expect(result.encoding).not.toHaveProperty("pcmHash");
    expect(Object.keys(result.encoding).sort()).toEqual(["bitDepth", "channels", "frames", "fullScaleFrames", "leadingSilenceFrames", "sampleRate", "silenceThresholdDbfs", "trailingSilenceFrames"]);
  });
  it("preserves finite float headroom and distinguishes an entirely quiet file", async () => {
    const result = await inspectEncodedWAV(new Blob([fixture(32, [0, -1.5, 1.25, 0])]), 32, { sampleRate: 48000, frames: 4 }, new AbortController().signal);
    expect(result.encoding.fullScaleFrames).toBe(2);
    const quiet = await inspectEncodedWAV(new Blob([fixture(16, [0, 0, 0])]), 16, { sampleRate: 48000, frames: 3 }, new AbortController().signal);
    expect(quiet.encoding).toMatchObject({ leadingSilenceFrames: 3, trailingSilenceFrames: 3, fullScaleFrames: 0 });
  });
  it("rejects changed encoding, forged chunk lengths, trailers and non-finite samples", async () => {
    const metadata = { sampleRate: 48000, frames: 2 }, signal = new AbortController().signal;
    await expect(inspectEncodedWAV(new Blob([fixture(16, [0, 0])]), 24, metadata, signal)).rejects.toThrow(/layout|length/u);
    const forged = fixture(32, [0, 0]); new DataView(forged).setUint32(40, 0, true);
    await expect(inspectEncodedWAV(new Blob([forged]), 32, metadata, signal)).rejects.toThrow(/clean WAV/u);
    await expect(inspectEncodedWAV(new Blob([fixture(32, [0, 0]), "PK"]), 32, metadata, signal)).rejects.toThrow(/length/u);
    await expect(inspectEncodedWAV(new Blob([fixture(32, [NaN, 0])]), 32, metadata, signal)).rejects.toThrow(/non-finite/u);
  });
  it("honors cancellation before allocation, during a long scan and after hashing", async () => {
    const controller = new AbortController(); controller.abort();
    await expect(inspectEncodedWAV(new Blob([fixture(16, [0])]), 16, { sampleRate: 48000, frames: 1 }, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    const scanning = new AbortController(); const data = fixture(16, Array.from({ length: 131073 }, () => 0));
    const pending = inspectEncodedWAV(new Blob([data]), 16, { sampleRate: 48000, frames: 131073 }, scanning.signal);
    setTimeout(() => { scanning.abort(); }, 0);
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    const hashing = new AbortController();
    vi.spyOn(webcrypto.subtle, "digest").mockImplementation(() => { hashing.abort(); return Promise.resolve(new ArrayBuffer(32)); });
    await expect(inspectEncodedWAV(new Blob([fixture(16, [0])]), 16, { sampleRate: 48000, frames: 1 }, hashing.signal)).rejects.toMatchObject({ name: "AbortError" });
  });
});
