import { relativeSeekPosition } from "./playback-position";
import type { LivePlaybackState } from "./live-playback";

// cspell:words contenteditable seekto seekbackward seekforward previoustrack nexttrack

type PlaybackActions = {
  getState: () => LivePlaybackState;
  available: () => boolean;
  play: () => Promise<void>;
  pause: () => void;
  seek: (seconds: number) => void;
  restart: () => void;
  forward: () => void;
  onError: (error: unknown) => void;
};

const owners = new WeakMap<MediaSession, symbol>();

/** Connect the current player to browser/media keys without retaining a previous track. */
export function bindPlaybackControls(title: string, actions: PlaybackActions) {
  const session = "mediaSession" in navigator ? navigator.mediaSession : undefined;
  const token = Symbol("current player");
  let active = true;
  let lastPositionUpdate = -Infinity;
  let lastPlaybackState: MediaSessionPlaybackState | undefined;
  const registered: MediaSessionAction[] = [];
  const ownsSession = () => active && session !== undefined && owners.get(session) === token;

  function update(state: LivePlaybackState, force = false) {
    if (!ownsSession() || !session) return;
    const next = state.playing ? "playing" : "paused";
    if (lastPlaybackState !== next) {
      session.playbackState = next;
      lastPlaybackState = next;
      force = true;
    }
    const now = performance.now();
    if ((!force && now - lastPositionUpdate < 1000) || !Number.isFinite(state.duration) || state.duration <= 0) return;
    try {
      session.setPositionState({ duration: state.duration, playbackRate: 1, position: Math.max(0, Math.min(state.duration, state.position)) });
      lastPositionUpdate = now;
    } catch { /* Older browsers may expose Media Session without position-state support. */ }
  }
  function seek(seconds: number) {
    if (!actions.available()) return;
    const state = actions.getState();
    if (state.loading) return;
    actions.seek(Math.max(0, Math.min(state.duration, seconds)));
    update(actions.getState(), true);
  }
  function play() { if (actions.available()) void actions.play().catch(actions.onError); }
  function pause() { if (actions.available()) { actions.pause(); update(actions.getState(), true); } }
  function invoke(action: () => void) { if (actions.available() && !actions.getState().loading) { action(); update(actions.getState(), true); } }

  function onKeyDown(event: KeyboardEvent) {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || !active || (session && !ownsSession()) || !actions.available()) return;
    const target = event.target;
    if (target instanceof HTMLElement && (target.isContentEditable || target.closest("input, textarea, select, button, a, [tabindex]:not([tabindex='-1']), [contenteditable]:not([contenteditable='false'])"))) return;
    if (event.key === " " || event.code === "Space") {
      event.preventDefault();
      if (event.repeat) return;
      const state = actions.getState();
      if (state.playing || state.loading) pause(); else play();
    } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      if (actions.getState().loading) return;
      event.preventDefault();
      const amount = event.altKey ? 0.1 : event.shiftKey ? 10 : 1;
      seek(relativeSeekPosition(actions.getState(), event.key === "ArrowLeft" ? -amount : amount));
    }
  }

  window.addEventListener("keydown", onKeyDown);
  if (session) {
    owners.set(session, token);
    if (typeof MediaMetadata === "function") session.metadata = new MediaMetadata({ title, artist: "Aurialis", album: "Local mastering workspace" });
    const handlers: [MediaSessionAction, MediaSessionActionHandler][] = [
      ["play", play], ["pause", pause],
      ["stop", () => { pause(); seek(0); }],
      ["seekto", (details) => { if (details.seekTime !== undefined) seek(details.seekTime); }],
      ["seekbackward", (details) => { seek(relativeSeekPosition(actions.getState(), -(details.seekOffset ?? 10))); }],
      ["seekforward", (details) => { seek(relativeSeekPosition(actions.getState(), details.seekOffset ?? 10)); }],
      ["previoustrack", () => { invoke(actions.restart); }], ["nexttrack", () => { invoke(actions.forward); }],
    ];
    for (const [action, handler] of handlers) {
      try { session.setActionHandler(action, (details) => { if (ownsSession()) handler(details); }); registered.push(action); }
      catch { /* Unsupported actions leave the other available media controls working. */ }
    }
    update(actions.getState(), true);
  }
  return {
    update,
    dispose() {
      window.removeEventListener("keydown", onKeyDown);
      if (ownsSession() && session) {
        for (const action of registered) { try { session.setActionHandler(action, null); } catch { /* Browser capability may have changed. */ } }
        session.playbackState = "none";
        session.metadata = null;
        try { session.setPositionState(); } catch { /* Optional browser capability. */ }
        owners.delete(session);
      }
      active = false;
    },
  };
}
