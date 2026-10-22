type PlaybackHandoff = { fromTrackId: string; trackId: string; playing: boolean; volume: number; issuedAt: number };
const STORAGE_KEY = "aurialis-next-playback-v1";
const MAX_AGE_MS = 5000;
let pending: PlaybackHandoff | null = null;

function valid(value: unknown): value is PlaybackHandoff {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  const age = typeof item.issuedAt === "number" ? Date.now() - item.issuedAt : -1;
  return typeof item.fromTrackId === "string" && item.fromTrackId.length > 0 && item.fromTrackId.length <= 256 &&
    typeof item.trackId === "string" && item.trackId.length > 0 && item.trackId.length <= 256 && item.trackId !== item.fromTrackId &&
    typeof item.playing === "boolean" && typeof item.volume === "number" && Number.isFinite(item.volume) && item.volume >= 0 && item.volume <= 1 &&
    age >= 0 && age <= MAX_AGE_MS;
}

export function clearNextPlaybackHandoff() {
  pending = null;
  try { globalThis.sessionStorage.removeItem(STORAGE_KEY); } catch { /* Storage can be blocked; same-document navigation still uses memory. */ }
}
function read(): PlaybackHandoff | null {
  let candidate: unknown = pending;
  if (candidate === null) {
    if (typeof performance.getEntriesByType === "function" && performance.getEntriesByType("navigation").some((entry) => "type" in entry && entry.type === "reload")) {
      clearNextPlaybackHandoff();
      return null;
    }
    try { const raw = globalThis.sessionStorage.getItem(STORAGE_KEY); candidate = raw ? JSON.parse(raw) as unknown : null; }
    catch { clearNextPlaybackHandoff(); return null; }
  }
  if (valid(candidate)) return candidate;
  clearNextPlaybackHandoff();
  return null;
}

/** Persist only the explicit Next action, never normal playback or an ordinary reload. */
export function stageNextPlaybackHandoff(handoff: Omit<PlaybackHandoff, "issuedAt">) {
  const candidate = { ...handoff, issuedAt: Date.now() };
  clearNextPlaybackHandoff();
  if (!valid(candidate)) return;
  pending = candidate;
  try { globalThis.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(candidate)); } catch { /* Memory remains available for client navigation. */ }
}

/** Reading a different target cannot activate or consume the intended next project. */
export function takeNextPlaybackHandoff(trackId: string): Pick<PlaybackHandoff, "playing" | "volume"> | null {
  const candidate = read();
  if (candidate?.trackId !== trackId) return null;
  clearNextPlaybackHandoff();
  return { playing: candidate.playing, volume: candidate.volume };
}

export function reconcileNextPlaybackHandoff(route: string, trackId: string) {
  const candidate = read();
  if (!candidate) return;
  // The outgoing document may remain mounted while router.push starts navigation.
  const outgoing = candidate === pending && candidate.fromTrackId === trackId;
  if (route !== "master" || (candidate.trackId !== trackId && !outgoing)) clearNextPlaybackHandoff();
}
