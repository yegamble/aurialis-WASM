"use client";
import { useEffect, useRef, type RefObject } from "react";
import type { LivePlaybackController, LivePlaybackState } from "./live-playback";

/** Shared hold session for Master and Library: one frame clock, pause and resume. */
export function useTransportScrub(live: RefObject<LivePlaybackController | null>, callbacks: { available: () => boolean; resume: () => void; advance?: (state: LivePlaybackState) => void }) {
  const current = useRef(callbacks); current.current = callbacks;
  const scrub = useRef<{ controller: LivePlaybackController; direction: -1 | 1; startedAt: number; lastAt: number; position: number; wasPlaying: boolean; frame: number } | null>(null);
  function stopScrub(resume: boolean) {
    const session = scrub.current;
    if (!session) return;
    cancelAnimationFrame(session.frame);
    scrub.current = null;
    const state = session.controller.getState();
    if (resume && session.wasPlaying && live.current === session.controller && (state.position < state.duration || state.repeat)) current.current.resume();
  }
  function onScrub(direction: -1 | 1, phase: "start" | "end" | "cancel") {
    if (phase !== "start") { stopScrub(true); return; }
    const controller = live.current;
    if (!controller || !current.current.available() || controller.getState().loading) return;
    stopScrub(false);
    const state = controller.getState();
    controller.pause();
    const now = performance.now();
    const session = { controller, direction, startedAt: now, lastAt: now, position: controller.getState().position, wasPlaying: state.playing, frame: 0 };
    scrub.current = session;
    function advance(time: number) {
      if (scrub.current !== session || live.current !== controller) return;
      if (time - session.lastAt >= 50) {
        const elapsed = (time - session.startedAt) / 1000;
        const speed = elapsed >= 3 ? 8 : elapsed >= 1 ? 4 : 2;
        session.position = Math.max(0, Math.min(state.duration, session.position + direction * speed * Math.min(0.25, (time - session.lastAt) / 1000)));
        session.lastAt = time;
        session.controller.seek(session.position);
        current.current.advance?.(session.controller.getState());
      }
      session.frame = requestAnimationFrame(advance);
    }
    session.frame = requestAnimationFrame(advance);
  }
  useEffect(() => () => { stopScrub(false); }, []);
  return { session: scrub, stopScrub, onScrub };
}
