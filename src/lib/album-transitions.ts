import { mixAlbumEdges } from "./browser-jobs";

export type AlbumTransition = { mode: "gapless" | "gap" | "crossfade"; seconds: number };
type Wave = { blob: Blob; rate: number; bits: 16 | 24 | 32; code: number; align: number; frames: number; header: ArrayBuffer };
type Mixer = typeof mixAlbumEdges;
const MAX_RIFF_DATA = 0xffffffff - 36;
const MAX_EDGE_SECONDS = 5;

async function wave(blob: Blob): Promise<Wave> {
  const header = await blob.slice(0, 44).arrayBuffer();
  if (header.byteLength !== 44) throw new Error("An album master has an incomplete WAV header. Render the album again.");
  const view = new DataView(header), text = (offset: number, length: number) => String.fromCharCode(...new Uint8Array(header, offset, length));
  const bits = view.getUint16(34, true), code = view.getUint16(20, true), rate = view.getUint32(24, true), align = view.getUint16(32, true);
  if (text(0, 4) !== "RIFF" || text(8, 8) !== "WAVEfmt " || text(36, 4) !== "data" || view.getUint32(16, true) !== 16
    || view.getUint16(22, true) !== 2 || ![16, 24, 32].includes(bits) || code !== (bits === 32 ? 3 : 1)
    || rate < 8000 || rate > 192000 || align !== bits / 4 || view.getUint32(28, true) !== rate * align
    || view.getUint32(4, true) + 8 !== blob.size || view.getUint32(40, true) + 44 !== blob.size || (blob.size - 44) % align !== 0)
    throw new Error("An album master is not a canonical stereo WAV. Render the album again.");
  return { blob, rate, bits: bits as 16 | 24 | 32, code, align, frames: (blob.size - 44) / align, header };
}

function header(wav: Wave, bytes: number): ArrayBuffer {
  const result = wav.header.slice(0), view = new DataView(result);
  view.setUint32(4, bytes + 36, true); view.setUint32(40, bytes, true);
  return result;
}
function edge(wav: Wave, first: number, frames: number): Blob {
  return new Blob([header(wav, frames * wav.align), wav.blob.slice(44 + first * wav.align, 44 + (first + frames) * wav.align)], { type: "audio/wav" });
}

/** The bodies are byte-exact slices; Go alone mixes each bounded overlap.
 * Charge all input, output and possible decoded playback PCM before assembly. */
export async function assembleAlbumSequence(blobs: readonly Blob[], transition: AlbumTransition, signal: AbortSignal,
  admit: (bytes: number) => void, mix: Mixer = mixAlbumEdges): Promise<Blob> {
  signal.throwIfAborted();
  if (!blobs.length || blobs.length > 512) throw new Error("Choose between one and 512 album masters.");
  if (!["gapless", "gap", "crossfade"].includes(transition.mode) || !Number.isFinite(transition.seconds) || transition.seconds < 0 || transition.seconds > MAX_EDGE_SECONDS)
    throw new Error("Choose a transition between zero and five seconds.");
  const waves: Wave[] = [];
  for (const blob of blobs) { waves.push(await wave(blob)); signal.throwIfAborted(); }
  const first = waves[0];
  if (!first) throw new Error("The album sequence is empty.");
  if (waves.some((item) => item.rate !== first.rate || item.bits !== first.bits || item.code !== first.code))
    throw new Error("Continuous playback needs one sample rate and bit depth. Choose a common delivery rate and render the album again.");
  const frames = transition.mode === "gapless" ? 0 : Math.round(transition.seconds * first.rate);
  if (transition.mode === "crossfade" && (frames < 8 || waves.some((item) => frames * 2 > item.frames)))
    throw new Error("Each crossfade must be at least eight frames and no longer than half the shortest master.");
  const totalFrames = waves.reduce((sum, item) => sum + item.frames, 0)
    + (waves.length - 1) * frames * (transition.mode === "crossfade" ? -1 : 1);
  const bytes = totalFrames * first.align;
  if (!Number.isSafeInteger(bytes) || bytes > MAX_RIFF_DATA) throw new Error("The continuous album exceeds the WAV size limit. Download its individual masters instead.");
  const inputs = blobs.reduce((sum, blob) => sum + blob.size, 0);
  admit(inputs + bytes + 44 + totalFrames * 8 + MAX_EDGE_SECONDS * first.rate * 32);
  const parts: BlobPart[] = [header(first, bytes)];
  for (const [index, item] of waves.entries()) {
    signal.throwIfAborted();
    const skip = transition.mode === "crossfade" && index > 0 ? frames : 0;
    const trim = transition.mode === "crossfade" && index < waves.length - 1 ? frames : 0;
    parts.push(item.blob.slice(44 + skip * item.align, item.blob.size - trim * item.align));
    const next = waves[index + 1];
    if (!next) continue;
    if (transition.mode === "gap" && frames) parts.push(new Blob([new Uint8Array(frames * first.align)]));
    if (transition.mode === "crossfade") {
      const overlap = await mix(edge(item, item.frames - frames, frames), edge(next, 0, frames), first.bits, signal);
      signal.throwIfAborted();
      const mixed = await wave(overlap);
      if (mixed.frames !== frames || mixed.rate !== first.rate || mixed.bits !== first.bits) throw new Error("The crossfade returned an incompatible WAV.");
      parts.push(overlap.slice(44));
    }
  }
  signal.throwIfAborted();
  return new Blob(parts, { type: "audio/wav" });
}
