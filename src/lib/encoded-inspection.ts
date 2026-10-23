import type { EncodedInspection } from "./release-policy";

function label(view: DataView, offset: number): string {
  return String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3));
}

/** Inspect the exact canonical encoder artifact, including integer quantization. */
export async function inspectEncodedWAV(blob: Blob, bits: unknown, source: { sampleRate: number; frames: number }, signal: AbortSignal): Promise<{ sha256: string; encoding: EncodedInspection }> {
  signal.throwIfAborted();
  if (bits !== 16 && bits !== 24 && bits !== 32) throw new Error("Choose 16-bit, 24-bit or 32-bit output.");
  const bytes = bits / 8, align = bytes * 2, expectedSize = 44 + source.frames * align;
  if (!Number.isSafeInteger(source.frames) || source.frames < 1 || source.frames > 16_777_216
    || !Number.isSafeInteger(source.sampleRate) || source.sampleRate < 8000 || source.sampleRate > 192000
    || blob.size !== expectedSize) throw new Error("The encoded master has an unexpected source layout or length.");
  const buffer = await blob.arrayBuffer();
  signal.throwIfAborted();
  const view = new DataView(buffer);
  if (view.byteLength !== expectedSize || label(view, 0) !== "RIFF" || label(view, 8) !== "WAVE"
    || label(view, 12) !== "fmt " || view.getUint32(16, true) !== 16 || view.getUint16(20, true) !== (bits === 32 ? 3 : 1)
    || view.getUint16(22, true) !== 2 || view.getUint32(24, true) !== source.sampleRate
    || view.getUint32(28, true) !== source.sampleRate * align || view.getUint16(32, true) !== align
    || view.getUint16(34, true) !== bits || label(view, 36) !== "data" || view.getUint32(40, true) !== expectedSize - 44
    || view.getUint32(4, true) !== expectedSize - 8) throw new Error("The encoded master is not the expected clean WAV artifact.");
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
