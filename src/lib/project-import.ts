import { clampAdvancedToSampleRate, createDefaultAdvancedParams } from "./audio-dsp";
import { importAudio, readCanonicalWAV, serverRender, trackMetrics, type StereoPCM } from "./browser-engine";
import { newAudioAssetId } from "./db";
import type { Track } from "./types";
const MAX_SOURCE_FRAMES = 16 * 1024 * 1024;
const MAX_SOURCE_BYTES = MAX_SOURCE_FRAMES * 8 + 44;
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
  if (!/\.wav$/iu.test(file.name) || file.size === 0 || file.size > MAX_SOURCE_BYTES) throw new Error("Choose a nonempty PCM WAV file up to 128 MiB. Other codecs are not supported.");
  const capacity = await wavCapacity(file);
  signal.throwIfAborted();
  if (capacity && capacity.frames > MAX_SOURCE_FRAMES) throw new Error("This WAV exceeds the 16,777,216 frame limit. Use a shorter source or lower sample rate.");
  progress("Validating and reconstructing your WAV on the local Go server…");
  const imported = await importAudio(file, signal);
  signal.throwIfAborted();
  progress("Preparing your waveform…");
  const pcm = await readCanonicalWAV(imported.canonical);
  signal.throwIfAborted();
  if (pcm.sampleRate !== imported.measurement.sampleRate || pcm.left.length !== imported.measurement.frames) throw new Error("The reconstructed source does not match its measurements.");
  return imported;
}

export function importedTrack(file: File, imported: Awaited<ReturnType<typeof prepareProjectFile>>, id?: string): Track {
  const now = new Date().toISOString();
  const measurement = imported.measurement;
  return {
    id: id ?? newAudioAssetId("track"), title: file.name.replace(/\.[^.]+$/u, "").replace(/[-_]/gu, " "), filename: file.name,
    duration: measurement.duration, size: file.size, format: "WAV", sampleRate: measurement.sampleRate,
    status: "ready", createdAt: now, updatedAt: now, seed: 0, source: "upload", mode: "advanced", genre: "Pop", tone: "Warm", intensity: 50, target: "Streaming",
    metrics: trackMetrics(measurement.afterMetrics), measurements: measurement.afterMetrics, measurementKind: "source",
    advanced: clampAdvancedToSampleRate(createDefaultAdvancedParams(), measurement.sampleRate), profile: "modern_pop_polish",
    ...(measurement.sourceIdentity ? { sourceIdentity: measurement.sourceIdentity } : {}), sourceRevision: 0,
  };
}

export async function readStoredSource(blob: Blob, signal: AbortSignal): Promise<{ blob: Blob; pcm: StereoPCM }> {
  signal.throwIfAborted();
  const header = new DataView(await blob.slice(0, 44).arrayBuffer());
  const id = (offset: number) => String.fromCharCode(...Array.from({ length: 4 }, (_, index) => header.getUint8(offset + index)));
  const canonical = header.byteLength === 44 && blob.size >= 52 && blob.size <= 44 + MAX_SOURCE_FRAMES * 8 &&
    id(0) === "RIFF" && header.getUint32(4, true) + 8 === blob.size && id(8) === "WAVE" &&
    id(12) === "fmt " && header.getUint32(16, true) === 16 && header.getUint16(20, true) === 3 &&
    header.getUint16(22, true) === 2 && header.getUint32(24, true) >= 8000 && header.getUint32(24, true) <= 192000 &&
    header.getUint32(28, true) === header.getUint32(24, true) * 8 && header.getUint16(32, true) === 8 &&
    header.getUint16(34, true) === 32 && id(36) === "data" && header.getUint32(40, true) === blob.size - 44 && (blob.size - 44) % 8 === 0;
  // Imported sources already passed Go reconstruction. Other stored WAV layouts still go through it.
  const clean = canonical ? blob : await serverRender(blob, { bypass: true }, 32, signal);
  const pcm = await readCanonicalWAV(clean);
  for (let index = 0; index < pcm.left.length; index++) {
    if (!Number.isFinite(pcm.left.at(index)) || !Number.isFinite(pcm.right.at(index))) throw new Error("The stored audio contains invalid samples. Import the source again.");
  }
  signal.throwIfAborted();
  return { blob: clean, pcm };
}

