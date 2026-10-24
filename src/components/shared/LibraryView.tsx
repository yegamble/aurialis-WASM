"use client";

import { WorkspaceLink as Link } from "./WorkspaceLink";
import { useEffect, useRef, useState } from "react";
import { deleteAudio } from "@/lib/db";
import { audioKey, duplicateProject, sortedTracks, type LibrarySort } from "@/lib/library";
import { useStore } from "@/lib/store";
import type { Track } from "@/lib/types";
import { Artwork, BottomSheet, Button, buttonClassName, formatTime, Modal, PageTitle, StatusBadge, statusLabel } from "./Primitives";
import { Icon } from "./Icon";
import { LibraryPreview, SourceRelink, StorageGuidance } from "./LibraryTools";
import { LegacyLibraryRecovery } from "./LegacyLibraryRecovery";

function ownedKeys(track: Track): string[] { return [...new Set([track.id, audioKey(track), ...(track.retiredSourceAudioIds ?? [])])]; }
export function LibraryView() {
  const { state, dispatch } = useStore();
  const latest = useRef(state); latest.current = state;
  const operation = useRef<AbortController | null>(null);
  useEffect(() => () => { operation.current?.abort(); }, []);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("All");
  const [sort, setSort] = useState<LibrarySort>("recent");
  const [selectedId, setSelectedId] = useState("");
  const selected = state.tracks.find((track) => track.id === selectedId);
  const [preview, setPreview] = useState<Track | null>(null);
  const [restore, setRestore] = useState<Track | null>(null);
  const [albumTrack, setAlbumTrack] = useState<Track | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Track | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [storageRevision, setStorageRevision] = useState(0);
  const tracks = sortedTracks(state.tracks.filter((track) => track.title.toLowerCase().includes(query.toLowerCase()) && (filter === "All" || statusLabel(track.status) === filter.toLowerCase())), sort);
  async function duplicate(track: Track) {
    operation.current?.abort(); const controller = new AbortController(); operation.current = controller;
    setBusy(true); setError(""); setSelectedId("");
    try {
      const copied = await duplicateProject(track, controller.signal);
      controller.signal.throwIfAborted();
      dispatch({ type: "ADD_TRACK", track: copied });
      setStorageRevision((value) => value + 1);
      setMessage(`Created “${copied.title}” with independent settings and source storage.${copied.persistenceWarning ? ` ${copied.persistenceWarning}` : ""}`);
    } catch (cause) { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Duplication failed."); }
    finally { if (!controller.signal.aborted) setBusy(false); }
  }
  async function remove(track: Track) {
    setBusy(true); setError("");
    try {
      for (const key of ownedKeys(track)) {
        if (!latest.current.tracks.some((other) => other.id !== track.id && ownedKeys(other).includes(key))) await deleteAudio(key);
      }
      dispatch({ type: "DELETE_TRACK", id: track.id });
      setPendingDelete(null); setStorageRevision((value) => value + 1); setMessage(`Deleted “${track.title}” and its unshared source and recovery audio.`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Audio deletion failed. The project was kept so you can retry or restore its source."); }
    finally { setBusy(false); }
  }
  const addToAlbum = (id: string) => {
    if (!albumTrack) return;
    const album = state.albums.find((item) => item.id === id);
    if (album && !album.trackIds.includes(albumTrack.id)) dispatch({ type: "UPDATE_ALBUM", id, patch: { trackIds: [...album.trackIds, albumTrack.id] } });
    setAlbumTrack(null); setMessage("Project added to the album.");
  };
  return <div className="page">
    <PageTitle eyebrow="Your local archive" title="Library" copy={`${String(state.tracks.length)} projects stored only in this browser.`} action={<Link className={buttonClassName("primary")} href="/"><Icon name="plus" />New project</Link>} />
    <div className="library-tools">
      <label className="search-field"><Icon name="search" /><input value={query} aria-label="Search your library" onChange={(event) => { setQuery(event.target.value); }} placeholder="Search your library" /></label>
      <label className="grid min-w-0 gap-1 text-xs">Sort projects<select className="min-h-[44px] max-w-full rounded-xl border border-line-dark bg-paper px-3" aria-label="Sort projects" value={sort} onChange={(event) => { const value = event.target.value; if (value === "recent" || value === "name" || value === "duration") setSort(value); }}><option value="recent">Recently modified</option><option value="name">Name</option><option value="duration">Duration</option></select></label>
      <div className="filter-row" role="group" aria-label="Filter projects by status">{["All", "Draft", "Ready", "Mastered", "Needs review"].map((item) => <Button key={item} variant="secondary" className={filter === item ? "chip is-active" : "chip"} aria-pressed={filter === item} onClick={() => { setFilter(item); }}>{item}</Button>)}</div>
    </div>
    {message && <p className="disclosure" role="status">{message}</p>}
    {error && <p className="disclosure text-danger" role="alert">{error}</p>}
    <div className="library-list">
      <div className="library-list-head"><span>Project</span><span>Format</span><span>Saved LUFS</span><span>Modified</span><span /></div>
      {!tracks.length && <p className="py-8 text-sm">{state.tracks.length ? "No projects match this search and filter." : "Import a WAV, FLAC or MP3 to start your library."}</p>}
      {tracks.map((track, index) => <div className="library-item" key={track.id}>
        <Link className="library-project" href={`/master/${track.id}`}><Artwork seed={track.seed} index={index} /><span><strong>{track.title}</strong><small>{formatTime(track.duration)} · <StatusBadge status={track.status} /></small></span></Link>
        <span>{track.format}<small>{track.sampleRate / 1000} kHz</small></span>
        <span className="metric-number">{track.measurements ? track.metrics.lufs.toFixed(1) : "Unmeasured"}<small>{track.measurementKind === "source" ? "Source LUFS" : track.measurementKind === "album-render" ? "Album render LUFS" : "Saved LUFS"}</small></span>
        <span>{new Date(track.updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}<small>Local</small></span>
        <Button variant="secondary" className="!px-0" disabled={busy} aria-label={`Actions for ${track.title}`} onClick={() => { setSelectedId(track.id); }}><Icon name="settings" /></Button>
      </div>)}
    </div>
    <StorageGuidance revision={storageRevision + state.tracks.length} />
    <LegacyLibraryRecovery />
    <BottomSheet open={!!selected} title={selected ? `Project actions: ${selected.title}` : "Project actions"} onClose={() => { setSelectedId(""); }}>
      {selected && <div className="grid gap-2">
        <Button variant="secondary" onClick={() => { setPreview(selected); setSelectedId(""); }}>Preview {selected.title}</Button>
        <Button variant="secondary" onClick={() => { void duplicate(selected); }}>Duplicate settings</Button>
        <Button variant="secondary" onClick={() => { setAlbumTrack(selected); setSelectedId(""); }}>Add to album</Button>
        <Button variant="secondary" onClick={() => { setRestore(selected); setSelectedId(""); }}>Restore source</Button>
        <Button variant="danger" onClick={() => { setPendingDelete(selected); setSelectedId(""); }}>Delete {selected.title}</Button>
      </div>}
    </BottomSheet>
    {preview && <LibraryPreview track={preview} onClose={() => { setPreview(null); }} />}
    {restore && <SourceRelink track={state.tracks.find((track) => track.id === restore.id) ?? restore} open onClose={() => { setRestore(null); setStorageRevision((value) => value + 1); }} />}
    <Modal open={!!albumTrack} title="Add project to album" onClose={() => { setAlbumTrack(null); }}>
      <div className="grid gap-2">{state.albums.map((album) => <Button key={album.id} variant="secondary" onClick={() => { addToAlbum(album.id); }}>{album.title}</Button>)}<Button onClick={() => { if (!albumTrack) return; dispatch({ type: "ADD_ALBUM", album: { id: `album-${crypto.randomUUID()}`, title: `Untitled sequence ${String(state.albums.length + 1)}`, artist: "", target: "−14 LUFS", trackIds: [albumTrack.id], mastered: false } }); setAlbumTrack(null); setMessage("Album created with this project."); }}>New album with this project</Button></div>
    </Modal>
    <Modal open={!!pendingDelete} eyebrow="Confirm removal" title={pendingDelete ? `Delete “${pendingDelete.title}”?` : "Delete project"} onClose={() => { if (!busy) setPendingDelete(null); }} actions={<><Button variant="secondary" disabled={busy} onClick={() => { setPendingDelete(null); }}>Cancel</Button><Button variant="danger" disabled={busy} onClick={() => { if (pendingDelete) void remove(pendingDelete); }}>{busy ? "Removing audio…" : "Delete project"}</Button></>}>
      <p>This removes the project, its album links and its unshared source and recovery audio after storage confirms deletion.</p>
      {error && <p role="alert" className="disclosure text-danger">{error}</p>}
    </Modal>
  </div>;
}
