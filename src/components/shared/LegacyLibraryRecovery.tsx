"use client";

import { useEffect, useRef, useState } from "react";
import { reserveBrowserAudioMemory } from "@/lib/browser-jobs";
import { discardStagedAudio, newAudioAssetId, saveAudio } from "@/lib/db";
import { readLegacyWav, scanLegacySources, type LegacyPage, type LegacySource } from "@/lib/legacy-library";
import { importedTrack, prepareProjectFile } from "@/lib/project-import";
import { useStore } from "@/lib/store";
import { Button, Modal } from "./Primitives";

export function LegacyLibraryRecovery() {
  const { dispatch } = useStore();
  const operation = useRef<AbortController | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [page, setPage] = useState<LegacyPage | null>(null);
  const [recovered, setRecovered] = useState<readonly string[]>([]);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  useEffect(() => () => { operation.current?.abort(); }, []);
  function start(): AbortController | null {
    if (operation.current) return null;
    const controller = new AbortController(); operation.current = controller;
    setBusy(true); setError(""); setMessage("");
    return controller;
  }
  function finish(controller: AbortController) {
    if (operation.current !== controller) return;
    operation.current = null; setBusy(false);
  }
  async function scan(after: string | null = null) {
    const controller = start(); if (!controller) return;
    setOpen(true);
    try {
      const next = await scanLegacySources(controller.signal, after);
      controller.signal.throwIfAborted();
      setPage(next); setRecovered([]);
      setMessage(next.sources.length ? `Showing ${String(next.sources.length)} saved source files on this page.` : next.next ? "No saved source files on this page. Continue to the next page." : "No more old source files were found at this site address.");
    } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "The old library could not be read."); }
    finally { finish(controller); }
  }
  async function recover(source: LegacySource) {
    const controller = start(); if (!controller) return;
    let staged: { id: string; durable: boolean } | null = null;
    let owner: ReturnType<typeof reserveBrowserAudioMemory> | undefined;
    try {
      owner = reserveBrowserAudioMemory(source.size);
      const selected = await readLegacyWav(source, controller.signal);
      const imported = await prepareProjectFile(selected.file, controller.signal, (stage) => { if (!controller.signal.aborted) setMessage(stage); });
      // Retain original snapshot, canonical Blob and its possible storage copy.
      // Header validation no longer allocates full-length PCM validation buffers.
      owner.update(source.size + imported.canonical.size * 2);
      await selected.verify();
      controller.signal.throwIfAborted();
      const id = newAudioAssetId("track");
      const saved = await saveAudio(id, imported.canonical, false);
      staged = { id, durable: saved.durable };
      await selected.verify();
      controller.signal.throwIfAborted();
      dispatch({ type: "ADD_TRACK", track: importedTrack(selected.file, imported, id) });
      staged = null;
      setRecovered((keys) => [...keys, source.key]);
      setMessage(`Recovered “${source.name}” as a new project with default settings. Its old original and settings are retained.`);
    } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Recovery failed. The old original is retained."); }
    finally {
      if (staged) {
        try { await discardStagedAudio(staged.id, staged.durable); }
        catch { setError("Recovery stopped, but the new temporary copy could not be removed. The old original is retained. Retry after freeing browser storage."); }
      }
      owner?.dispose();
      finish(controller);
    }
  }
  function cancel() { operation.current?.abort(); setMessage("Recovery canceled. Old originals and settings are retained."); }
  return <section className="storage-note" aria-label="Old Aurialis library recovery">
    <div><span><strong>Used the previous Aurialis?</strong><small>Recover local WAV sources from this browser.</small></span></div>
    <div className="min-w-0 max-w-full flex-col items-start gap-2">
      <p className="disclosure">Old projects stay in their original storage. Recovery creates new projects from selected WAV sources; old mastering settings are retained separately.</p>
      <Button variant="secondary" disabled={busy} onClick={() => { void scan(); }}>Find old projects</Button>
    </div>
    <Modal open={open} title="Recover old local sources" onClose={() => { cancel(); setOpen(false); }} actions={<Button variant="secondary" onClick={() => { if (busy) cancel(); else setOpen(false); }}>{busy ? "Cancel recovery" : "Close"}</Button>}>
      <p className="disclosure">This finds saved source files and reads only the audio you select from this site’s browser storage. Saved scripts and settings are never loaded or applied. The old audio is retained.</p>
      <p className="disclosure">WAV recovery supports the current source limits. Compressed originals need a separate recovery path and remain in old storage. Recovery is specific to this browser profile and site address; check each address you used before clearing browser data.</p>
      {message && <p role="status" className="disclosure">{message}</p>}
      {error && <p role="alert" className="disclosure text-danger">{error}</p>}
      {!!page?.skipped && <p className="disclosure">Skipped {page.skipped} invalid or unsupported saved records on this page. Their old records are retained.</p>}
      {page?.stopped && <p role="alert" className="disclosure">Some old records exceed the recovery read limit. More files may remain. Their old storage is retained.</p>}
      <ul className="my-4 grid min-w-0 list-none gap-3 p-0" aria-label="Old source files">
        {page?.sources.map((source) => <li key={source.key} className="grid min-w-0 gap-2 rounded-xl border border-line-dark p-3">
          <strong className="min-w-0 break-words [overflow-wrap:anywhere]">{source.name}</strong>
          <span className="disclosure">{(source.size / 1048576).toFixed(1)} MiB · original source</span>
          <Button variant="secondary" disabled={busy || recovered.includes(source.key)} onClick={() => { void recover(source); }} aria-label={`Recover WAV: ${source.name}`}>{recovered.includes(source.key) ? "Recovered; old copy retained" : "Recover WAV source"}</Button>
        </li>)}
      </ul>
      {page?.next && <Button variant="secondary" disabled={busy} onClick={() => { void scan(page.next); }}>Next saved files</Button>}
    </Modal>
  </section>;
}
