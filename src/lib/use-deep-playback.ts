"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { engineParams } from "./browser-engine";
import { advancedFromScript, advancedMatchesScript, deepSettingsSnapshot, deepSourceMatches, type ScriptV2 } from "./deep-mastering";
import { audioKey } from "./library";
import type { LivePlaybackController } from "./live-playback";
import { useStore } from "./store";
import type { AdvancedParams, Track } from "./types";

/** Deep.applied is the accepted audio/export snapshot; Track.advanced may be a pending baseline. */
export function useDeepPlayback(track: Track | undefined, live: RefObject<LivePlaybackController | null>) {
  const { state, dispatch } = useStore(); const latest = useRef(state); latest.current = state;
  const pendingBaseline = useRef<AdvancedParams | null>(null);
  const pending = useRef<AbortController | null>(null); const generation = useRef(0);
  const [busy, setBusy] = useState(false); const [message, setMessage] = useState(""); const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const retryRequest = useRef<{ script: ScriptV2; automatic: boolean } | null>(null);
  const id = track?.id;
  useEffect(() => { setBusy(false); setMessage(""); setError(""); retryRequest.current = null; return () => { generation.current++; pending.current?.abort(); pending.current = null; }; }, [id, track?.sourceRevision, track?.sourceAudioId]);
  const apply = useCallback(async (script: ScriptV2, automatic = false) => {
    const current = latest.current.tracks.find((item) => item.id === id), player = live.current;
    if (!current || !player) throw new Error("The source player is unavailable. Retry loading this source.");
    pending.current?.abort(); const controller = new AbortController(); pending.current = controller; const ticket = ++generation.current;
    const sourceRevision = current.sourceRevision ?? 0, key = audioKey(current), previous = current.deepMastering?.applied?.revision ?? null, advanced = current.advanced;
    function canCommit() { const active = latest.current.tracks.find((item) => item.id === id); return generation.current === ticket && !controller.signal.aborted && live.current === player && !!active && deepSourceMatches(active, script, sourceRevision) && audioKey(active) === key && active.advanced === advanced && (active.deepMastering?.applied?.revision ?? null) === previous; }
    pendingBaseline.current = advanced;
    retryRequest.current = { script, automatic };
    setBusy(true); setError(""); setMessage(automatic ? "Preparing the edited baseline. The applied revision remains active." : "Verifying source PCM and preparing a complete revision. The applied processing remains active.");
    try {
      const accepted = await player.applyScript(script, controller.signal, canCommit);
      controller.signal.throwIfAborted(); if (!canCommit()) throw new DOMException("The source or pending settings changed.", "AbortError");
      dispatch({ type: "COMMIT_DEEP_APPLIED", id: current.id, expectedSourceRevision: sourceRevision, expectedAudioKey: key, expectedAppliedRevision: previous, expectedAdvanced: advanced, script: accepted, advanced: automatic ? advanced : advancedFromScript(accepted), before: deepSettingsSnapshot(current) });
      retryRequest.current = null;
      setMessage("Applied revision " + String(accepted.revision) + " acknowledged. Live playback and export use this complete snapshot.");
    } catch (cause) {
      if (pending.current === controller && !controller.signal.aborted) { const detail = cause instanceof Error ? cause.message : "The processing revision could not be applied."; setError(detail); setMessage("The previous applied revision remains selected for playback and export."); }
      throw cause;
    } finally { if (pending.current === controller) { pending.current = null; setBusy(false); } }
  }, [dispatch, id, live]);
  useEffect(() => {
    if (pending.current && pendingBaseline.current !== track?.advanced) {
      generation.current++; pending.current.abort(); pending.current = null; setBusy(false);
      setMessage("Pending settings changed. The previous applied snapshot remains selected; a commit already in flight pauses playback for recovery.");
    }
  }, [track?.advanced]);
  const advanced = track?.advanced, applied = track?.deepMastering?.applied;
  useEffect(() => {
    if (!advanced || !applied || advancedMatchesScript(advanced, applied)) return;
    pending.current?.abort(); generation.current++;
    const timer = setTimeout(() => {
      const script = { ...applied, revision: applied.revision + 1, chainParams: { ...engineParams(advanced), algorithmVersion: applied.chainParams.algorithmVersion ?? 1 } };
      void apply(script, true).catch(() => undefined);
    }, 100);
    return () => { clearTimeout(timer); pending.current?.abort(); generation.current++; };
  }, [advanced, applied, retry, apply]);
  async function detach(revert: boolean) {
    const current = latest.current.tracks.find((item) => item.id === id), player = live.current;
    const deep = current?.deepMastering; if (!current || !deep?.applied || !deep.before || !player) return;
    pending.current?.abort(); const controller = new AbortController(); pending.current = controller; const ticket = ++generation.current;
    const snapshot = revert ? deep.before : { ...deepSettingsSnapshot(current), advanced: advancedFromScript(deep.applied), shortcutUndo: {} };
    const applied = deep.applied;
    const revision = applied.revision, sourceRevision = current.sourceRevision ?? 0, key = audioKey(current), advanced = current.advanced;
    function canCommit() { const active = latest.current.tracks.find((item) => item.id === id); return generation.current === ticket && !controller.signal.aborted && live.current === player && !!active && deepSourceMatches(active, applied, sourceRevision) && audioKey(active) === key && active.advanced === advanced && active.deepMastering?.applied?.revision === revision; }
    pendingBaseline.current = advanced;
    setBusy(true); setError(""); setMessage(revert ? "Restoring the complete settings saved before the first Apply…" : "Detaching automation and restoring its static baseline…");
    try {
      await player.detachScript(snapshot.advanced, controller.signal, canCommit);
      controller.signal.throwIfAborted(); if (!canCommit()) throw new DOMException("The source or settings changed.", "AbortError");
      dispatch({ type: "DETACH_DEEP_APPLIED", id: current.id, expectedSourceRevision: sourceRevision, expectedAudioKey: key, expectedAppliedRevision: revision, expectedAdvanced: advanced, snapshot });
      setMessage(revert ? "Restored the full settings snapshot saved before the first Apply. The draft is retained." : "Automation detached. Its static baseline is active; the draft is retained.");
    } catch (cause) { if (pending.current === controller && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Could not restore static processing."); }
    finally { if (pending.current === controller) { pending.current = null; setBusy(false); } }
  }
  return { apply, busy, message, error, retry: () => { const request = retryRequest.current; if (request) void apply(request.script, request.automatic).catch(() => undefined); else setRetry((value) => value + 1); }, revert: () => { void detach(true); }, detach: () => { void detach(false); }, cancel: () => { generation.current++; pending.current?.abort(); pending.current = null; setBusy(false); setMessage("Processing publication canceled. The previous applied revision remains selected."); }, restoreAppliedSettings: () => { const current = latest.current.tracks.find((item) => item.id === id); if (current?.deepMastering?.applied) dispatch({ type: "UPDATE_TRACK", id: current.id, patch: { advanced: advancedFromScript(current.deepMastering.applied) } }); } };
}
