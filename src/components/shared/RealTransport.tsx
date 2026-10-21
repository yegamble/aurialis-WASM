"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  computeRmsValue,
  previewWAV,
  type StereoPCM,
} from "@/lib/browser-engine";
import { Icon } from "./Icon";
import { formatTime } from "./Primitives";
export function RealTransport({
  pcm,
  ab,
  onAB,
  processedReady,
  playheadRatio,
  onSeekRatio,
  sourcePcm,
  processedPcm,
}: {
  pcm: StereoPCM | null;
  ab: "A" | "B";
  onAB: (value: "A" | "B") => void;
  processedReady: boolean;
  playheadRatio: number;
  onSeekRatio: (value: number) => void;
  sourcePcm?: StereoPCM | null;
  processedPcm?: StereoPCM | null;
}) {
  const ref = useRef<HTMLAudioElement>(null),
    previousRatio = useRef(playheadRatio);
  const [src, setSrc] = useState(""),
    [playing, setPlaying] = useState(false),
    [error, setError] = useState(""),
    [volume, setVolume] = useState(0.8),
    [matchLoudness, setMatchLoudness] = useState(false);
  const duration = pcm ? pcm.left.length / pcm.sampleRate : 0;

  const comparisonLevels = useMemo(() => ({
    original: sourcePcm ? computeRmsValue(sourcePcm) : 0,
    processed: processedPcm ? computeRmsValue(processedPcm) : 0,
  }), [sourcePcm, processedPcm]);
  // Match by attenuating the louder source, never by clipping a boosted monitor.
  const { original, processed } = comparisonLevels;
  const commonLevel = Math.min(original, processed);
  const currentLevel = ab === "B" && processedReady ? processed : original;
  const gainTrim = matchLoudness && commonLevel > 0 && currentLevel > 0
    ? commonLevel / currentLevel : 1;
  const effectiveVolume = Math.min(1, Math.max(0, volume * gainTrim));
  const monitorVolume = useRef(effectiveVolume);
  monitorVolume.current = effectiveVolume;
  const pendingPlayback = useRef<{ time: number; playing: boolean } | null>(null);

  useEffect(() => {
    if (ref.current) {
      ref.current.volume = effectiveVolume;
    }
  }, [effectiveVolume]);
  useEffect(() => {
    if (!pcm) {
      setSrc("");
      return undefined;
    }
    const audio = ref.current;
    pendingPlayback.current = {
      time: audio && Number.isFinite(audio.currentTime) ? audio.currentTime : playheadRatio * duration,
      playing: audio ? !audio.paused : false,
    };
    const url = URL.createObjectURL(previewWAV(pcm));
    setSrc(url);
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [pcm]);
  useEffect(() => {
    const audio = ref.current;
    if (
      audio &&
      Math.abs(playheadRatio - previousRatio.current) > 0.002 &&
      Math.abs(audio.currentTime - playheadRatio * duration) > 0.15
    )
      audio.currentTime = playheadRatio * duration;
    previousRatio.current = playheadRatio;
  }, [playheadRatio, duration]);
  async function toggle() {
    if (!ref.current) return;
    try {
      if (ref.current.paused) await ref.current.play();
      else ref.current.pause();
      setError("");
    } catch {
      setError("Playback was blocked. Press play to retry.");
    }
  }
  return (
    <>
      <div className="transport">
        <audio
          ref={ref}
          src={src || undefined}
          onLoadedMetadata={(event) => {
            const audio = event.currentTarget;
            const pending = pendingPlayback.current;
            audio.volume = monitorVolume.current;
            audio.currentTime = Math.min(pending?.time ?? playheadRatio * duration, duration);
            pendingPlayback.current = null;
            if (pending?.playing) {
              void audio.play().catch(() => { setError("Press play to resume the comparison."); });
            }
          }}
          onTimeUpdate={(event) => {
            if (!pendingPlayback.current && event.currentTarget.readyState > 0) {
              onSeekRatio(duration > 0 ? event.currentTarget.currentTime / duration : 0);
            }
          }}
          onPlay={() => {
            setPlaying(true);
          }}
          onPause={() => {
            setPlaying(false);
          }}
          onEnded={() => {
            setPlaying(false);
          }}
          onError={() => {
            setError("The browser could not play this audio.");
          }}
        />
        <div
          className="ab-toggle"
          role="group"
          aria-label="Original and processed audio"
        >
          <button
            type="button"
            className={ab === "A" || !processedReady ? "is-active" : ""}
            aria-pressed={ab === "A" || !processedReady}
            onClick={() => {
              onAB("A");
            }}
          >
            A <span>Original</span>
          </button>
          <button
            type="button"
            disabled={!processedReady}
            className={ab === "B" && processedReady ? "is-active" : ""}
            aria-pressed={ab === "B" && processedReady}
            onClick={() => {
              onAB("B");
            }}
          >
            B <span>Processed</span>
          </button>
          <button
            type="button"
            disabled={!processedReady}
            className={matchLoudness ? "is-active" : ""}
            aria-pressed={matchLoudness}
            title="Match whole-track RMS level between A and B"
            onClick={() => {
              setMatchLoudness(!matchLoudness);
            }}
            style={{ fontSize: "11px", padding: "0 8px" }}
          >
            Match level
          </button>
        </div>
        <button
          type="button"
          className="play-button"
          aria-label={playing ? "Pause" : "Play"}
          disabled={!pcm}
          onClick={() => void toggle()}
        >
          <Icon name={playing ? "pause" : "play"} />
        </button>
        <span className="transport-time">
          {formatTime(playheadRatio * duration)} <i>/</i> {formatTime(duration)}
        </span>
        <label className="volume-control">
          Volume
          <input
            type="range"
            aria-label="Playback volume"
            min={0}
            max={1}
            step={0.01}
            value={volume}
            onChange={(event) => {
              const next = Number(event.target.value);
              setVolume(next);
            }}
          />
        </label>
      </div>
      {error && (
        <p role="alert" className="disclosure">
          {error}
        </p>
      )}
    </>
  );
}
