/** Relative transport steps wrap in Repeat; absolute seeks may still select the end. */
export function relativeSeekPosition(state: { position: number; duration: number; repeat: boolean }, delta: number): number {
  const { duration, position, repeat } = state;
  if (!Number.isFinite(delta) || !Number.isFinite(duration) || duration <= 0) return 0;
  const next = position + delta;
  if (!repeat) return Math.max(0, Math.min(duration, next));
  const wrapped = ((next % duration) + duration) % duration;
  const precision = Number.EPSILON * Math.max(1, Math.abs(next), duration) * 8;
  return wrapped < precision || duration - wrapped < precision ? 0 : wrapped;
}
