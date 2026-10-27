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

/**
 * Plays the exact file Export writes (V1-10 owner ruling): rendered by the
 * Export path at the source rate and played from its WAV Blob by one media
 * element. Only the Blob is held, never a decoded AudioBuffer; the memory
 * admission charges it once it exists, as for an Export download.
 */
export function AuditionExport({ track, sourceBlob, delivery, livePlaying, onStart, onHeld, onHandle, onPlayingChange }: {
  track: Track;
  sourceBlob: Blob | null;
  delivery: DeliveryFormat;
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
  const held = useRef<Held | null>(null);
  const pending = useRef<AbortController | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle", message: "" });
  const [playing, setPlaying] = useState(false);
  const playingNow = useRef(false);
  const [heldKey, setHeldKey] = useState("");
  const key = auditionKey(track, delivery);
  const stale = phase.kind === "ready" && heldKey !== key;
  const format = deliverySummary(delivery, track.sampleRate);
  // What is true now, for a render that completes later (Round 5 R-1).
  const latest = useRef({ key, livePlaying, onHeld, onPlayingChange });
  latest.current = { key, livePlaying, onHeld, onPlayingChange };

  function release() {
    audio.current?.pause();
    audio.current?.removeAttribute("src");
    audio.current?.load();
    if (held.current) { URL.revokeObjectURL(held.current.url); held.current.memory.dispose(); }
    held.current = null;
    setHeldKey("");
    latest.current.onHeld?.(null);
  }
  function cancel() {
    pending.current?.abort();
    pending.current = null;
  }
  async function play() {
    const element = audio.current;
    if (!element || !held.current || held.current.key !== latest.current.key) return;
    onStart();
    try { await element.play(); }
    catch (cause) { setPhase({ kind: "error", message: cause instanceof Error ? `The audition could not play: ${cause.message}` : "The audition could not play. Try again." }); }
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
  // Never let stale audio keep playing after an edit.
  useEffect(() => { if (stale) audio.current?.pause(); }, [stale]);
  useEffect(() => { if (livePlaying) audio.current?.pause(); }, [livePlaying]);

  async function render() {
    if (!sourceBlob) return;
    cancel(); release();
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
      if (renderedKey === latest.current.key && !latest.current.livePlaying) await play();
    } catch (cause) {
      if (pending.current === controller) pending.current = null;
      setPhase(controller.signal.aborted
        ? { kind: "idle", message: "Audition render canceled." }
        : { kind: "error", message: cause instanceof Error ? cause.message : "The audition could not be rendered. Try again." });
    }
  }

  const status = phase.kind === "rendering"
    ? `Rendering the export (${format})${phase.progress === null ? "…" : ` — ${String(Math.round(phase.progress))}%`}`
    : stale
      ? "Settings changed after this audition was rendered, so it no longer matches the export. Re-render to hear the current export."
      : phase.kind === "ready"
        ? `${playing ? "Playing" : "Ready:"} the exact export file (${format}).`
        : phase.message;

  function changed(next: boolean) { playingNow.current = next; setPlaying(next); latest.current.onPlayingChange?.(next); }
  return <section className="flex flex-wrap items-center gap-2" aria-label="Audition export">
    {phase.kind === "rendering"
      ? <>
        <progress className="w-full max-w-60" max={100} {...(phase.progress === null ? {} : { value: phase.progress })} aria-label="Audition export render progress" />
        <Button variant="secondary" icon={<Icon name="x" />} onClick={cancel}>Cancel audition render</Button>
      </>
      : phase.kind === "ready" && !stale
        ? <Button variant="secondary" icon={<Icon name={playing ? "pause" : "play"} />} onClick={() => { if (playing) audio.current?.pause(); else void play(); }}>
          {playing ? "Pause audition" : "Play audition"}
        </Button>
        : <Button variant="secondary" icon={<Icon name="play" />} disabled={!sourceBlob} onClick={() => void render()}>
          {stale ? "Re-render audition" : "Audition export"}
        </Button>}
    <p className="disclosure min-w-0 basis-full" role={phase.kind === "error" ? "alert" : "status"}>{status}</p>
    <audio ref={audio} className="audition-export hidden" preload="auto"
      onPlay={() => { changed(true); }} onPause={() => { changed(false); }} onEnded={() => { changed(false); }} />
  </section>;
}
