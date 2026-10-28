"use client";

import { useEffect, useRef, useState } from "react";
import { renderDelivery } from "@/lib/browser-engine";
import { reserveBrowserAudioMemory } from "@/lib/browser-jobs";
import { deliveryRequest, deliverySummary, type DeliveryFormat } from "@/lib/delivery-format";
import { exportRender } from "@/lib/engine-params";
import type { Track } from "@/lib/types";
import { Icon } from "./Icon";
import { Button } from "./Primitives";

/** Everything that changes the bytes Export writes; a different key makes an audition stale. */
export function auditionKey(track: Track, delivery: DeliveryFormat): string {
  return JSON.stringify([track.id, track.sourceAudioId ?? track.id, track.sourceRevision ?? 0, track.sourceIdentity?.pcmHash ?? "",
    exportRender(track), deliveryRequest(delivery), delivery.bitDepth]);
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
 * Before playing, synchronously (S-1, Round 8: WebKit's user activation does not
 * survive an await): set the element's volume, and where it does not stick (iOS
 * Safari ignores HTMLMediaElement.volume) route the element once through a
 * GainNode with the element itself at 1, and start resuming its context. The
 * probe uses a value other than 1, so a slider left at 1 still reveals an
 * ignored volume (S-2). Building or resuming that route needs a user gesture,
 * so without one (auto-play after a render) this returns null where the route
 * is missing or suspended, and the audition stays Ready for a click. Other
 * browsers never get a Web Audio path. Returns the pending resume, if any.
 * The iOS path is unverified on a real device (no WebKit/iOS project).
 */
function prepareVolume(element: HTMLAudioElement, volume: number, fallback: Fallback, gesture: boolean): Promise<void> | null {
  const level = clampVolume(volume);
  if (!fallback.current) {
    const probe = level === 1 ? 0.5 : level;
    element.volume = probe;
    const ignored = Math.abs(element.volume - probe) >= 0.001;
    element.volume = level;
    if (!ignored || typeof AudioContext === "undefined") return Promise.resolve();
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
export function AuditionExport({ track, sourceBlob, delivery, volume, livePlaying, onStart, onHeld, onHandle, onPlayingChange }: {
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
}) {
  const audio = useRef<HTMLAudioElement | null>(null);
  // Only where the element ignores .volume (iOS Safari): element → gain → speakers.
  const fallbackGain = useRef<{ context: AudioContext; gain: GainNode } | null>(null);
  const held = useRef<Held | null>(null);
  const pending = useRef<AbortController | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle", message: "" });
  const [playing, setPlaying] = useState(false);
  const [notice, setNotice] = useState("");
  const playingNow = useRef(false);
  const [heldKey, setHeldKey] = useState("");
  const key = auditionKey(track, delivery);
  const stale = phase.kind === "ready" && heldKey !== key;
  const format = deliverySummary(delivery, track.sampleRate);
  // What is true now, for a render that completes later (Round 5 R-1).
  const latest = useRef({ key, livePlaying, volume, onHeld, onPlayingChange });
  latest.current = { key, livePlaying, volume, onHeld, onPlayingChange };

  function release() {
    audio.current?.pause();
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
    try {
      const resumed = prepareVolume(element, latest.current.volume, fallbackGain, gesture);
      if (!resumed) return;
      onStart();
      const started = element.play();
      await Promise.all([resumed, started]);
      setNotice("");
    } catch (cause) {
      // A refused or interrupted start (NotAllowedError, AbortError) keeps the
      // held file: stay Ready, and the next click plays it.
      setNotice(cause instanceof DOMException && cause.name === "NotAllowedError"
        ? "The browser did not allow the audition to start. Press Play audition to try again."
        : "The audition did not start. Press Play audition to try again.");
    }
  }
  const handle = useRef<AuditionHandle>({
    canPlay: () => held.current !== null && held.current.key === latest.current.key,
    playing: () => playingNow.current,
    play: () => play(),
    pause: () => { audio.current?.pause(); },
    position: () => ({ position: audio.current?.currentTime ?? 0, duration: audio.current && Number.isFinite(audio.current.duration) ? audio.current.duration : 0 }),
  });
  handle.current.play = () => play();
  useEffect(() => {
    onHandle?.(handle.current);
    return () => { onHandle?.(null); pending.current?.abort(); pending.current = null; release(); };
  }, []);
  // Follow the Playback volume like live does, on start and on every move.
  useEffect(() => { applyVolume(audio.current, volume, fallbackGain); }, [volume]);
  useEffect(() => () => { void fallbackGain.current?.context.close().catch(() => undefined); fallbackGain.current = null; }, []);
  // Never let stale audio keep playing after an edit.
  useEffect(() => { if (stale) audio.current?.pause(); }, [stale]);
  // Live played at any point during a render (even if paused again before it
  // finished): the finished audition then waits, Ready (Q-S1).
  const liveDuringRender = useRef(false);
  useEffect(() => {
    if (livePlaying) audio.current?.pause();
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
      ? { label: playing ? "Pause audition" : "Play audition", icon: playing ? "pause" : "play", disabled: false, run: () => { if (playing) audio.current?.pause(); else void play(); } }
      : { label: stale ? "Re-render audition" : "Audition export", icon: "play", disabled: !sourceBlob, run: () => void render() };
  function changed(next: boolean) { playingNow.current = next; setPlaying(next); latest.current.onPlayingChange?.(next); }
  return <section className="flex flex-wrap items-center gap-2" aria-label="Audition export">
    {/* One button whose label and action change, so keyboard focus stays on it
        through render, cancel, play and re-render (WCAG 2.4.3). */}
    <Button variant="secondary" icon={<Icon name={action.icon} />} disabled={action.disabled} onClick={action.run}>{action.label}</Button>
    {/* After the button, so it does not move while focused (P2-2). */}
    {phase.kind === "rendering" && <progress className="w-full max-w-60" max={100} {...(phase.progress === null ? {} : { value: phase.progress })} aria-label="Audition export render progress" />}
    <p className="disclosure min-w-0 basis-full" role={phase.kind === "error" ? "alert" : "status"}>{status}</p>
    <audio ref={audio} className="audition-export hidden" preload="auto"
      onPlay={() => { changed(true); }} onPause={() => { changed(false); }} onEnded={() => { changed(false); }} />
  </section>;
}
