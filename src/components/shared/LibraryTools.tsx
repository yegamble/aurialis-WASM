"use client";

import { useEffect, useRef, useState } from "react";
import { getAudio, saveAudio, discardStagedAudio, storageSummary, newAudioAssetId } from "@/lib/db";
import { audioKey, replacementProject, sameSource } from "@/lib/library";
import { prepareProjectFile, readStoredSource, SOURCE_ACCEPT } from "@/lib/project-import";
import { createLivePlayback, type LivePlaybackController, type LivePlaybackState } from "@/lib/live-playback";
import { useTransportScrub } from "@/lib/use-transport-scrub";
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
  const { state: projects, dispatch } = useStore();
  const latest = useRef(projects); latest.current = projects;
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
    if ((track.retiredSourceAudioIds?.length ?? 0) >= 64) throw new Error("This project has reached its recovery-copy limit. Duplicate its current settings or delete old projects before replacing more sources.");
    const id = newAudioAssetId("source");
    const saved = await saveAudio(id, imported.canonical);
    if (controller.signal.aborted || operation.current !== controller) { await discardStagedAudio(id, saved.durable); return; }
    const current = latest.current.tracks.find((item) => item.id === track.id);
    if (!current || (current.sourceRevision ?? 0) !== (track.sourceRevision ?? 0) || audioKey(current) !== audioKey(track)) { await discardStagedAudio(id, saved.durable); throw new Error("The project source changed. Close and retry source recovery."); }
    const next = matched ? current : replacementProject(current, file, imported);
    dispatch({ type: "COMMIT_TRACK_SOURCE", id: track.id, expectedRevision: track.sourceRevision ?? 0, expectedAudioKey: audioKey(track), track: { ...next, ...(matched && next.deepMastering ? { deepMastering: { ...next.deepMastering, sourceRevision: (track.sourceRevision ?? 0) + 1 } } : {}), sourceAudioId: id, sourceRevision: (track.sourceRevision ?? 0) + 1, retiredSourceAudioIds: [...new Set([...(track.retiredSourceAudioIds ?? []), audioKey(track)])], persistenceWarning: saved.durable ? "" : saved.warning } });
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
    <p className="disclosure">Choose the original WAV, AIFF, FLAC or MP3. An exact canonical audio match keeps all settings. Replacing a different or unverified source preserves the project and album links, validates settings for its sample rate, and clears source-derived results.</p>
    <input ref={input} hidden type="file" accept={SOURCE_ACCEPT} aria-label="Restore audio file" onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ""; if (file) void select(file); }} />
    <Button variant="secondary" disabled={busy} onClick={() => { input.current?.click(); }}>Choose source audio</Button>
    {message && <p className="disclosure" role="status">{message}</p>}
    {error && <p role="alert" className="disclosure text-danger">{error}</p>}
    {candidate && <div className="mt-4 space-y-3"><p>{candidate.file.name}</p><p className="disclosure">Replace source explicitly to continue. Previously measured output, scripts and reports will be invalidated. A recovery copy is retained until this project is deleted.</p><Button disabled={busy} onClick={() => { const controller = operation.current; if (!controller) return; setBusy(true); setError(""); void commit(candidate.file, candidate.imported, controller).catch((cause: unknown) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Replacement failed."); }).finally(() => { if (operation.current === controller) setBusy(false); }); }}>Replace source</Button></div>}
  </Modal>;
}

export function LibraryPreview({ track, onClose }: { track: Track; onClose: () => void }) {
  const live = useRef<LivePlaybackController | null>(null);
  const [state, setState] = useState<LivePlaybackState | null>(null);
  const [error, setError] = useState("");
  const { stopScrub, onScrub } = useTransportScrub(live, { available: () => true, resume: () => { void live.current?.play().catch((cause: unknown) => { setError(cause instanceof Error ? cause.message : "Press Play to resume."); }); } });
  useEffect(() => {
    const controller = new AbortController(); let playback: LivePlaybackController | null = null;
    void (async () => {
      const blob = await getAudio(audioKey(track)); controller.signal.throwIfAborted();
      if (!blob) throw new Error("The source is missing. Close preview and restore the audio file.");
      const stored = await readStoredSource(blob, controller.signal); controller.signal.throwIfAborted();
      playback = createLivePlayback(stored.pcm, track.advanced, { onState: (next) => { if (!controller.signal.aborted) setState(next); }, onError: (cause) => { if (!controller.signal.aborted) setError(cause.message); } }, track.sourceIdentity ? { blob: stored.blob, identity: track.sourceIdentity, ...(track.deepMastering?.applied ? { applied: track.deepMastering.applied } : {}) } : undefined);
      live.current = playback; setState(playback.getState());
    })().catch((cause: unknown) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Preview failed."); });
    return () => { controller.abort(); stopScrub(false); playback?.dispose(); live.current = null; };
  }, [track]);
  const seek = (seconds: number) => { stopScrub(false); live.current?.seek(seconds); };
  return <Modal open title={`Preview “${track.title}”`} onClose={onClose}>
    <p className="disclosure">Listen through this project’s current processing settings. A/B compares the original source.</p>
    {error && <p role="alert" className="disclosure text-danger">{error}</p>}
    <RealTransport inline state={state} sourceReady={live.current !== null} onPlay={async () => { try { stopScrub(false); await live.current?.play(); } catch (cause) { setError(cause instanceof Error ? cause.message : "Press Play to retry."); } }} onPause={() => { stopScrub(false); live.current?.pause(); }} onOriginal={(value) => { live.current?.setBypass(value); }} onVolume={(value) => { live.current?.setVolume(value); }} onRestart={() => { seek(0); }} onForward={() => { seek((state?.position ?? 0) + 10); }} onRepeat={(value) => { live.current?.setRepeat(value); }} onScrub={onScrub} />
  </Modal>;
}
