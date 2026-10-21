"use client";
import type { LivePlaybackState } from "@/lib/live-playback";
import { Icon } from "./Icon";
import { formatTime } from "./Primitives";

type RealTransportProps = {
  state: LivePlaybackState | null;
  sourceReady: boolean;
  onPlay: () => Promise<void>;
  onPause: () => void;
  onOriginal: (original: boolean) => void;
  onVolume: (volume: number) => void;
};

/** A/B shares one live audio clock: A is processed and B is the original source. */
export function RealTransport({ state, sourceReady, onPlay, onPause, onOriginal, onVolume }: RealTransportProps) {
  const playing = state?.playing ?? false;
  const loading = state?.loading ?? false;
  const original = state?.original ?? false;
  const position = state?.position ?? 0;
  const duration = state?.duration ?? 0;
  return (
    <div className="transport" aria-busy={loading}
      data-position={position} data-playing={playing} data-ready={state?.ready ?? false}
      data-parameter-version={state?.parameterVersion ?? 0} data-applied-version={state?.appliedVersion ?? 0}>
      <div className="ab-toggle" role="group" aria-label="Processed and original audio">
        <button type="button" disabled={!sourceReady} className={sourceReady && !original ? "is-active" : ""} aria-pressed={sourceReady && !original}
          onClick={() => { onOriginal(false); }}>
          A <span>Processed</span>
        </button>
        <button type="button" disabled={!sourceReady} className={sourceReady && original ? "is-active" : ""} aria-pressed={sourceReady && original}
          onClick={() => { onOriginal(true); }}>
          B <span>Original</span>
        </button>
      </div>
      <button type="button" className="play-button" aria-label={loading ? "Starting playback" : playing ? "Pause" : "Play"}
        disabled={!sourceReady || loading} onClick={() => { if (playing) onPause(); else void onPlay(); }}>
        <Icon name={loading ? "refresh-cw" : playing ? "pause" : "play"} />
      </button>
      <span className="transport-time">{formatTime(position)} <i>/</i> {formatTime(duration)}</span>
      {playing && state && state.appliedVersion < state.parameterVersion && <span role="status" className="disclosure">Updating audio…</span>}
      <label className="volume-control">
        Volume
        <input type="range" aria-label="Playback volume" min={0} max={1} step={0.01} value={state?.volume ?? 0.8} disabled={!sourceReady}
          onChange={(event) => { onVolume(Number(event.target.value)); }} />
      </label>
    </div>
  );
}
