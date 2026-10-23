"use client";
import { useEffect, useRef } from "react";
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
  onRestart: () => void;
  onForward: () => void;
  onRepeat: (enabled: boolean) => void;
  onScrub: (direction: -1 | 1, phase: "start" | "end" | "cancel") => void;
  nextTrackTitle?: string;
  handover?: boolean;
  inline?: boolean;
};

const actionClass = "touch-none select-none grid size-[44px] shrink-0 place-items-center rounded-full border border-transparent bg-transparent text-ink [&_svg]:size-5 transition-colors hover:enabled:bg-paper-deep disabled:cursor-not-allowed disabled:opacity-45";


/** Pointer and keyboard holds share one cancellable session; a hold never also skips a song. */
function useHoldAction(direction: -1 | 1, onScrub: RealTransportProps["onScrub"], onTap: () => void, disabled: boolean) {
  const callbacks = useRef({ onScrub, onTap });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const session = useRef<{ origin: "pointer" | "key"; held: boolean; element: HTMLButtonElement } | null>(null);
  const resumeFocus = useRef<HTMLButtonElement | null>(null);
  const suppressClick = useRef(false);
  useEffect(() => { callbacks.current = { onScrub, onTap }; }, [onScrub, onTap]);
  function finish(phase: "end" | "cancel") {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    const current = session.current;
    session.current = null;
    if (current !== null) {
      suppressClick.current = current.held || phase === "cancel";
      if (current.held) {
        if (current.origin === "key" && document.activeElement === current.element) resumeFocus.current = current.element;
        callbacks.current.onScrub(direction, phase);
      }
    }
    return current;
  }
  function begin(origin: "pointer" | "key", element: HTMLButtonElement) {
    if (disabled || session.current !== null) return;
    suppressClick.current = false;
    session.current = { origin, held: false, element };
    timer.current = setTimeout(() => {
      timer.current = null;
      if (session.current === null) return;
      session.current.held = true;
      callbacks.current.onScrub(direction, "start");
    }, 300);
  }
  useEffect(() => {
    function cancel() { finish("cancel"); }
    function escape(event: KeyboardEvent) { if (event.key === "Escape") cancel(); }
    window.addEventListener("blur", cancel);
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("blur", cancel);
      window.removeEventListener("keydown", escape);
      cancel();
      resumeFocus.current = null;
    };
  }, [direction]);
  useEffect(() => { if (disabled) finish("cancel"); }, [disabled]);
  useEffect(() => {
    if (disabled || resumeFocus.current === null) return;
    const element = resumeFocus.current;
    resumeFocus.current = null;
    if (element.isConnected && document.hasFocus() && (document.activeElement === document.body || document.activeElement === element)) element.focus({ preventScroll: true });
  });
  return {
    onPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0 || !event.isPrimary) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      begin("pointer", event.currentTarget);
    },
    onPointerUp: () => { finish("end"); },
    onPointerCancel: () => { finish("cancel"); },
    onLostPointerCapture: () => { finish("cancel"); },
    onBlur: () => { finish("cancel"); },
    onContextMenu: (event: React.MouseEvent<HTMLButtonElement>) => { event.preventDefault(); },
    onClick: () => {
      if (suppressClick.current) { suppressClick.current = false; return; }
      callbacks.current.onTap();
    },
    onKeyDown: (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (event.key !== " " && event.key !== "Enter") return;
      event.preventDefault();
      if (!event.repeat) begin("key", event.currentTarget);
    },
    onKeyUp: (event: React.KeyboardEvent<HTMLButtonElement>) => {
      if (event.key !== " " && event.key !== "Enter") return;
      event.preventDefault();
      if (session.current?.origin !== "key") return;
      const current = finish("end");
      suppressClick.current = true;
      if (current !== null && !current.held) callbacks.current.onTap();
    },
  };
}

/** One live audio clock: A is processed, B original; restart always means this track at zero. */
export function RealTransport({ state, sourceReady, onPlay, onPause, onOriginal, onVolume, onRestart, onForward, onRepeat, onScrub, nextTrackTitle, handover = false, inline = false }: RealTransportProps) {
  const playing = state?.playing ?? false;
  const loading = state?.loading ?? false;
  const original = state?.original ?? false;
  const repeat = state?.repeat ?? false;
  const position = state?.position ?? 0;
  const duration = state?.duration ?? 0;
  const unavailable = !sourceReady || handover;
  const updating = playing && state !== null && state.appliedVersion < state.parameterVersion;
  const status = handover ? "Loading next track…" : loading ? "Preparing playback…" : updating ? "Updating audio…" : nextTrackTitle ? `Next: ${nextTrackTitle}` : "";
  const forwardLabel = nextTrackTitle ? `Next track: ${nextTrackTitle}` : "Skip forward 10 seconds";
  const backActions = useHoldAction(-1, onScrub, onRestart, unavailable || loading);
  const forwardActions = useHoldAction(1, onScrub, onForward, unavailable || loading);
  return (
    <div className={`transport @container ${inline ? "relative w-full" : "fixed right-[14px] bottom-[calc(82px+env(safe-area-inset-bottom,0px))] left-[14px] z-25 w-auto md:sticky md:right-auto md:bottom-3 md:left-auto md:w-full"} min-w-0 rounded-[22px] border border-line-dark bg-paper px-3 py-2 shadow-[var(--shadow)]`}
      aria-label="Playback transport" aria-busy={loading || handover}
      data-position={position} data-playing={playing} data-ready={state?.ready ?? false}
      data-parameter-version={state?.parameterVersion ?? 0} data-applied-version={state?.appliedVersion ?? 0}>
      <div className="grid min-w-0 grid-cols-[minmax(188px,1fr)_60px] items-center gap-x-2 gap-y-1 @min-[640px]:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
        <div className="ab-toggle col-start-1 row-start-1 inline-flex w-fit justify-self-start rounded-full border border-line bg-paper-deep p-[3px] @min-[640px]:justify-self-start" role="group" aria-label="Processed and original audio">
          {([false, true] as const).map((isOriginal) => {
            const selected = sourceReady && original === isOriginal;
            return (
              <button key={String(isOriginal)} type="button" disabled={unavailable} aria-label={isOriginal ? "B Original" : "A Processed"}
                title={isOriginal ? "B · Original source" : "A · Processed output"} aria-pressed={selected}
                className={`min-h-[44px] min-w-[44px] rounded-full border-0 px-2.5 text-[11px] font-semibold disabled:cursor-not-allowed disabled:opacity-45 ${selected ? "is-active bg-clay-dark text-white" : "bg-transparent text-ink-soft hover:enabled:bg-paper"}`}
                onClick={() => { onOriginal(isOriginal); }}>
                {isOriginal ? "B" : "A"} <span className="@min-[640px]:hidden @min-[700px]:inline">{isOriginal ? "Original" : "Processed"}</span>
              </button>
            );
          })}
        </div>
        <div className="col-start-1 row-start-2 grid grid-cols-[repeat(4,44px)] items-center justify-self-start gap-1 @min-[640px]:col-start-2 @min-[640px]:row-start-1 @min-[640px]:grid-cols-[44px_44px_52px_44px_44px] @min-[640px]:justify-self-center @min-[640px]:gap-1.5" role="group" aria-label="Track playback controls">
          <span aria-hidden="true" className="hidden @min-[640px]:block" />
          <button type="button" className={actionClass} aria-label="Restart track" aria-description="Tap to restart this track. Hold to rewind." title="Restart track · Hold to rewind" disabled={unavailable || loading} {...backActions}>
            <Icon name="skip-back" />
          </button>
          <button type="button" className="play-button grid size-[44px] @min-[640px]:size-[52px] shrink-0 place-items-center rounded-full border border-clay-dark bg-clay text-white shadow-sm transition-colors hover:enabled:bg-clay-dark disabled:cursor-not-allowed disabled:opacity-45"
            aria-label={loading ? "Starting playback" : playing ? "Pause" : "Play"} title={playing ? "Pause" : "Play"}
            disabled={unavailable || loading} onClick={() => { if (playing) onPause(); else void onPlay(); }}>
            <Icon name={loading ? "refresh-cw" : playing ? "pause" : "play"} className={loading ? "spin" : ""} width="24" height="24" />
          </button>
          <button type="button" className={actionClass} aria-label={forwardLabel} aria-description="Tap for the labeled action. Hold to fast-forward without changing tracks." title={`${forwardLabel} · Hold to fast-forward`} disabled={unavailable || loading} {...forwardActions}>
            <Icon name={nextTrackTitle ? "skip-forward" : "forward-10"} />
          </button>
          <button type="button" className={`${actionClass} aria-pressed:border-clay-dark aria-pressed:bg-clay-wash aria-pressed:text-clay-dark`}
            aria-label="Repeat track" aria-pressed={repeat} title={repeat ? "Repeat this track: on" : "Repeat this track: off"}
            disabled={unavailable} onClick={() => { onRepeat(!repeat); }}>
            <Icon name="repeat" />
          </button>
        </div>
        <div className="contents @min-[640px]:col-start-3 @min-[640px]:row-start-1 @min-[640px]:flex @min-[640px]:min-w-0 @min-[640px]:items-center @min-[640px]:justify-self-end @min-[640px]:gap-2">
          <span className="transport-time col-start-2 row-start-1 w-[78px] justify-self-end shrink-0 whitespace-nowrap text-right text-[11px] text-ink-soft tabular-nums">{formatTime(position)} <span aria-hidden="true">/</span> {formatTime(duration)}</span>
          <label className="volume-control col-start-2 row-start-2 flex min-h-[44px] shrink-0 items-center justify-self-end @min-[640px]:gap-1" title="Playback volume · Double-click or press Backspace to reset to 100%">
            <span className="sr-only">Volume</span><Icon name="volume" width="16" height="16" />
            <input className="min-h-[44px] w-[44px] min-w-[44px] @min-[640px]:w-[56px] accent-clay-dark" type="range" aria-label="Playback volume" min={0} max={1} step={0.01} value={state?.volume ?? 1} disabled={unavailable}
              aria-description="Double-click or press Backspace to reset volume to 100%."
              onDoubleClick={() => { onVolume(1); }} onKeyDown={(event) => { if (event.key === "Backspace") { event.preventDefault(); onVolume(1); } }}
              onChange={(event) => { onVolume(Number(event.target.value)); }} />
          </label>
        </div>
      </div>
      <p role="status" aria-live="polite" aria-atomic="true" title={status || undefined} className="transport-status m-0 h-4 truncate px-2 text-center text-[10px] leading-4 text-ink-soft">{status}</p>
    </div>
  );
}
