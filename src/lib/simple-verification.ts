import { engineParams, measureAudio } from "./browser-engine";
import { verifyCanonicalSource } from "./project-import";
import type { SimpleChange } from "./simple-directions";
import type { Track } from "./types";

export async function verifyElevatedChange(source: Blob, track: Track, change: SimpleChange, signal: AbortSignal): Promise<{ lufs: number; peak: number }> {
  if (track.sourceIdentity) await verifyCanonicalSource(source, track.sourceIdentity, signal);
  const measured = await measureAudio(source, engineParams(change.advanced), signal);
  signal.throwIfAborted();
  if (!measured.sourceIdentity || measured.sampleRate !== track.sampleRate
    || Math.abs(measured.frames / measured.sampleRate - track.duration) > 0.001)
    throw new Error("Restore the matching source before checking Elevated.");
  await verifyCanonicalSource(source, measured.sourceIdentity, signal);
  if (track.sourceIdentity && (track.sourceIdentity.pcmHash !== measured.sourceIdentity.pcmHash
    || track.sourceIdentity.frames !== measured.frames)) throw new Error("The measured source changed. Restore the matching source.");
  const { afterMetrics } = measured;
  if (afterMetrics.samplePeakDbfs > change.advanced.limiter.ceiling + 0.02
    || afterMetrics.truePeakDbtp > change.advanced.limiter.ceiling + 0.05)
    throw new Error("Elevated exceeds the measured peak ceiling. Reduce Input gain in Advanced and try again, or choose Precise or Organic.");
  if (afterMetrics.integratedLufs > change.advanced.limiter.targetLufs + 0.5)
    throw new Error("Elevated exceeds the requested loudness. Reduce Input gain in Advanced and try again, or choose a different output target.");
  return { lufs: afterMetrics.integratedLufs, peak: afterMetrics.truePeakDbtp };
}
