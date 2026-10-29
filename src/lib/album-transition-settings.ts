import type { AlbumTransition } from "./album-transitions";

export const DEFAULT_ALBUM_TRANSITION: AlbumTransition = { mode: "gapless", seconds: 0 };

/** Old albums keep exact track boundaries; malformed persisted choices cannot reach DSP. */
export function readAlbumTransition(value: unknown): AlbumTransition {
  if (!value || typeof value !== "object") return { ...DEFAULT_ALBUM_TRANSITION };
  const item = value as Record<string, unknown>;
  const mode = item.mode === "gap" || item.mode === "crossfade" ? item.mode : "gapless";
  const seconds = typeof item.seconds === "number" && Number.isFinite(item.seconds) ? Math.max(0, Math.min(5, item.seconds)) : 0;
  return { mode, seconds: mode === "gapless" ? 0 : seconds };
}
