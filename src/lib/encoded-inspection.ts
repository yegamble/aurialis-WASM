import type { EncodedInspection } from "./release-policy";
import { assertEncodedWAVLayout, encodedWAVBytes, type EncodedLayout } from "./encoded-layout";

/** Inspect the exact canonical encoder artifact, including integer quantization. */
export async function inspectEncodedWAV(blob: Blob, bits: unknown, source: { sampleRate: number; frames: number }, signal: AbortSignal): Promise<{ sha256: string; encoding: EncodedInspection }> {
  signal.throwIfAborted();
  if (bits !== 16 && bits !== 24 && bits !== 32) throw new Error("Choose 16-bit, 24-bit or 32-bit output.");
  const bytes = bits / 8, align = bytes * 2, layout: EncodedLayout = { ...source, bitDepth: bits }, expectedSize = encodedWAVBytes(layout);
  if (blob.size !== expectedSize) throw new Error("The encoded master has an unexpected source layout or length.");
  const buffer = await blob.arrayBuffer();
  signal.throwIfAborted(); assertEncodedWAVLayout(buffer, layout);
  const view = new DataView(buffer);
  const sample = (offset: number): number => {
    if (bits === 32) return view.getFloat32(offset, true);
    if (bits === 16) return view.getInt16(offset, true) / 32768;
    const raw = view.getUint8(offset) | view.getUint8(offset + 1) << 8 | view.getUint8(offset + 2) << 16;
    return (raw << 8 >> 8) / 8388608;
  };
  const fullScale = bits === 32 ? 1 : bits === 16 ? 32767 / 32768 : 8388607 / 8388608;
  let fullScaleFrames = 0, leadingSilenceFrames = 0, trailingSilenceFrames = 0, heard = false;
  for (let frame = 0; frame < source.frames; frame++) {
    if (frame % 4096 === 0) signal.throwIfAborted();
    if (frame > 0 && frame % 65536 === 0) await new Promise<void>((resolve) => { setTimeout(resolve, 0); });
    const offset = 44 + frame * align;
    const left = sample(offset), right = sample(offset + bytes);
    if (!Number.isFinite(left) || !Number.isFinite(right)) throw new Error("The encoded master contains a non-finite sample.");
    const peak = Math.max(Math.abs(left), Math.abs(right));
    if (peak >= fullScale) fullScaleFrames++;
    if (peak < 0.001) { if (!heard) leadingSilenceFrames++; trailingSilenceFrames++; }
    else { heard = true; trailingSilenceFrames = 0; }
  }
  signal.throwIfAborted();
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  signal.throwIfAborted();
  const sha256 = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, "0")).join("");
  return { sha256, encoding: { sampleRate: source.sampleRate, frames: source.frames, channels: 2, bitDepth: bits, fullScaleFrames, leadingSilenceFrames, trailingSilenceFrames, silenceThresholdDbfs: -60 } };
}
