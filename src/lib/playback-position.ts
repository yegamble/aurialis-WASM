/** Relative transport steps wrap in Repeat; absolute seeks may still select the end. */
export function relativeSeekPosition(state: { position: number; duration: number; repeat: boolean }, delta: number): number {
  const { duration, position, repeat } = state;
  if (!Number.isFinite(delta) || !Number.isFinite(duration) || duration <= 0) return 0;
  const next = position + delta;
  return repeat ? ((next % duration) + duration) % duration : Math.max(0, Math.min(duration, next));
}
