import { MAX_SOURCE_BYTES, MAX_SOURCE_FRAMES } from "./audio-limits";
import { clampAdvancedToSampleRate, createDefaultAdvancedParams } from "./audio-dsp";
import { importAudio, readCanonicalWAV, serverRender, trackMetrics, type StereoPCM } from "./browser-engine";
import { newAudioAssetId } from "./db";
import type { SourceIdentity, Track } from "./types";
/** File-picker filter for sources the Go CDR decoder reconstructs. */
export const SOURCE_ACCEPT = "audio/wav,audio/x-wav,audio/aiff,audio/x-aiff,audio/flac,audio/x-flac,audio/mpeg,.wav,.wave,.aif,.aiff,.aifc,.flac,.mp3";
const SOURCE_EXTENSION = /\.(wav|wave|aif|aiff|aifc|flac|mp3)$/iu;
export const isSourceFileName = (name: string): boolean => SOURCE_EXTENSION.test(name);
function sourceFormat(name: string): string {
  const extension = SOURCE_EXTENSION.exec(name)?.[1]?.toUpperCase() ?? "WAV";
  return extension === "WAVE" ? "WAV" : extension.startsWith("AIF") ? "AIFF" : extension;
}
function canonicalGeometry(header: DataView, bytes: number): { sampleRate: number; frames: number } | null {
  const id = (offset: number) => String.fromCharCode(...Array.from({ length: 4 }, (_, index) => header.getUint8(offset + index)));
  const canonical = header.byteLength === 44 && bytes >= 52 && bytes <= MAX_SOURCE_BYTES &&
    id(0) === "RIFF" && header.getUint32(4, true) + 8 === bytes && id(8) === "WAVE" &&
    id(12) === "fmt " && header.getUint32(16, true) === 16 && header.getUint16(20, true) === 3 &&
    header.getUint16(22, true) === 2 && header.getUint32(24, true) >= 8000 && header.getUint32(24, true) <= 192000 &&
    header.getUint32(28, true) === header.getUint32(24, true) * 8 && header.getUint16(32, true) === 8 &&
    header.getUint16(34, true) === 32 && id(36) === "data" && header.getUint32(40, true) === bytes - 44 && (bytes - 44) % 8 === 0;
  return canonical ? { sampleRate: header.getUint32(24, true), frames: (bytes - 44) / 8 } : null;
}
// Capacity preflight only. The Go server remains the authoritative container validator.
async function wavCapacity(file: File): Promise<{ frames: number; sampleRate: number } | null> {
  const view = new DataView(await file.slice(0, 65536).arrayBuffer());
  const id = (offset: number) => String.fromCharCode(...Array.from({ length: 4 }, (_, index) => view.getUint8(offset + index)));
  if (view.byteLength < 12 || id(0) !== "RIFF" || id(8) !== "WAVE") return null;
  let blockAlign = 0;
  let sampleRate = 0;
  for (let offset = 12; offset + 8 <= view.byteLength;) {
    const length = view.getUint32(offset + 4, true);
    if (id(offset) === "data") return blockAlign > 0 && sampleRate > 0 ? { frames: Math.floor(length / blockAlign), sampleRate } : null;
    if (offset + 8 + length > view.byteLength) return null;
    if (id(offset) === "fmt " && length >= 16) {
      sampleRate = view.getUint32(offset + 12, true);
      blockAlign = view.getUint16(offset + 20, true);
    }
    offset += 8 + length + length % 2;
  }
  return null;
}

export async function prepareProjectFile(file: File, signal: AbortSignal, progress: (stage: string) => void) {
  signal.throwIfAborted();
  if (!isSourceFileName(file.name) || file.size === 0 || file.size > MAX_SOURCE_BYTES) throw new Error("Choose a nonempty WAV, AIFF, FLAC or MP3 file up to 256 MiB. Other formats are not supported.");
  const capacity = await wavCapacity(file);
  signal.throwIfAborted();
  if (capacity && capacity.frames > MAX_SOURCE_FRAMES) throw new Error("This WAV exceeds the 33,554,432 frame limit. Use a shorter source or lower sample rate.");
  progress(`Decoding and reconstructing your ${sourceFormat(file.name)} on this device…`);
  const imported = await importAudio(file, signal);
  signal.throwIfAborted();
  progress("Checking reconstructed audio…");
  // Go CDR is the sample authority. Check its canonical transfer without
  // allocating and immediately discarding three source-length PCM buffers.
  const geometry = canonicalGeometry(new DataView(await imported.canonical.slice(0, 44).arrayBuffer()), imported.canonical.size);
  signal.throwIfAborted();
  if (!geometry || geometry.sampleRate !== imported.measurement.sampleRate || geometry.frames !== imported.measurement.frames) throw new Error("The reconstructed source does not match its measurements.");
  return imported;
}

export function importedTrack(file: File, imported: Awaited<ReturnType<typeof prepareProjectFile>>, id?: string): Track {
  const now = new Date().toISOString();
  const measurement = imported.measurement;
  return {
    id: id ?? newAudioAssetId("track"), title: file.name.replace(/\.[^.]+$/u, "").replace(/[-_]/gu, " "), filename: file.name,
    duration: measurement.duration, size: file.size, format: sourceFormat(file.name), sampleRate: measurement.sampleRate,
    status: "ready", createdAt: now, updatedAt: now, seed: 0, source: "upload", mode: "advanced", genre: "Pop", tone: "Warm", intensity: 50, target: "Streaming",
    metrics: trackMetrics(measurement.afterMetrics), measurements: measurement.afterMetrics, measurementKind: "source",
    advanced: clampAdvancedToSampleRate(createDefaultAdvancedParams(), measurement.sampleRate), profile: "modern_pop_polish",
    ...(measurement.sourceIdentity ? { sourceIdentity: measurement.sourceIdentity } : {}), sourceRevision: 0,
  };
}

export async function readStoredSource(blob: Blob, signal: AbortSignal): Promise<{ blob: Blob; pcm: StereoPCM }> {
  signal.throwIfAborted();
  const header = new DataView(await blob.slice(0, 44).arrayBuffer());
  const canonical = canonicalGeometry(header, blob.size);
  // Imported sources already passed Go reconstruction. Other stored WAV layouts still go through it.
  const clean = canonical ? blob : await serverRender(blob, { bypass: true }, 32, signal);
  const pcm = await readCanonicalWAV(clean);
  for (let index = 0; index < pcm.left.length; index++) {
    if (!Number.isFinite(pcm.left.at(index)) || !Number.isFinite(pcm.right.at(index))) throw new Error("The stored audio contains invalid samples. Import the source again.");
  }
  signal.throwIfAborted();
  return { blob: clean, pcm };
}


const sourceReceipts = new WeakMap<Blob, Promise<SourceIdentity>>();
/** Verify the exact loaded canonical bytes off the audio thread before script binding. */
export async function verifyCanonicalSource(blob: Blob, expected: SourceIdentity, signal: AbortSignal): Promise<SourceIdentity> {
  signal.throwIfAborted();
  if (blob.size < 52 || blob.size > MAX_SOURCE_BYTES) throw new Error("The stored source cannot be verified.");
  let receipt = sourceReceipts.get(blob);
  if (!receipt) {
    receipt = (async () => {
      const bytes = await blob.arrayBuffer();
      const view = new DataView(bytes);
      const id = (offset: number) => String.fromCharCode(...Array.from({ length: 4 }, (_, index) => view.getUint8(offset + index)));
      const rate = view.getUint32(24, true), frames = (bytes.byteLength - 44) / 8;
      if (id(0) !== "RIFF" || view.getUint32(4, true) + 8 !== bytes.byteLength || id(8) !== "WAVE" || id(12) !== "fmt " || view.getUint32(16, true) !== 16 || view.getUint16(20, true) !== 3 || view.getUint16(22, true) !== 2 || !Number.isInteger(frames) || frames < 1 || rate < 8000 || rate > 192000 || view.getUint32(28, true) !== rate * 8 || view.getUint16(32, true) !== 8 || view.getUint16(34, true) !== 32 || id(36) !== "data" || view.getUint32(40, true) !== bytes.byteLength - 44) throw new Error("The stored source is not a canonical verified WAV.");
      // Reuse the final16 header bytes as Go's LE layout prefix. PCM bits stay exact,
      // including float headroom and negative zero; no interleave buffer is allocated.
      view.setUint32(28, rate, true); view.setUint32(32, 2, true); view.setBigUint64(36, BigInt(frames), true);
      const digest = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes, 28));
      const pcmHash = Array.from(new Uint8Array(digest)).map((value) => value.toString(16).padStart(2, "0")).join("");
      return { pcmHash, sampleRate: rate, frames };
    })();
    sourceReceipts.set(blob, receipt);
  }
  const actual = await receipt;
  signal.throwIfAborted();
  if (actual.pcmHash !== expected.pcmHash || actual.sampleRate !== expected.sampleRate || actual.frames !== expected.frames) throw new Error("The stored PCM differs from this script's source. Restore the correct source before applying automation.");
  return actual;
}
