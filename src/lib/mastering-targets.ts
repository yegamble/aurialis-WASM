import { mapSimpleToDSP } from "./audio-dsp";
import type { LimiterParams } from "./types";

// Read target recommendations from the same preset model that applies them.
export const masteringTargets = ["Streaming", "Loud", "Dynamic", "Podcast"].map((name) => {
  const { targetLufs, ceiling } = mapSimpleToDSP("Pop", "Clean", 50, name).limiter;
  return { name, targetLufs, ceiling };
});

export function currentMasteringTarget(limiter: LimiterParams, lastNamed: string): string {
  const matches = masteringTargets.filter((target) => target.targetLufs === limiter.targetLufs && target.ceiling === limiter.ceiling);
  return (matches.find((target) => target.name === lastNamed) ?? matches[0])?.name ?? "custom";
}
