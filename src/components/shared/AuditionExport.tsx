"use client";

import { useEffect, useRef, useState } from "react";
import { renderDelivery } from "@/lib/browser-engine";
import { reserveBrowserAudioMemory } from "@/lib/browser-jobs";
import { deliveryRequest, deliverySummary, type DeliveryFormat } from "@/lib/delivery-format";
import { exportRender } from "@/lib/engine-params";
import { exportTrackKey } from "@/lib/export-identity";
import type { Track } from "@/lib/types";
import { Icon } from "./Icon";
import { Button, SliderField } from "./Primitives";

/** Everything that changes the bytes Export writes; a different key makes an audition stale. */
export function auditionKey(track: Track, delivery: DeliveryFormat): string {
  return JSON.stringify([exportTrackKey(track), deliveryRequest(delivery), delivery.bitDepth]);
}

/** A rendered export file, kept so Export can hand over these same bytes. */
export type HeldAudition = { key: string; blob: Blob; truePeakDbtp: number | null };
/** Lets the page's media keys drive the audition while it plays. */
export type AuditionHandle = {
  /** Fresh and loaded, so it can (re)start without rendering. */
  canPlay: () => boolean;
  playing: () => boolean;
  play: () => Promise<void>;
  pause: () => void;
  seek: (seconds: number) => void;
  position: () => { position: number; duration: number };
};

type Held = HeldAudition & { url: string; memory: ReturnType<typeof reserveBrowserAudioMemory> };
type Phase =
  | { kind: "idle"; message: string }
  | { kind: "rendering"; progress: number | null }
  | { kind: "ready" }
  | { kind: "error"; message: string };

type Fallback = { current: { context: AudioContext; gain: GainNode } | null };
const clampVolume = (volume: number) => Math.max(0, Math.min(1, Number.isFinite(volume) ? volume : 1));

/** Follow a volume change: the GainNode once routed, else the element. Never
 * creates Web Audio objects; that happens only in a gesture (prepareVolume). */
function applyVolume(element: HTMLAudioElement | null, volume: number, fallback: Fallback): void {
  const level = clampVolume(volume);
  if (fallback.current) { fallback.current.gain.gain.value = level; return; }
  if (element) element.volume = level;
}

/**
 * iOS media volume can echo an assigned value without applying audible gain.
 * Route iPhone/iPad playback through Web Audio regardless of that readback;
 * touch-enabled Macintosh covers iPadOS's desktop browser identity.
 */
function needsVolumeRoute(): boolean {
  return /iPad|iPhone|iPod/iu.test(navigator.userAgent)
    || (/Macintosh/iu.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
}

/**
 * Build the volume route only in a Play gesture: Safari activation does not
 * survive the render's await. Other platforms keep the media-element path
 * unless their volume property rejects an assignment. The routed element stays
 * at unity while GainNode applies the monitor volume, without decoding a copy.
 */
function prepareVolume(element: HTMLAudioElement, volume: number, fallback: Fallback, gesture: boolean): Promise<void> | null {
  const level = clampVolume(volume);
  if (!fallback.current) {
    const probe = level === 1 ? 0.5 : level;
    element.volume = probe;
    const ignored = Math.abs(element.volume - probe) >= 0.001;
    element.volume = level;
    if ((!needsVolumeRoute() && !ignored) || typeof AudioContext === "undefined") return Promise.resolve();
    if (!gesture) return null;
    const context = new AudioContext();
    const gain = context.createGain();
    context.createMediaElementSource(element).connect(gain).connect(context.destination);
    fallback.current = { context, gain };
  }
  const { context, gain } = fallback.current;
  gain.gain.value = level;
  element.volume = 1;
  if (context.state === "running") return Promise.resolve();
  return gesture ? context.resume() : null;
}

/**
 * Plays the exact file Export writes (V1-10 owner ruling): rendered by the
 * Export path at the source rate and played from its WAV Blob by one media
 * element. Only the Blob is held, never a decoded AudioBuffer; the memory
 * admission charges it once it exists, as for an Export download.
 */
export function AuditionExport({ track, sourceBlob, delivery, volume, livePlaying, onStart, onHeld, onHandle, onPlayingChange, onPositionChange }: {
  track: Track;
  sourceBlob: Blob | null;
  delivery: DeliveryFormat;
  /** The transport's Playback volume (0–1), a monitor control like live's. */
  volume: number;
  /** Live playback is running; the audition pauses so only one plays. */
  livePlaying: boolean;
  /** Called as the audition starts so live playback can pause. */
  onStart: () => void;
  /** The held file, or null when none is held. */
  onHeld?: (held: HeldAudition | null) => void;
  onHandle?: (handle: AuditionHandle | null) => void;
  onPlayingChange?: (playing: boolean) => void;
  onPositionChange?: () => void;
}) {
  const audio = useRef<HTMLAudioElement | null>(null);
  // iOS and other elements that reject .volume: element → gain → speakers.
  const fallbackGain = useRef<{ context: AudioContext; gain: GainNode } | null>(null);
  const held = useRef<Held | null>(null);
  const pending = useRef<AbortController | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle", message: "" });
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(track.duration);
  const [notice, setNotice] = useState("");
  const playingNow = useRef(false);
  // Bumped by each start and by each pause we ask for, so a start that our own
  // pause (A/B, Space, Pause, an edit) interrupts is not reported as a failure.
  const attempt = useRef(0);
  function stop() { attempt.current++; audio.current?.pause(); }
  const [heldKey, setHeldKey] = useState("");
  const key = auditionKey(track, delivery);
  const stale = phase.kind === "ready" && heldKey !== key;
  const format = deliverySummary(delivery, track.sampleRate);
  // What is true now, for a render that completes later (Round 5 R-1).
  const latest = useRef({ key, livePlaying, volume, onHeld, onPlayingChange, onPositionChange });
  latest.current = { key, livePlaying, volume, onHeld, onPlayingChange, onPositionChange };

  function release() {
    stop();
    audio.current?.removeAttribute("src");
    audio.current?.load();
    if (held.current) { URL.revokeObjectURL(held.current.url); held.current.memory.dispose(); }
    held.current = null;
    setHeldKey("");
    setNotice("");
    latest.current.onHeld?.(null);
  }
  function cancel() {
    pending.current?.abort();
    pending.current = null;
  }
  /** `gesture` is false for the auto-play after a render, which is not one. The
   * resume and play() start in the same turn as the click, then are awaited. */
  async function play(gesture = true) {
    const element = audio.current;
    if (!element || !held.current || held.current.key !== latest.current.key) return;
    const ticket = ++attempt.current;
    try {
      const resumed = prepareVolume(element, latest.current.volume, fallbackGain, gesture);
      if (!resumed) return;
      // Playing from the moment play() starts: the media "play" event is a later
      // task, and A/B or a key in the same task must already see it (QA E9).
      playingNow.current = true;
      onStart();
      const started = element.play();
      await Promise.all([resumed, started]);
      setNotice("");
    } catch (cause) {
      // A refused or interrupted start (NotAllowedError, AbortError) keeps the
      // held file: stay Ready, and the next click plays it.
      // No media event follows a refused start, so report the state ourselves
      // (the Media Session would otherwise stay "playing", Round 8f).
      changed(!element.paused);
      if (ticket !== attempt.current) return;
      setNotice(cause instanceof DOMException && cause.name === "NotAllowedError"
        ? "The browser did not allow the audition to start. Press Play audition to try again."
        : "The audition did not start. Press Play audition to try again.");
    }
  }
  function updatePosition() {
    const element = audio.current;
    if (!element) return;
    const length = Number.isFinite(element.duration) && element.duration > 0 ? element.duration : track.duration;
    setDuration(length); setPosition(Math.max(0, Math.min(length, element.currentTime)));
    latest.current.onPositionChange?.();
  }
  function seek(seconds: number) {
    const element = audio.current;
    if (!element || !held.current || held.current.key !== latest.current.key || !Number.isFinite(seconds)) return;
    const length = Number.isFinite(element.duration) && element.duration > 0 ? element.duration : track.duration;
    element.currentTime = Math.max(0, Math.min(length, seconds));
    updatePosition();
  }
  const handle = useRef<AuditionHandle>({
    canPlay: () => held.current !== null && held.current.key === latest.current.key,
    playing: () => playingNow.current,
    play: () => play(),
    // Mark it paused at once: the media "pause" event is a later task, and a
    // play/pause key pressed before it must already see the audition stopped.
    pause: () => { playingNow.current = false; stop(); },
    seek: (seconds) => { seek(seconds); },
    position: () => ({ position: audio.current?.currentTime ?? 0, duration: audio.current && Number.isFinite(audio.current.duration) ? audio.current.duration : track.duration }),
  });
  handle.current.play = () => play();
  handle.current.seek = seek;
  useEffect(() => {
    onHandle?.(handle.current);
    return () => { onHandle?.(null); pending.current?.abort(); pending.current = null; release(); };
  }, []);
  // Follow the Playback volume like live does, on start and on every move.
  useEffect(() => { applyVolume(audio.current, volume, fallbackGain); }, [volume]);
  useEffect(() => () => { void fallbackGain.current?.context.close().catch(() => undefined); fallbackGain.current = null; }, []);
  // Never let stale audio keep playing after an edit.
  useEffect(() => { if (stale) stop(); }, [stale]);
  // Live played at any point during a render (even if paused again before it
  // finished): the finished audition then waits, Ready (Q-S1).
  const liveDuringRender = useRef(false);
  useEffect(() => {
    if (livePlaying) stop();
    if (livePlaying && pending.current) liveDuringRender.current = true;
  }, [livePlaying]);

  async function render() {
    if (!sourceBlob) return;
    cancel(); release();
    liveDuringRender.current = latest.current.livePlaying;
    const controller = new AbortController();
    pending.current = controller;
    const renderedKey = key;
    try {
      setPhase({ kind: "rendering", progress: null });
      const { blob, truePeakDbtp } = await renderDelivery(sourceBlob, exportRender(track), delivery.bitDepth, deliveryRequest(delivery), controller.signal,
        (progress) => { if (pending.current === controller) setPhase({ kind: "rendering", progress }); });
      controller.signal.throwIfAborted();
      // Charged once it exists, like an Export download, so whatever Export can render can be auditioned.
      const memory = reserveBrowserAudioMemory(blob.size);
      const url = URL.createObjectURL(blob);
      held.current = { key: renderedKey, blob, truePeakDbtp, url, memory };
      pending.current = null;
      setHeldKey(renderedKey);
      setPhase({ kind: "ready" });
      if (audio.current) audio.current.src = url;
      latest.current.onHeld?.({ key: renderedKey, blob, truePeakDbtp });
      // An edit during the render leaves it stale, and live Play during the render
      // keeps the transport: in either case it waits, ready, without playing.
      if (renderedKey === latest.current.key && !latest.current.livePlaying && !liveDuringRender.current) await play(false);
    } catch (cause) {
      if (pending.current === controller) pending.current = null;
      setPhase(controller.signal.aborted
        ? { kind: "idle", message: "Audition render canceled." }
        : { kind: "error", message: cause instanceof Error ? cause.message : "The audition could not be rendered. Try again." });
    }
  }

  const status = phase.kind === "rendering"
    // Announced in quarters, not on every percent (P2-1); the bar shows the rest.
    ? `Rendering the export (${format})${phase.progress === null ? "…" : ` — ${String(Math.floor(phase.progress / 25) * 25)}%`}`
    : stale
      ? "Settings changed after this audition was rendered, so it no longer matches the export. Re-render to hear the current export."
      : phase.kind === "ready"
        ? `${playing ? "Playing" : "Ready:"} the exact export file (${format}).${notice && !playing ? ` ${notice}` : ""}`
        : phase.message;

  const action: { label: string; icon: "x" | "pause" | "play"; disabled: boolean; run: () => void } = phase.kind === "rendering"
    ? { label: "Cancel audition render", icon: "x", disabled: false, run: cancel }
    : phase.kind === "ready" && !stale
      ? { label: playing ? "Pause audition" : "Play audition", icon: playing ? "pause" : "play", disabled: false, run: () => { if (playing) stop(); else void play(); } }
      : { label: stale ? "Re-render audition" : "Audition export", icon: "play", disabled: !sourceBlob, run: () => void render() };
  function changed(next: boolean) { playingNow.current = next; setPlaying(next); latest.current.onPlayingChange?.(next); }
  return <section className="flex flex-wrap items-center gap-2" aria-label="Audition export">
    {/* One button whose label and action change, so keyboard focus stays on it
        through render, cancel, play and re-render (WCAG 2.4.3). */}
    <Button variant="secondary" icon={<Icon name={action.icon} />} disabled={action.disabled} onClick={action.run}>{action.label}</Button>
    {/* After the button, so it does not move while focused (P2-2). */}
    {phase.kind === "rendering" && <progress className="w-full max-w-60" max={100} {...(phase.progress === null ? {} : { value: phase.progress })} aria-label="Audition export render progress" />}
    <p className="disclosure min-w-0 basis-full" role={phase.kind === "error" ? "alert" : "status"}>{status}</p>
    {phase.kind === "ready" && !stale && <div className="w-full"><SliderField label="Audition position" defaultValue={0} value={position} min={0} max={duration} step={0.1} unit="s" onChange={seek} /></div>}
    <audio ref={audio} onTimeUpdate={updatePosition} onLoadedMetadata={updatePosition} onSeeked={updatePosition} className="audition-export hidden" preload="auto"
      onPlay={() => { changed(true); }} onPause={() => { changed(false); }} onEnded={() => { changed(false); }} />
  </section>;
}
