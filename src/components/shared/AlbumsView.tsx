"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "@/lib/store";
import type { Album, Track } from "@/lib/types";
import { AlbumBatch, albumCohortKey, albumTarget, type AlbumProgress, type AlbumReport } from "@/lib/album-batch";
import { albumTargets, summarizeAlbum } from "@/lib/album-consistency";
import { downloadLocalBlob } from "@/lib/download";
import { reserveBrowserAudioMemory } from "@/lib/browser-jobs";
import { prepareProjectFile, importedTrack } from "@/lib/project-import";
import { saveAudio, discardStagedAudio } from "@/lib/db";
import { Icon } from "./Icon";
import { AlbumConsistencyChart } from "./AlbumConsistencyChart";
import { Artwork, Button, PageTitle, Modal, SliderField, buttonClassName, formatTime } from "./Primitives";
import { WorkspaceLink as Link } from "./WorkspaceLink";

function cohort(album: Album, tracks: Track[]) {
  return album.trackIds.map((id) => tracks.find((track) => track.id === id)).filter((track): track is Track => track !== undefined);
}
function binding(album: Album, tracks: Track[]) {
  try { return { key: albumCohortKey(album, tracks), error: "" }; }
  catch (cause) { return { key: "", error: cause instanceof Error ? cause.message : "The album settings are unavailable." }; }
}
function useSavedReport(album: Album, key: string) {
  const [basis, setBasis] = useState<{ key: string; hash: string } | null>(null);
  useEffect(() => {
    let active = true;
    void crypto.subtle.digest("SHA-256", new TextEncoder().encode(key)).then((bytes) => {
      if (active) setBasis({ key, hash: Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("") });
    }).catch(() => undefined);
    return () => { active = false; };
  }, [key]);
  return key && basis?.key === key && album.report?.bindingHash === basis.hash ? album.report : null;
}

export function AlbumsView() {
  const { state, dispatch } = useStore();
  const [editing, setEditing] = useState<Album | null>(null), [name, setName] = useState("");
  const [deleting, setDeleting] = useState<Album | null>(null);
  function create() {
    dispatch({ type: "ADD_ALBUM", album: { id: `album-${crypto.randomUUID()}`, title: `Untitled sequence ${String(state.albums.length + 1)}`, artist: "", target: "−14 LUFS", trackIds: [], mastered: false, gainMode: "relationships", offsets: {}, updatedAt: new Date().toISOString() } });
  }
  return <div className="page"><PageTitle eyebrow="Sequence and consistency" title="Albums" copy="Shape a collection as one listening experience." action={<Button icon={<Icon name="plus" />} onClick={create}>New album</Button>} />
    {!state.albums.length ? <div className="album-empty paper-panel"><div className="album-art-large"><Icon name="disc" /></div><div><span className="eyebrow">Your first sequence</span><h2>Bring the songs into one room.</h2><p>Create an album to compare loudness, tone, and crest factor across your library.</p><Button onClick={create}>Create an album</Button></div></div>
      : <div className="album-grid">{state.albums.map((album, index) => <AlbumCard key={album.id} album={album} tracks={cohort(album, state.tracks)} index={index} onRename={() => { setEditing(album); setName(album.title); }} onDelete={() => { setDeleting(album); }} />)}</div>}
    <Modal open={editing !== null} title="Rename album" onClose={() => { setEditing(null); }} actions={<><Button variant="secondary" onClick={() => { setEditing(null); }}>Cancel</Button><Button disabled={!name.trim()} onClick={() => { if (editing) dispatch({ type: "UPDATE_ALBUM", id: editing.id, patch: { title: name.trim() } }); setEditing(null); }}>Save name</Button></>}><label className="control-label">Album name<input className="min-h-[44px] w-full" maxLength={256} value={name} onChange={(event) => { setName(event.target.value); }} /></label></Modal>
    <Modal open={deleting !== null} title="Delete this album?" onClose={() => { setDeleting(null); }} actions={<><Button variant="secondary" onClick={() => { setDeleting(null); }}>Keep album</Button><Button variant="danger" onClick={() => { if (deleting) dispatch({ type: "DELETE_ALBUM", id: deleting.id }); setDeleting(null); }}>Delete album</Button></>}><p>Remove “{deleting?.title}” and its saved report. Your library tracks and audio stay available.</p></Modal>
  </div>;
}
function AlbumCard({ album, tracks, index, onRename, onDelete }: { album: Album; tracks: Track[]; index: number; onRename: () => void; onDelete: () => void }) {
  const key = useMemo(() => binding(album, tracks).key, [album, tracks]);
  const report = useSavedReport(album, key), summary = report?.tracks.length ? summarizeAlbum(report.tracks) : null;
  return <article className="album-card"><Link href={`/albums/${album.id}`} className="block min-h-[44px]"><div className={`album-art album-art--${String(index % 3)}`}><span>{String(index + 1).padStart(2, "0")}</span></div><span className="eyebrow">{album.trackIds.length} tracks</span><h2>{album.title}</h2><p>Target {album.target}</p></Link>
    <div className="album-score"><span>Measured loudness spread</span><strong>{summary?.loudnessSpreadLu?.toFixed(1) ?? "—"}{summary?.loudnessSpreadLu !== null && summary?.loudnessSpreadLu !== undefined ? " LU" : ""}</strong></div>
    <p className="disclosure">{report ? `${String(report.tracks.length)}/${String(report.cohortIds.length)} measured masters` : "Render the current sequence to measure its spread."}</p>
    <p className="disclosure">Modified {album.updatedAt && Number.isFinite(Date.parse(album.updatedAt)) ? new Date(album.updatedAt).toLocaleDateString() : "date unavailable"}</p>
    <div className="flex flex-wrap gap-2 mt-3"><Button variant="secondary" onClick={onRename} aria-label={`Rename ${album.title}`}>Rename</Button><Button variant="ghost" onClick={onDelete} aria-label={`Delete ${album.title}`}>Delete</Button></div>
  </article>;
}
export function AlbumView({ albumId }: { albumId: string }) {
  const { state } = useStore();
  const album = state.albums.find((item) => item.id === albumId);
  return album ? <AlbumWorkspace key={album.id} album={album} tracks={cohort(album, state.tracks)} /> : <div className="page"><PageTitle eyebrow="Album workspace" title="No album selected" copy="Create an album first to sequence tracks." action={<Link className={buttonClassName("primary")} href="/albums">Back to albums</Link>} /></div>;
}
function AlbumWorkspace({ album, tracks }: { album: Album; tracks: Track[] }) {
  const { state, dispatch } = useStore();
  const current = useMemo(() => binding(album, tracks), [album, tracks]);
  const saved = useSavedReport(album, current.key);
  const latest = useRef({ album, tracks, key: current.key }); latest.current = { album, tracks, key: current.key };
  const session = useRef<AlbumBatch | null>(null), importing = useRef<AbortController | null>(null);
  const fileInput = useRef<HTMLInputElement>(null), dragged = useRef<string | null>(null);
  const [busy, setBusy] = useState(false), [importBusy, setImportBusy] = useState(false), [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [progress, setProgress] = useState<AlbumProgress | null>(null);
  const [retained, setRetained] = useState<{ key: string; report: AlbumReport | null; files: ReturnType<AlbumBatch["getFiles"]> } | null>(null);
  useEffect(() => {
    session.current?.dispose(); session.current = null;
    importing.current?.abort(); importing.current = null;
    setRetained(null); setProgress(null); setBusy(false); setImportBusy(false);
    return () => { session.current?.dispose(); session.current = null; importing.current?.abort(); importing.current = null; };
  }, [current.key]);
  const owned = retained?.key === current.key ? retained : null, report = owned?.report ?? saved;
  const summary = report?.tracks.length ? summarizeAlbum(report.tracks) : null;
  function download(blob: Blob, filename: string) {
    try { downloadLocalBlob(blob, filename); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "The download could not be started."); }
  }
  function patch(value: Partial<Album>) { dispatch({ type: "UPDATE_ALBUM", id: album.id, patch: value }); }
  function move(id: string, destination: number) {
    const next = [...album.trackIds], index = next.indexOf(id);
    if (index < 0 || destination < 0 || destination >= next.length || index === destination) return;
    next.splice(index, 1); next.splice(destination, 0, id); patch({ trackIds: next });
  }
  async function run() {
    setError("");
    let batch = session.current;
    try {
      if (!batch || !batch.canResume() || batch.key !== current.key) { batch?.dispose(); batch = new AlbumBatch(album, tracks, reserveBrowserAudioMemory); session.current = batch; }
      const owner = batch; setBusy(true);
      const owns = () => session.current === owner && latest.current.key === owner.key;
      const update = (value: AlbumProgress) => {
        if (!owns()) return;
        setProgress(value); setMessage(value.stage); setRetained({ key: owner.key, report: value.report, files: owner.getFiles() });
      };
      try {
        const result = await owner.run(owns, update);
        if (owns()) { setRetained({ key: owner.key, report: result, files: owner.getFiles() }); setMessage("All final 24-bit WAV masters are measured and ready. Save a metadata report or download each retained WAV."); }
      } catch (cause) {
        if (owns()) {
          setRetained({ key: owner.key, report: owner.getReport(), files: owner.getFiles() });
          setError(cause instanceof Error && cause.name !== "AbortError" ? cause.message : "Album render canceled. Verified completed masters remain available; retry continues this unchanged cohort.");
        }
      } finally { if (owns()) setBusy(false); }
    } catch (cause) { setBusy(false); setError(cause instanceof Error ? cause.message : "The album could not be prepared."); }
  }
  async function importFiles(files: readonly File[]) {
    if (!files.length) return;
    importing.current?.abort(); const controller = new AbortController(); importing.current = controller;
    setImportBusy(true); setError("");
    const owner = album;
    try {
      // One file per import keeps cohort ownership explicit; the ordinary library accepts multi-file imports.
      if (files.length !== 1) throw new Error("Choose one WAV at a time here, or import several in the library first.");
      if (album.trackIds.length >= 64) throw new Error("An album can contain at most 64 tracks.");
      const file = files.at(0); if (!file) return;
      const imported = await prepareProjectFile(file, controller.signal, (stage) => { if (!controller.signal.aborted) setMessage(stage); });
      controller.signal.throwIfAborted();
      const track = importedTrack(file, imported), saved = await saveAudio(track.id, imported.canonical);
      if (controller.signal.aborted || importing.current !== controller || latest.current.album !== owner) { await discardStagedAudio(track.id, saved.durable); return; }
      track.persistenceWarning = saved.durable ? "" : saved.warning;
      dispatch({ type: "IMPORT_ALBUM_TRACK", expected: owner, track });
      setMessage(`Imported “${track.title}”. ${saved.durable ? "Audio is stored in this browser." : saved.warning}`);
    } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "The WAV could not be imported."); }
    finally { if (importing.current === controller) { importing.current = null; setImportBusy(false); } }
  }
  const active = busy || importBusy;
  return <div className="page"><h1 className="sr-only">Album mastering workspace</h1>
    <section className="album-hero"><div className="album-art-large"><Icon name="disc" /></div><div><span className="eyebrow">Album workspace</span>
      <input className="title-input" aria-label="Album title" maxLength={256} value={album.title} onChange={(event) => { patch({ title: event.target.value }); }} />
      <input className="artist-input" aria-label="Album artist or release note" maxLength={1024} value={album.artist} placeholder="Add artist or release note" onChange={(event) => { patch({ artist: event.target.value }); }} />
      <div className="album-meta"><span>{album.trackIds.length} tracks</span><span>{album.target}</span><span>{report?.complete ? "Measured sequence" : "In progress"}</span></div>
    </div><Button icon={<Icon name="sparkles" />} disabled={active || !tracks.length || !!current.error} onClick={() => void run()}>{busy ? "Rendering sequence…" : "Render album masters"}</Button></section>
    <section className="paper-panel p-5 space-y-4" aria-label="Album gain settings"><div className="grid gap-4 md:grid-cols-2">
      <label className="control-label">Album target<select className="min-h-[44px] w-full min-w-0 max-w-full" aria-label="Album target" value={albumTarget(album)} onChange={(event) => { patch({ target: `${event.target.value.replace("-", "−")} LUFS` }); }}>{albumTargets.map((target) => <option key={target} value={target}>{target} LUFS</option>)}</select></label>
      <label className="control-label">Gain mode<select className="min-h-[44px] w-full min-w-0 max-w-full" aria-label="Album gain mode" value={album.gainMode ?? "relationships"} onChange={(event) => { const value = event.target.value; if (value === "relationships" || value === "normalize" || value === "manual") patch({ gainMode: value }); }}><option value="relationships">Preserve level relationships (shared gain)</option><option value="normalize">Normalize tracks individually (optional)</option><option value="manual">Manual offsets only (no loudness normalization)</option></select></label>
    </div><p className="disclosure">Default shared gain moves the median track toward your target while preserving level differences. The target is capped by the tightest finite peak estimate at −1 dBTP with 0.01 dB encoding margin; supported gain is ±36 dB. A capped target may remain unmet. No tone, compression or limiting is added.</p>
    <p className="disclosure">Each accepted full chain, including applied Deep automation, is rendered before album gain. Individual mastering settings stay unchanged. Silent or shorter-than-0.4-second tracks are excluded from the loudness basis; manual offsets remain available.</p></section>
    {busy && <Button variant="secondary" onClick={() => { session.current?.cancel(); setMessage("Canceling the current track…"); }}>Cancel album render</Button>}
    {importBusy && <Button variant="secondary" onClick={() => { importing.current?.abort(); setImportBusy(false); }}>Cancel album import</Button>}
    <p className="disclosure" role={error || current.error ? "alert" : "status"}>{current.error || error || message || "Render the sequence to measure final encoded WAVs, then review each transition."}</p>
    {progress && <p className="disclosure" aria-live="polite">{progress.completed} of {progress.total} verified masters. {busy ? progress.stage : ""}</p>}
    {report && <section className="paper-panel p-5 space-y-3" aria-label="Rendered album downloads"><h2>{report.complete ? "Your album masters" : "Verified partial sequence"}</h2><p className="disclosure">{owned?.files.length ? "Downloads use the exact retained measured WAVs. Cancel or retry keeps this verified prefix while the entire cohort remains unchanged." : "Saved measurements restored. Render again to restore WAV downloads; a saved report contains metadata only."}</p>
      {report.commonGainDb !== null && <p className="disclosure">Shared gain: {report.commonGainDb.toFixed(2)} dB. Planning median track: {report.medianTrackLufs?.toFixed(2) ?? "Unavailable"} LUFS (not album-integrated).</p>}
      <div className="flex flex-wrap gap-2">{owned?.files.map((file) => <Button key={file.id} variant="secondary" className="max-w-full whitespace-normal [overflow-wrap:anywhere]" onClick={() => { download(file.wav, `${file.title.replace(/[^a-zA-Z0-9_-]/gu, "-") || "aurialis"}-album-master.wav`); }}>Download {file.title}</Button>)}
        <Button variant="secondary" onClick={() => { download(new Blob([JSON.stringify({ ...report, measurementBasis: "decoded final 24-bit encoded WAVs", limitations: "Finite reconstructed-peak estimates; descriptive 2 LU and 3 dB working flags. No certification, automatic tone/dynamics change, resampling, metadata, codec or DDP delivery." }, null, 2)], { type: "application/json" }), "aurialis-album-report.json"); }}>Download album JSON report</Button>
        <Button variant="secondary" disabled={active} onClick={() => { dispatch({ type: "SAVE_ALBUM_REPORT", expected: album, tracks, report }); }}>Save album report</Button>
      </div></section>}
    <div className="album-layout"><section className="paper-panel"><div className="section-heading"><div><span className="eyebrow">Running order</span><h2>The sequence</h2></div></div>
      <div className="album-track-list">{tracks.map((track, index) => {
        const row = report?.tracks.find((item) => item.id === track.id), diagnostic = summary?.tracks.find((item) => item.id === track.id);
        return <div key={track.id} draggable={!active} onDragStart={() => { dragged.current = track.id; }} onDragEnd={() => { dragged.current = null; }} onDragOver={(event) => { event.preventDefault(); }} onDrop={(event) => { event.preventDefault(); const id = dragged.current; dragged.current = null; if (id && !active) move(id, index); }}>
          <span>{String(index + 1).padStart(2, "0")}</span><Artwork seed={track.seed} /><div><Link className="inline-flex min-h-[44px] items-center" href={`/master/${track.id}`}><strong>{track.title}</strong></Link><small>{formatTime(track.duration)} · {row ? `${row.metrics.integratedLufs.toFixed(1)} LUFS · ${row.metrics.truePeakDbtp.toFixed(2)} dBTP estimate · ${row.metrics.dynamicRangeDb.toFixed(1)} dB crest` : "Final master unmeasured"}</small><small>{row ? `Tone deviation ${diagnostic?.tonalDeviationDb?.toFixed(2) ?? "unavailable"} dB · Gain ${row.gain.gainDb.toFixed(2)} dB · ${row.gain.limitedBy ? `Gain limited by ${row.gain.limitedBy === "peak" ? "peak headroom" : "gain range"}` : "Verified output"}` : "Awaiting measured render"}</small>{diagnostic?.findings.map((finding) => <p key={finding} className="disclosure">Review: {finding}</p>)}{row && row.metrics.truePeakDbtp > -1 && <p className="disclosure">Review: final finite peak estimate exceeds −1 dBTP; the target was not guaranteed.</p>}{row && row.output.encoding.fullScaleFrames > 0 && <p className="disclosure">Review: final encoding contains full-scale frames.</p>}{row && <p className="disclosure break-all">WAV SHA-256: {row.output.sha256}</p>}</div>
          <div className="album-row-actions min-w-0 [&_label]:min-w-0 [&_label]:[overflow-wrap:anywhere] [&_strong]:shrink-0"><SliderField label={`Manual gain for ${track.title}`} defaultValue={0} value={album.offsets?.[track.id] ?? 0} min={-6} max={6} step={0.1} unit="dB" onChange={(value) => { patch({ offsets: { ...album.offsets, [track.id]: value } }); }} />
            <div className="flex flex-wrap gap-1"><Button variant="ghost" disabled={active || index === 0} aria-label={`Move ${track.title} up`} onClick={() => { move(track.id, index - 1); }}><Icon name="arrow-left" style={{ transform: "rotate(90deg)" }} /></Button><Button variant="ghost" disabled={active || index === tracks.length - 1} aria-label={`Move ${track.title} down`} onClick={() => { move(track.id, index + 1); }}><Icon name="arrow-right" style={{ transform: "rotate(90deg)" }} /></Button><Button variant="ghost" disabled={active} aria-label={`Remove ${track.title} from album`} onClick={() => { patch({ trackIds: album.trackIds.filter((id) => id !== track.id) }); }}><Icon name="x" /></Button></div></div>
        </div>;
      })}</div>
      <div className="add-tracks"><span className="eyebrow">Add from library</span>{state.tracks.filter((track) => !album.trackIds.includes(track.id)).map((track) => <button type="button" key={track.id} className="max-w-full whitespace-normal [overflow-wrap:anywhere]" disabled={active || album.trackIds.length >= 64} onClick={() => { patch({ trackIds: [...album.trackIds, track.id] }); }}><Icon name="plus" />{track.title}</button>)}
        <input ref={fileInput} type="file" hidden accept="audio/wav,.wav" aria-label="Import album audio" onChange={(event) => { const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ""; void importFiles(files); }} /><Button variant="secondary" disabled={active || album.trackIds.length >= 64} onClick={() => { fileInput.current?.click(); }}>Import a WAV to this album</Button>
      </div><p className="disclosure">Drag tracks to reorder on desktop, or use the move buttons with keyboard or touch. Up to 64 tracks and 128 MiB of retained 24-bit masters. Rendering runs one track at a time; device memory can require a smaller cohort.</p>
    </section><AlbumConsistencyChart readings={report?.tracks ?? []} /></div>
  </div>;
}
