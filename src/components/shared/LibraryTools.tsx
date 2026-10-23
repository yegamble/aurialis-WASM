"use client";

import { useEffect, useRef, useState } from "react";
import { getAudio, saveAudio, discardStagedAudio, storageSummary } from "@/lib/db";
import { audioKey, replacementProject, sameSource } from "@/lib/library";
import { prepareProjectFile, readStoredSource } from "@/lib/project-import";
import { createLivePlayback, type LivePlaybackController, type LivePlaybackState } from "@/lib/live-playback";
import { useStore } from "@/lib/store";
import type { Track } from "@/lib/types";
import { Button, Modal } from "./Primitives";
import { RealTransport } from "./RealTransport";

export function StorageGuidance({ revision }: { revision: number }) {
  const [summary, setSummary] = useState<Awaited<ReturnType<typeof storageSummary>> | null>(null);
  const [message, setMessage] = useState("");
  useEffect(() => { let active = true; void storageSummary().then((next) => { if (active) setSummary(next); }).catch(() => { if (active) setSummary(null); }); return () => { active = false; }; }, [revision]);
  return <section className="storage-note" aria-label="Browser storage">
    <div><span><strong>Browser storage</strong><small>Audio and settings stay on this device.</small></span></div>
    <div className="min-w-0 max-w-full flex-col items-start gap-2">
      <p className="disclosure">{summary?.usage !== undefined && summary.quota !== undefined ? `This site's estimated storage: ${(summary.usage / 1048576).toFixed(1)} of ${(summary.quota / 1048576).toFixed(0)} MiB.` : "Storage estimates are unavailable in this browser."} {summary?.persistent ? "Persistent storage is granted." : "Browser data may be cleared or evicted. Keep exported backups."}</p>
      <p className="disclosure">Replacement recovery copies remain until the project is deleted. Session-only audio is lost on reload.</p>
      <Button variant="secondary" disabled={summary?.persistent === true} onClick={() => { void (async () => {
        try { const granted = await (navigator as { storage?: Partial<StorageManager> }).storage?.persist?.(); setMessage(granted ? "Persistent storage granted. Keep exported backups." : "The browser did not grant persistent storage. Export backups before clearing browser data."); setSummary(await storageSummary()); }
        catch { setMessage("Persistent storage is unavailable. Export backups before closing this tab."); }
      })(); }}>{summary?.persistent ? "Persistent storage granted" : "Request persistent storage"}</Button>
      {message && <p className="disclosure" role="status">{message}</p>}
    </div>
  </section>;
}

export function SourceRelink({ track, open, onClose }: { track: Track; open: boolean; onClose: () => void }) {
  const { dispatch } = useStore();
  const operation = useRef<AbortController | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [candidate, setCandidate] = useState<{ file: File; imported: Awaited<ReturnType<typeof prepareProjectFile>> } | null>(null);
  useEffect(() => { setBusy(false); setCandidate(null); setMessage(""); setError(""); return () => { const previous = operation.current; operation.current = null; previous?.abort(); }; }, [open, track.id, track.sourceRevision]);
  const close = () => { const current = operation.current; operation.current = null; current?.abort(); onClose(); };
  async function commit(file: File, imported: Awaited<ReturnType<typeof prepareProjectFile>>, controller: AbortController) {
    const matched = sameSource(track.sourceIdentity, imported.measurement.sourceIdentity);
    const id = `source-${crypto.randomUUID()}`;
    const saved = await saveAudio(id, imported.canonical);
    if (controller.signal.aborted || operation.current !== controller) { await discardStagedAudio(id, saved.durable); return; }
    const next = matched ? track : replacementProject(track, file, imported);
    dispatch({ type: "UPDATE_TRACK", id: track.id, patch: { ...next, sourceAudioId: id, sourceRevision: (track.sourceRevision ?? 0) + 1, retiredSourceAudioIds: [...new Set([...(track.retiredSourceAudioIds ?? []), audioKey(track)])], persistenceWarning: saved.durable ? "" : saved.warning } });
    onClose();
  }
  async function select(file: File) {
    operation.current?.abort(); const controller = new AbortController(); operation.current = controller;
    setBusy(true); setError(""); setCandidate(null);
    try {
      const imported = await prepareProjectFile(file, controller.signal, (stage) => { if (operation.current === controller) setMessage(stage); });
      if (controller.signal.aborted || operation.current !== controller) return;
      if (sameSource(track.sourceIdentity, imported.measurement.sourceIdentity)) await commit(file, imported, controller);
      else { setCandidate({ file, imported }); setMessage(track.sourceIdentity ? "This audio differs from the original source." : "This older project has no saved source identity; an exact match cannot be verified."); }
    } catch (cause) { if (operation.current === controller && !controller.signal.aborted) setError(cause instanceof Error ? cause.message : "The source could not be restored."); }
    finally { if (operation.current === controller) setBusy(false); }
  }
  return <Modal open={open} title={`Restore “${track.title}”`} onClose={close} actions={<Button variant="secondary" onClick={close}>{busy ? "Cancel restore" : "Close"}</Button>}>
    <p className="disclosure">Choose the original PCM WAV. An exact canonical audio match keeps all settings. Replacing a different or unverified source preserves the project and album links, validates settings for its sample rate, and clears source-derived results.</p>
    <input ref={input} hidden type="file" accept="audio/wav,.wav" aria-label="Restore audio file" onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; if (file) void select(file); }} />
    <Button variant="secondary" disabled={busy} onClick={() => { input.current?.click(); }}>Choose source WAV</Button>
    {message && <p className="disclosure" role="status">{message}</p>}
    {error && <p role="alert" className="disclosure text-danger">{error}</p>}
    {candidate && <div className="mt-4 space-y-3"><p>{candidate.file.name}</p><p className="disclosure">Replace source explicitly to continue. Previously measured output, scripts and reports will be invalidated. A recovery copy is retained until this project is deleted.</p><Button disabled={busy} onClick={() => { const controller = operation.current; if (!controller) return; setBusy(true); setError(""); void commit(candidate.file, candidate.imported, controller).catch((cause: unknown) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Replacement failed."); }).finally(() => { if (operation.current === controller) setBusy(false); }); }}>Replace source</Button></div>}
  </Modal>;
}

export function LibraryPreview({ track, onClose }: { track: Track; onClose: () => void }) {
  const live = useRef<LivePlaybackController | null>(null);
  const [state, setState] = useState<LivePlaybackState | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController(); let playback: LivePlaybackController | null = null;
    void (async () => {
      const blob = await getAudio(audioKey(track)); controller.signal.throwIfAborted();
      if (!blob) throw new Error("The source is missing. Close preview and restore the audio file.");
      const stored = await readStoredSource(blob, controller.signal); controller.signal.throwIfAborted();
      playback = createLivePlayback(stored.pcm, track.advanced, { onState: (next) => { if (!controller.signal.aborted) setState(next); }, onError: (cause) => { if (!controller.signal.aborted) setError(cause.message); } });
      live.current = playback; setState(playback.getState());
    })().catch((cause: unknown) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Preview failed."); });
    return () => { controller.abort(); playback?.dispose(); live.current = null; };
  }, [track]);
  const seek = (seconds: number) => { live.current?.seek(seconds); };
  return <Modal open title={`Preview “${track.title}”`} onClose={onClose}>
    <p className="disclosure">Listen through this project’s current processing settings. A/B compares the original source.</p>
    {error && <p role="alert" className="disclosure text-danger">{error}</p>}
    <RealTransport inline state={state} sourceReady={live.current !== null} onPlay={async () => { try { await live.current?.play(); } catch (cause) { setError(cause instanceof Error ? cause.message : "Press Play to retry."); } }} onPause={() => { live.current?.pause(); }} onOriginal={(value) => { live.current?.setBypass(value); }} onVolume={(value) => { live.current?.setVolume(value); }} onRestart={() => { seek(0); }} onForward={() => { seek((state?.position ?? 0) + 10); }} onRepeat={(value) => { live.current?.setRepeat(value); }} onScrub={(direction, phase) => { if (phase === "start") seek((state?.position ?? 0) + direction); }} />
  </Modal>;
}
