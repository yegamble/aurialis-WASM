import { measureAudio } from "./browser-engine";
import { EXPORT_PEAK_TOLERANCE_DB, exportParams } from "./engine-params";
import { verifyCanonicalSource } from "./project-import";
import type { SimpleChange } from "./simple-directions";
import type { Track } from "./types";

export async function verifyElevatedChange(source: Blob, track: Track, change: SimpleChange, signal: AbortSignal): Promise<{ lufs: number; peak: number }> {
  const identity = track.sourceIdentity;
  if (!identity) throw new Error("Restore the matching source in Library before checking Elevated.");
  await verifyCanonicalSource(source, identity, signal);
  // Measure what export delivers (algorithm 2 true-peak limiter), not the live preview limiter.
  const measured = await measureAudio(source, exportParams(change.advanced), signal);
  signal.throwIfAborted();
  if (measured.sampleRate !== identity.sampleRate || measured.frames !== identity.frames
    || measured.sampleRate !== track.sampleRate || Math.abs(measured.duration - track.duration) > 0.001)
    throw new Error("The measured source changed. Restore the matching source.");
  await verifyCanonicalSource(source, identity, signal);
  const { afterMetrics } = measured;
  if (afterMetrics.samplePeakDbfs > change.advanced.limiter.ceiling + 0.02
    || afterMetrics.truePeakDbtp > change.advanced.limiter.ceiling + EXPORT_PEAK_TOLERANCE_DB)
    throw new Error("Elevated exceeds the measured peak ceiling. Reduce Input gain in Advanced and try again, or choose Precise or Organic.");
  if (afterMetrics.integratedLufs > change.advanced.limiter.targetLufs + 0.5)
    throw new Error("Elevated exceeds the requested loudness. Reduce Input gain in Advanced and try again, or choose a different output target.");
  return { lufs: afterMetrics.integratedLufs, peak: afterMetrics.truePeakDbtp };
}
