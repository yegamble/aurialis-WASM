"use client";
import { useEffect, useRef, useState } from "react";
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
}: {
  pcm: StereoPCM | null;
  ab: "A" | "B";
  onAB: (value: "A" | "B") => void;
  processedReady: boolean;
  playheadRatio: number;
  onSeekRatio: (value: number) => void;
  sourcePcm?: StereoPCM | null;
}) {
  const ref = useRef<HTMLAudioElement>(null),
    previousRatio = useRef(playheadRatio);
  const [src, setSrc] = useState(""),
    [playing, setPlaying] = useState(false),
    [error, setError] = useState(""),
    [volume, setVolume] = useState(0.8),
    [matchLoudness, setMatchLoudness] = useState(false);
  const duration = pcm ? pcm.left.length / pcm.sampleRate : 0;

  const gainTrim =
    matchLoudness && ab === "B" && sourcePcm && pcm
      ? (() => {
          const rmsA = computeRmsValue(sourcePcm);
          const rmsB = computeRmsValue(pcm);
          return rmsB > 0.0001 && rmsA > 0.0001
            ? Math.min(2.0, Math.max(0.2, rmsA / rmsB))
            : 1.0;
        })()
      : 1.0;
  const effectiveVolume = Math.min(1.0, Math.max(0, volume * gainTrim));

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
            event.currentTarget.volume = volume;
            event.currentTarget.currentTime = Math.min(
              playheadRatio * duration,
              duration,
            );
          }}
          onTimeUpdate={(event) => {
            onSeekRatio(
              duration > 0 ? event.currentTarget.currentTime / duration : 0,
            );
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
            title="Match perceived loudness between A and B"
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
              if (ref.current) ref.current.volume = next;
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
