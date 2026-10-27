"use client";

import { WorkspaceLink as Link } from "./shared/WorkspaceLink";
import {
  engineParams,
  measureAudio,
  normalizeSimpleAudio,
  exportLevelSummary,
  processPreview,
  previewWAV,
  renderDelivery,
  serverRenderScript,
  readCanonicalWAV,
  sourcePeaks,
  type StereoPCM,
} from "@/lib/browser-engine";
import { reserveBrowserAudioMemory } from "@/lib/browser-jobs";
import { exportRender } from "@/lib/engine-params";
import { downloadLocalBlob } from "@/lib/download";
import { clearNextPlaybackHandoff, reconcileNextPlaybackHandoff, stageNextPlaybackHandoff, takeNextPlaybackHandoff } from "@/lib/playback-handoff";
import { bindPlaybackControls } from "@/lib/media-session";
import { ExtendedCompressorControls, ExtendedStereoControls, FrequencyDynamicsControls, MasteringShortcuts } from "./shared/AdvancedDynamics";
import { DSPModule } from "./shared/DSPModule";
import { EQBandControls, LimiterReleaseControl } from "./shared/EQBandControls";
import { RealTransport } from "./shared/RealTransport";
import { ReleaseReview } from "./shared/ReleaseReview";
import { createLivePlayback, type LiveMeter, type LivePlaybackController, type LivePlaybackState, type LiveSpectrum } from "@/lib/live-playback";
import { usePathname } from "next/navigation";
import { navigateWorkspace, useWorkspacePath, workspaceRoute, type WorkstationRoute } from "@/lib/workspace-navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useId,
  useRef,
  useState,
  type DragEvent,
} from "react";
import {
  createDefaultAdvancedParams,
  clampAdvancedToSampleRate,
  MAX_LIMITER_CEILING_DB,
} from "@/lib/audio-dsp";
import { saveAudio, getAudio, discardStagedAudio, deleteAudio, newAudioAssetId, loadAlbumMasters, saveAlbumMasters, deleteAlbumMasters, ensureStorageFor, type SavedAlbumMasters } from "@/lib/db";
import { albumEntryNames, createStoredZip, safeFileBaseName } from "@/lib/zip";
import { useStore } from "@/lib/store";
import type {
  Album,
  AdvancedParams,
  EQBandId,
  SaturationCharacter,
  Track,
} from "@/lib/types";
import { albumRateChoices, albumRateNote, exportRateChoices, formatRate, unavailableRateNote } from "@/lib/export-rates";
import { availableDelivery, CD_DELIVERY, DEFAULT_DELIVERY, deliveredBytes, deliveredRate, deliveryRequest, deliverySummary, type DeliveryFormat } from "@/lib/delivery-format";
import { DeliveryFormatControls } from "./shared/DeliveryFormatControls";
import { MAX_SOURCE_FRAMES } from "@/lib/audio-limits";
import { Icon, type IconName } from "./shared/Icon";
import {
  Artwork,
  BottomSheet,
  Button,
  buttonClassName,
  ChoiceGroup,
  ControlGroup,
  Modal,
  PageTitle,
  SliderField,
  SpectrumChart,
  LiveSpectrumChart,
  Waveform,
  formatTime,
  StatusBadge,
} from "./shared/Primitives";

import { readStoredSource, prepareProjectFile, importedTrack, isSourceFileName, SOURCE_ACCEPT } from "@/lib/project-import";
import { LibraryView } from "./shared/LibraryView";
import { SourceRelink } from "./shared/LibraryTools";
import { useTransportScrub } from "@/lib/use-transport-scrub";
import { audioKey } from "@/lib/library";
import { FeatureAnalysisPanel } from "./shared/FeatureAnalysisPanel";
import { ReferenceMatchingPanel } from "./shared/ReferenceMatchingPanel";
import { SimpleControls } from "./shared/SimpleControls";
import { DeepProposalPanel } from "./shared/DeepProposalPanel";
import { useDeepPlayback } from "@/lib/use-deep-playback";
import { appliedRevisionKey } from "@/lib/deep-mastering";
import { ALBUM_OFFSET_LIMIT_DB, ALBUM_TARGETS, albumLevelSummary, albumMastersKey, albumOffset, DEFAULT_ALBUM_LEVEL, planAlbumLevels, renderAlbumTrack, withAlbumOffset, type AlbumLevel, type AlbumMasterLevel, type AlbumRenderEngine } from "@/lib/album-levels";
import { AlbumLevelChart, type MeasuredAlbumMaster } from "./shared/AlbumLevelChart";
import type { ScriptV2 } from "@/lib/deep-mastering";
import { DeepTimeline } from "./shared/DeepTimeline";
import { StemSplitPanel } from "./shared/StemSplitPanel";
import { processingCopy, useBrowserBuild } from "@/lib/build-mode";
import { STEM_SPLIT_PITCH, stemSplitAvailability } from "@/lib/stem-split-copy";
import { timeConstantMs } from "@/lib/control-conventions";






function resolveDynamicId(
  propId: string | undefined,
  pathname: string | null,
  fallbackId: string,
): string {
  if (pathname) {
    const parts = pathname.split("/").filter(Boolean);
    const candidate = parts[1];
    if (candidate && candidate !== "placeholder") {
      return decodeURIComponent(candidate);
    }
  }
  if (propId && propId !== "placeholder") {
    return propId;
  }
  return fallbackId;
}

export function AurialisWorkstation({
  route: initialRoute,
  paramId,
}: {
  route: WorkstationRoute;
  paramId?: string;
}) {
  const pathname = usePathname();
  const { state } = useStore();
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const livePath = useWorkspacePath(pathname);
  const route = livePath ? workspaceRoute(livePath) ?? initialRoute : initialRoute;
  const main = useRef<HTMLElement>(null);
  const previousPath = useRef<string | null>(null);
  useEffect(() => {
    const heading = main.current?.querySelector("h1");
    document.title = `${heading?.textContent ?? "Mastering, made human"} — Aurialis`;
    if (previousPath.current !== null && previousPath.current !== livePath) {
      window.scrollTo({ top: 0, left: 0, behavior: "instant" });
      if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
    }
    previousPath.current = livePath;
  }, [livePath, state.tracks.length]);

  const inWorkspace = route === "master";
  const defaultTrackId = state.tracks[0]?.id ?? "placeholder";
  const resolvedId = resolveDynamicId(paramId, livePath, defaultTrackId);
  useEffect(() => {
    reconcileNextPlaybackHandoff(route, resolveDynamicId(undefined, window.location.pathname, resolvedId));
  }, [route, resolvedId]);

  const navItems: {
    href: string;
    label: string;
    icon: IconName;
    active: boolean;
  }[] = [
    {
      href: "/",
      label: "Home",
      icon: "disc",
      active: route === "home",
    },
    {
      href: "/library",
      label: "Library",
      icon: "library",
      active: route === "library" || route === "master",
    },
    {
      href: "/albums",
      label: "Albums",
      icon: "album",
      active: route === "albums" || route === "album",
    },
    {
      href: "/tools",
      label: "Tools",
      icon: "wand-sparkles",
      active:
        route === "tools" ||
        route === "split" ||
        route === "reference" ||
        route === "release-check",
    },
  ];

  return (
    <div className="app-shell">
      <aside className="side-nav">
        <Link className="brand" href="/" aria-label="Aurialis home">
          <span className="brand-mark">
            <span />
          </span>
          <span>Aurialis</span>
        </Link>
        <nav className="primary-nav" aria-label="Primary navigation">
          {navItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={item.active ? "active" : ""}
              aria-label={item.label}
              aria-current={item.active ? "page" : undefined}
            >
              <Icon name={item.icon} /> <span>{item.label}</span>
            </Link>
          ))}
        </nav>
        <div className="nav-note">
          <span className="eyebrow">Local workspace</span>
          <p>Audio stays on this device.</p>
        </div>
        <button
          type="button"
          className="profile-button"
          aria-label="Open local preferences"
          onClick={() => {
            setPrefsOpen(true);
          }}
        >
          <span><Icon name="settings" /></span>
          <span>
            <strong>Local profile</strong>
            <small>Preferences</small>
          </span>
          <Icon name="more-horizontal" />
        </button>
      </aside>

      <header className="mobile-header">
        <Link className="brand" href="/" aria-label="Aurialis home">
          <span className="brand-mark">
            <span />
          </span>
          <span>Aurialis</span>
        </Link>
        <button
          type="button"
          className="icon-button"
          aria-label="Open menu"
          onClick={() => {
            setMobileMenuOpen(true);
          }}
        >
          <Icon name="menu" />
        </button>
      </header>

      <main
        ref={main}
        className={
          inWorkspace ? "main-content main-content--workspace" : "main-content"
        }
      >
        {route === "home" && <HomeView />}
        {route === "library" && <LibraryView />}
        {route === "master" && (
          <MasterView key={resolvedId} trackId={resolvedId} />
        )}
        {route === "split" && <SplitView key={resolvedId} trackId={resolvedId} />}
        {route === "albums" && <AlbumsView />}
        {route === "album" && <AlbumView key={resolvedId} albumId={resolvedId} />}
        {route === "reference" && <ReferenceMatchingPanel key={resolvedId} trackId={resolvedId} />}
        {route === "release-check" && <ReleaseReview key={resolvedId} trackId={resolvedId} />}
        {route === "tools" && <ToolsView />}
      </main>

      <nav className="bottom-nav" aria-label="Mobile navigation">
        {navItems.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={item.active ? "active" : ""}
            aria-current={item.active ? "page" : undefined}
          >
            <Icon name={item.icon} />
            <span>{item.label}</span>
          </Link>
        ))}
      </nav>

      <Modal
        open={prefsOpen}
        eyebrow="Workspace settings"
        title="Local studio preferences"
        onClose={() => {
          setPrefsOpen(false);
        }}
        actions={
          <>
            <Button
              variant="primary"
              onClick={() => {
                setPrefsOpen(false);
              }}
            >
              Done
            </Button>
          </>
        }
      >
        <p style={{ color: "var(--ink-soft)", margin: "0 0 12px" }}>
          Aurialis processes audio on this device. Audio and project settings
          stay in this browser. Keep your original files and project backups.
        </p>
        <div className="metric-mini">
          <span>
            <strong>{state.tracks.length}</strong>
            <small>Projects</small>
          </span>
          <span>
            <strong>{state.albums.length}</strong>
            <small>Albums</small>
          </span>
          <span>
            <strong>64-bit</strong>
            <small>WASM DSP</small>
          </span>
        </div>
      </Modal>

      <BottomSheet
        open={mobileMenuOpen}
        title="Studio navigation"
        onClose={() => {
          setMobileMenuOpen(false);
        }}
      >
        <div className="control-stack">
          {navItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={buttonClassName(item.active ? "primary" : "secondary")}
              onClick={() => {
                setMobileMenuOpen(false);
              }}
            >
              <Icon name={item.icon} />
              <span>{item.label}</span>
            </Link>
          ))}
        </div>
      </BottomSheet>
    </div>
  );
}

function HomeView() {
  const { state, dispatch } = useStore();
  const browser = useBrowserBuild();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const importAbort = useRef<AbortController | null>(null);
  useEffect(() => () => { importAbort.current?.abort(); }, []);

  const importFiles = async (files: readonly File[]) => {
    if (!files.length) return;
    importAbort.current?.abort();
    const controller = new AbortController();
    importAbort.current = controller;
    const active = () => !controller.signal.aborted && importAbort.current === controller;
    setLoading(true);
    const added: Track[] = [];
    const skipped: string[] = [];
    for (const [index, file] of files.entries()) {
      if (!active()) break;
      try {
        const imported = await prepareProjectFile(file, controller.signal, (stage) => { if (active()) setMessage(`${String(index + 1)} of ${String(files.length)} · ${file.name}: ${stage}`); });
        if (!active()) break;
        const track = importedTrack(file, imported);
        setMessage(`Saving ${file.name} in this browser…`);
        const saved = await saveAudio(track.id, imported.canonical);
        if (!active()) { await discardStagedAudio(track.id, saved.durable); break; }
        track.persistenceWarning = saved.durable ? "" : saved.warning;
        dispatch({ type: "ADD_TRACK", track });
        added.push(track);
      } catch (cause) {
        if (!active()) break;
        skipped.push(`${file.name}: ${cause instanceof Error ? cause.message : "Import failed."}`);
      }
    }
    if (!active()) return;
    setLoading(false);
    const notice = `${String(added.length)} imported. ${skipped.length ? `Skipped ${skipped.join("; ")}` : "All selected files are ready."}`;
    setMessage(notice);
    const first = added[0];
    if (first) {
      if (files.length > 1) dispatch({ type: "UPDATE_TRACK", id: first.id, patch: { importNotice: notice } });
      navigateWorkspace(`/master/${first.id}`);
    }
  };

  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || target.closest("input, textarea, [contenteditable]"))) return;
      const files = Array.from(event.clipboardData?.files ?? []).filter((item) => item.type.startsWith("audio/") || isSourceFileName(item.name));
      if (files.length) { event.preventDefault(); void importFiles(files); }
    };
    document.addEventListener("paste", onPaste);
    return () => {
      document.removeEventListener("paste", onPaste);
    };
  });

  return (
    <div className="page home-page">
      <section className="hero">
        <div className="hero-copy">
          <span className="eyebrow">Mastering, made human</span>
          <h1>
            Master with your <em>ears intact.</em>
          </h1>
          <p>
            A careful audio workspace for finishing songs, not flattening them.
            Shape tone, compare direction, and prepare your release with
            clarity.
          </p>
          <div className="hero-trust">
            <Icon name="headphones" />
            <span>{processingCopy(browser)}</span>
          </div>
        </div>
        <div
          className={`drop-zone ${dragging ? "is-dragging" : ""}`.trim()}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => {
            setDragging(false);
          }}
          onDrop={(event: DragEvent) => {
            event.preventDefault();
            setDragging(false);
            void importFiles(Array.from(event.dataTransfer.files));
          }}
          role="region"
          aria-label="Bring in a track: drop audio or choose a file"
          aria-busy={loading}
        >
          <input
            ref={inputRef}
            type="file"
            multiple
            accept={SOURCE_ACCEPT}
            hidden
            aria-label="Import audio file"
            onChange={(event) => {
              const files = Array.from(event.currentTarget.files ?? []);
              event.currentTarget.value = "";
              void importFiles(files);
            }}
          />
          <div className="drop-icon">
            <Icon name="upload" />
          </div>
          <h2>{loading ? "Preparing your track…" : "Bring in a track"}</h2>
          <p role="status">
            {message ||
              "Drop audio here, paste it, or choose a file from your device."}
          </p>
          <span className="file-types">WAV, AIFF, FLAC or MP3 · up to 256 MiB · about 11½ minutes at 48 kHz</span>
          <Button
            variant="primary"
            icon={<Icon name="file-audio" />}
            onClick={() => {
              if (!loading) { inputRef.current?.click(); return; }
              importAbort.current?.abort();
              setLoading(false);
              setMessage("Import cancelled. Choose a file when you’re ready.");
            }}
          >
            {loading ? "Cancel import" : "Choose audio"}
          </Button>
        </div>
      </section>

      <section className="section recent-section">
        <div className="section-heading">
          <div>
            <span className="eyebrow">Continue listening</span>
            <h2>Recent projects</h2>
          </div>
          <Link href="/library">
            View library <Icon name="arrow-right" />
          </Link>
        </div>
        {state.tracks.length === 0 && <p className="empty-state">Your library starts with your own audio. Import a WAV, AIFF, FLAC or MP3 to create your first project.</p>}
        <div className="track-row-grid">
          {state.tracks.slice(0, 3).map((track, index) => (
            <TrackCard key={track.id} track={track} index={index} />
          ))}
        </div>
      </section>

      <section className="section flow-section">
        <div className="section-heading">
          <div>
            <span className="eyebrow">A considered process</span>
            <h2>From rough mix to release</h2>
          </div>
        </div>
        <div className="workflow-grid">
          <WorkflowCard
            number="01"
            icon="audio-lines"
            title="Master"
            copy="Set a direction, refine the detail, and keep the dynamics that make it yours."
          />
          <WorkflowCard
            number="02"
            icon="scissors"
            title="Split"
            copy={`${STEM_SPLIT_PITCH} ${stemSplitAvailability(browser)}`}
          />
          <WorkflowCard
            number="03"
            icon="check"
            title="Release check"
            copy="Measure your master’s loudness, peak estimates, crest factor and stereo correlation."
          />
        </div>
      </section>
    </div>
  );
}

function WorkflowCard({
  number,
  icon,
  title,
  copy,
}: {
  number: string;
  icon: IconName;
  title: string;
  copy: string;
}) {
  return (
    <article className="workflow-card">
      <span>{number}</span>
      <div className="workflow-icon">
        <Icon name={icon} />
      </div>
      <h3>{title}</h3>
      <p>{copy}</p>
    </article>
  );
}

function TrackCard({ track, index = 0 }: { track: Track; index?: number }) {
  return (
    <Link className="track-card" href={`/master/${track.id}`}>
      <Artwork seed={track.seed} index={index} />
      <div className="track-card-copy">
        <StatusBadge status={track.status} />
        <h3>{track.title}</h3>
        <p>
          {formatTime(track.duration)} · {track.format} ·{" "}
          {track.sampleRate / 1000} kHz
        </p>
      </div>
      <span className="round-arrow">
        <Icon name="arrow-right" />
      </span>
    </Link>
  );
}


type TrackToolRoute = "release-check" | "reference" | "split";

/** One track's tool route, so Master and Tools never open a tool for another track. */
function trackToolHref(route: TrackToolRoute, trackId: string): string {
  return `/${route}/${encodeURIComponent(trackId)}`;
}

function masteringSettingsKey(settings: AdvancedParams) {
  return JSON.stringify({ ...engineParams(settings), requestedTargetLufs: settings.limiter.targetLufs });
}


function MasterView({ trackId }: { trackId: string }) {
  const { state, dispatch } = useStore();
  const browser = useBrowserBuild();
  const track = state.tracks.find((item) => item.id === trackId);
  // Match the unfiltered Library order; editing a project does not reorder this queue.
  const queueIndex = state.tracks.findIndex((item) => item.id === trackId);
  const nextTrack = queueIndex >= 0 ? state.tracks.at(queueIndex + 1) : undefined;
  const [handover, setHandover] = useState(false);
  const handoverActive = useRef(false);
  const forwardAction = useRef<() => void>(() => undefined);
  const [processing, setProcessing] = useState(false);
  const [source, setSource] = useState<StereoPCM | null>(null);
  const [preview, setPreview] = useState<StereoPCM | null>(null);
  const [renderedKey, setRenderedKey] = useState("");
  const live = useRef<LivePlaybackController | null>(null);
  const deepPlayback = useDeepPlayback(track, live);
  const playbackControls = useRef<ReturnType<typeof bindPlaybackControls> | null>(null);
  const { session: scrub, stopScrub, onScrub } = useTransportScrub(live, { available: () => !handoverActive.current, resume: () => { void play(); }, advance: (next) => { playbackControls.current?.update(next, true); } });
  const [playback, setPlayback] = useState<LivePlaybackState | null>(null);
  const [meter, setMeter] = useState<LiveMeter | null>(null);
  const [spectrum, setSpectrum] = useState<LiveSpectrum | null>(null);
  const [liveError, setLiveError] = useState("");
  const [sourceError, setSourceError] = useState("");
  const [sourceLoading, setSourceLoading] = useState(true);
  const [sourceAttempt, setSourceAttempt] = useState(0);
  const ab = playback?.original ? "B" : "A";
  const playheadRatio = playback?.duration ? playback.position / playback.duration : 0;
  const [activeBandId, setActiveBandId] = useState<EQBandId>("low");
  const [exportOpen, setExportOpen] = useState(false);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [deepMoveId, setDeepMoveId] = useState("");
  const [deepEditorOpen, setDeepEditorOpen] = useState(false);
  const selectDeepMove = useCallback((id: string) => { setDeepMoveId(id); setDeepEditorOpen(Boolean(id)); }, []);
  const closeDeepEditor = useCallback(() => { setDeepEditorOpen(false); }, []);
  const [exportFormat, setExportFormat] = useState<DeliveryFormat>(DEFAULT_DELIVERY);
  const [message, setMessage] = useState("");
  const [sourceBlob, setSourceBlob] = useState<Blob | null>(null);
  const renderAbort = useRef<AbortController | null>(null);
  const renderSettings = useRef("");
  const canonicalSettings = useRef(track?.advanced);
  canonicalSettings.current = track?.advanced;
  useEffect(
    () => () => {
      renderAbort.current?.abort();
    },
    [],
  );
  const settingsKey = useMemo(() => track ? appliedRevisionKey(track) ?? masteringSettingsKey(track.advanced) : "", [track]);
  const fresh = renderedKey === settingsKey && preview !== null;
  const rateChoices = track ? exportRateChoices(track.sampleRate, source?.left.length ?? track.sourceIdentity?.frames ?? Math.round(track.duration * track.sampleRate)) : [];
  // A choice that is unavailable for this track falls back to the source rate.
  const delivery = availableDelivery(exportFormat, rateChoices);
  useEffect(() => {
    if (renderAbort.current && !renderAbort.current.signal.aborted && renderSettings.current !== settingsKey) {
      renderAbort.current.abort();
      setProcessing(false);
      if (processing) setMessage("Settings changed. The previous offline operation was canceled.");
    }
  }, [settingsKey, processing]);
  const liveSettings = useMemo(() => track ? clampAdvancedToSampleRate(track.advanced, source?.sampleRate ?? track.sampleRate) : createDefaultAdvancedParams(), [track?.advanced, track?.sampleRate, source?.sampleRate]);
  const currentSettings = useRef(liveSettings);
  currentSettings.current = liveSettings;
  const liveMeter = playback?.playing ? meter : null;
  const levels = liveMeter ? { peak: liveMeter.peakDbfs <= -119.9 ? "−∞" : liveMeter.peakDbfs.toFixed(1), rms: liveMeter.rmsDbfs <= -119.9 ? "−∞" : liveMeter.rmsDbfs.toFixed(1), crest: liveMeter.peakDbfs <= -119.9 ? "—" : liveMeter.crestDb.toFixed(1) } : null;
  const reading = (value: number | null | undefined) => value === null || value === undefined ? "—" : value.toFixed(1);
  const loudness = liveMeter ? {
    momentary: reading(liveMeter.momentaryLufs), shortTerm: reading(liveMeter.shortTermLufs),
    integrated: reading(liveMeter.integratedLufs), range: reading(liveMeter.loudnessRangeLu),
    truePeak: liveMeter.truePeakDbtp <= -119.9 ? "−∞" : liveMeter.truePeakDbtp.toFixed(1),
    recentPeak: liveMeter.recentTruePeakDbtp <= -119.9 ? "−∞" : liveMeter.recentTruePeakDbtp.toFixed(1),
    reduction: liveMeter.gainReductionDb.toFixed(1), correlation: liveMeter.correlation.toFixed(2),
  } : null;
  const peaks = useMemo(() => (source ? sourcePeaks(source) : []), [source]);

  useEffect(() => {
    if (!source) return undefined;
    let active = true;
    let controls: ReturnType<typeof bindPlaybackControls> | null = null;
    try {
      const controller = createLivePlayback(source, currentSettings.current, {
        onState: (next) => {
          if (!active) return;
          setPlayback(next);
          controls?.update(next);
          if (!next.playing) { setMeter(null); setSpectrum(null); }
        },
        onMeter: (next) => { if (active && live.current?.getState().playing) setMeter(next); },
        onSpectrum: (next) => { if (active && live.current?.getState().playing) setSpectrum(next); },
        onError: (error) => { if (active) setLiveError(error.message); },
      }, sourceBlob && track?.sourceIdentity ? { blob: sourceBlob, identity: track.sourceIdentity, ...(track.deepMastering?.applied ? { applied: track.deepMastering.applied } : {}) } : undefined);
      live.current = controller;
      setPlayback(controller.getState());
      setLiveError("");
      controls = bindPlaybackControls(track?.title || "Untitled track", {
        getState: controller.getState,
        available: () => active && live.current === controller && !handoverActive.current,
        play: () => { stopScrub(false); return controller.play(); },
        pause: () => { stopScrub(false); controller.pause(); },
        seek: (seconds) => { stopScrub(false); controller.seek(seconds); },
        restart: () => { stopScrub(false); controller.seek(0); },
        forward: () => { forwardAction.current(); },
        onError: (error) => { if (active) setLiveError(error instanceof Error ? error.message : "Playback could not start."); },
      });
      playbackControls.current = controls;
      const handoff = takeNextPlaybackHandoff(trackId);
      if (handoff) {
        controller.setVolume(handoff.volume);
        if (handoff.playing) void controller.play().catch((error: unknown) => { if (active) setLiveError(error instanceof Error ? error.message : "Press play to start the next track."); });
      }
      return () => { active = false; stopScrub(false); controls?.dispose(); if (playbackControls.current === controls) playbackControls.current = null; controller.dispose(); if (live.current === controller) live.current = null; };
    } catch (error) {
      setLiveError(error instanceof Error ? error.message : "Playback could not be initialized. Retry the source.");
      return undefined;
    }
  }, [source, sourceBlob, trackId]);

  useEffect(() => {
    if (track?.deepMastering?.applied) return;
    try { live.current?.setParams(liveSettings); }
    catch (error) { setLiveError(error instanceof Error ? error.message : "The audio settings could not be applied."); }
  }, [liveSettings, track?.deepMastering?.applied]);

  async function play() {
    const controller = live.current;
    if (!controller) return;
    setLiveError("");
    stopScrub(false);
    try { await controller.play(); }
    catch (error) { if (live.current === controller) setLiveError(error instanceof Error ? error.message : "Playback could not start. Press play to retry."); }
  }
  function seekSeconds(seconds: number) {
    const controller = live.current;
    if (!controller) return;
    stopScrub(false);
    controller.seek(Math.max(0, Math.min(controller.getState().duration, seconds)));
    playbackControls.current?.update(controller.getState(), true);
  }
  function seek(ratio: number) { seekSeconds(Math.max(0, Math.min(1, ratio)) * (source ? source.left.length / source.sampleRate : 0)); }

  function forward() {
    const controller = live.current;
    if (!controller || handover) return;
    const current = controller.getState();
    const intendedPlaying = scrub.current?.wasPlaying ?? current.playing;
    stopScrub(false);
    if (!nextTrack) { controller.seek(Math.min(current.duration, current.position + 10)); return; }
    stageNextPlaybackHandoff({ fromTrackId: trackId, trackId: nextTrack.id, playing: intendedPlaying, volume: current.volume });
    handoverActive.current = true;
    setHandover(true);
    controller.pause();
    try { navigateWorkspace(`/master/${encodeURIComponent(nextTrack.id)}`); }
    catch (error) {
      clearNextPlaybackHandoff();
      handoverActive.current = false;
      setHandover(false);
      setLiveError(error instanceof Error ? error.message : "The next track could not be opened.");
    }
  }
  forwardAction.current = forward;

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    setSource(null);
    setPreview(null);
    setSourceBlob(null);
    setRenderedKey("");
    setMessage("");
    setSourceError("");
    setSourceLoading(true);
    setPlayback(null);
    setMeter(null);
    setSpectrum(null);
    async function prepare() {
      if (!track) return;
      try {
        const blob = await getAudio(audioKey(track));
        if (!blob)
          throw new Error(
            "The source audio is missing. Restore its file to keep this project and its settings.",
          );
        if (controller.signal.aborted) return;
        const stored = await readStoredSource(blob, controller.signal);
        const canonical = stored.blob;
        const pcm = stored.pcm;
        if (!cancelled) {
          setSource(pcm);
          setSourceBlob(canonical);
          const advanced = clampAdvancedToSampleRate(track.advanced, pcm.sampleRate);
          if (JSON.stringify(advanced) !== JSON.stringify(track.advanced)) dispatch({ type: "UPDATE_TRACK", id: track.id, patch: { advanced } });
          setMessage("Source ready. Press play and adjust settings while you listen.");
          setSourceLoading(false);
        }
      } catch (error) {
        if (!cancelled) {
          setSourceLoading(false);
          setSourceError(error instanceof Error ? error.message : "The source could not be loaded. Import the file again or retry.");
        }
      }
    }
    void prepare();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [track?.id, track?.sourceRevision, sourceAttempt]);

  async function renderPreview(params: AdvancedParams = track?.advanced ?? createDefaultAdvancedParams(), pending?: AbortController, ready = "Preview ready. Playback uses the shared Go DSP engine.") {
    if (!track || !source) return;
    if (!pending) renderAbort.current?.abort();
    const controller = pending ?? new AbortController();
    renderAbort.current = controller;
    renderSettings.current = appliedRevisionKey(track) ?? masteringSettingsKey(params);
    setProcessing(true);
    setMessage(
      track.deepMastering?.applied ? "Rendering the applied script on this device…" : "Rendering the imported audio on this device…",
    );
    try {
      const pcm = track.deepMastering?.applied && sourceBlob
        ? await readCanonicalWAV(await serverRenderScript(sourceBlob, track.deepMastering.applied, 32, controller.signal))
        : await processPreview(source, params, controller.signal);
      if (controller.signal.aborted) return;
      setPreview(pcm);
      setRenderedKey(appliedRevisionKey(track) ?? masteringSettingsKey(params));
      live.current?.setBypass(false);
      setMessage(track.deepMastering?.applied ? "Preview ready. The applied script uses the common Go DSP engine." : ready);
      dispatch({
        type: "UPDATE_TRACK",
        id: track.id,
        patch: { status: "mastered" },
      });
    } catch (error) {
      if (!controller.signal.aborted)
        setMessage(
          error instanceof Error
            ? error.message
            : "Preview failed. Please retry.",
        );
    } finally {
      if (!controller.signal.aborted) setProcessing(false);
    }
  }
  async function applySimpleDirection() {
    if (!track || !sourceBlob) return;
    if (track.deepMastering?.applied) { setMessage("Detach Deep automation before applying static target-loudness normalization. Your applied script remains active."); return; }
    renderAbort.current?.abort();
    const controller = new AbortController();
    renderAbort.current = controller;
    renderSettings.current = settingsKey;
    const expected = track.advanced;
    setProcessing(true);
    setMessage("Measuring the current settings and requested loudness…");
    try {
      const { advanced: measured, measurement } = await normalizeSimpleAudio(sourceBlob, expected, expected.limiter.targetLufs, controller.signal);
      if (controller.signal.aborted) return;
      if (canonicalSettings.current !== expected) { setMessage("Settings changed. Set target loudness again."); return; }
      const next = { ...expected, input: measured.input };
      renderSettings.current = masteringSettingsKey(next);
      dispatch({ type: "APPLY_NORMALIZED_GAIN", id: track.id, expected, input: next.input });
      await renderPreview(next, controller, `Preview ready. ${exportLevelSummary(measurement.afterMetrics)}`);
    } catch (error) {
      if (!controller.signal.aborted) setMessage(error instanceof Error ? error.message : "Could not prepare this master.");
    } finally {
      if (!controller.signal.aborted && renderAbort.current === controller) setProcessing(false);
    }
  }
  async function download() {
    if (!track || !sourceBlob) return;
    renderAbort.current?.abort();
    const controller = new AbortController();
    renderAbort.current = controller;
    setProcessing(true);
    renderSettings.current = settingsKey;
    setMessage("Rendering WAV from the imported source…");
    try {
      const { bitDepth, dither } = delivery, outputRate = deliveredRate(delivery, track.sampleRate);
      const { blob, truePeakDbtp } = await renderDelivery(
        sourceBlob,
        exportRender(track),
        bitDepth,
        deliveryRequest(delivery),
        controller.signal,
      );
      if (controller.signal.aborted || renderAbort.current !== controller) return;
      const url = URL.createObjectURL(blob),
        anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${track.title.replace(/[^a-zA-Z0-9_-]/g, "-") || "aurialis"}-${String(outputRate / 1000)}k-${String(bitDepth)}bit.wav`;
      anchor.click();
      setTimeout(() => {
        URL.revokeObjectURL(url);
      }, 1000);
      setMessage(
        `Exported ${bitDepth === 32 ? "32-bit float" : `${String(bitDepth)}-bit PCM`} WAV${bitDepth === 32 ? "" : dither ? " with TPDF dither" : " without dither"} at ${outputRate === track.sampleRate ? "the source rate" : `${String(outputRate / 1000)} kHz (converted from ${String(track.sampleRate / 1000)} kHz)`} ${track.deepMastering?.applied ? "from applied revision " + String(track.deepMastering.applied.revision) : "using the same Go DSP parameters"}.${truePeakDbtp === null ? "" : ` Delivered true peak ${truePeakDbtp.toFixed(2)} dBTP at ${formatRate(outputRate)}.`}`,
      );
    } catch (error) {
      if (!controller.signal.aborted) setMessage(
        error instanceof Error ? error.message : "Export failed. Please retry.",
      );
    } finally {
      if (!controller.signal.aborted && renderAbort.current === controller) setProcessing(false);
    }
  }
  function closeExport() {
    renderAbort.current?.abort();
    setProcessing(false);
    setExportOpen(false);
  }
  if (!track)
    return (
      <div className="page">
        <PageTitle
          eyebrow="Local workspace"
          title="Project not found"
          copy="This project is not in your browser library."
        />
        <Link className={buttonClassName("primary")} href="/library">
          Open library
        </Link>
      </div>
    );
  return (
    <div className="master-page">
      <header className="workspace-header">
        <button
          type="button"
          className="icon-button"
          onClick={() => {
            navigateWorkspace("/library");
          }}
          aria-label="Back to library"
        >
          <Icon name="arrow-left" />
        </button>
        <Artwork seed={track.seed} />
        <div className="workspace-track">
          <h1>{track.title}</h1>
          <p>
            {formatTime(track.duration)} · {track.sampleRate / 1000} kHz · {track.format}
          </p>
        </div>
        <div className="mode-tabs" role="tablist" aria-label="Mastering mode">
          {(["simple", "advanced", "deep"] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={track.mode === m}
              className={track.mode === m ? "is-active" : ""}
              onClick={() => {
                dispatch({
                  type: "UPDATE_TRACK",
                  id: track.id,
                  patch: { mode: m },
                });
              }}
            >
              {m}
            </button>
          ))}
        </div>
        <div className="workspace-actions">
          <Button
            disabled={!sourceBlob || processing}
            icon={<Icon name="arrow-down-to-line" />}
            onClick={() => {
              setExportOpen(true);
            }}
          >
            Export
          </Button>
        </div>
        <nav className="col-span-full flex basis-full flex-wrap items-center gap-2" aria-label={`Tools for ${track.title || "Untitled track"}`}>
          <Link className={buttonClassName("secondary")} href={trackToolHref("release-check", track.id)}><Icon name="check" />Release check</Link>
          <Link className={buttonClassName("secondary")} href={trackToolHref("reference", track.id)}><Icon name="refresh-cw" />Reference match</Link>
          {browser
            ? <p className="disclosure basis-full">{stemSplitAvailability(true)}</p>
            : <Link className={buttonClassName("secondary")} href={trackToolHref("split", track.id)}><Icon name="scissors" />Smart split</Link>}
        </nav>
      </header>
      <div className="workspace-layout">
        <section className="workspace-canvas">
          <div className="metric-strip metric-strip-loudness" role="region" tabIndex={0} aria-label="Live loudness of the processed output">
            <div>
              <span>Short-term</span>
              <strong>{loudness?.shortTerm ?? "—"}</strong>
              <small>LUFS · M {loudness?.momentary ?? "—"}</small>
            </div>
            <div>
              <span>Integrated</span>
              <strong>{loudness?.integrated ?? "—"}</strong>
              <small>LUFS</small>
            </div>
            <div>
              <span>Loudness range</span>
              <strong>{loudness?.range ?? "—"}</strong>
              <small>LU</small>
            </div>
            <div>
              <span>True peak</span>
              <strong>{loudness?.truePeak ?? "—"}</strong>
              <small>dBTP max · now {loudness?.recentPeak ?? "—"}</small>
            </div>
            <div>
              <span>Gain reduction</span>
              <strong>{loudness?.reduction ?? "—"}</strong>
              <small>dB</small>
            </div>
            <div>
              <span>Correlation</span>
              <strong>{loudness?.correlation ?? "—"}</strong>
              <small>−1 to +1</small>
            </div>
          </div>
          <div className="metric-strip" role="region" tabIndex={0} aria-label="Measured audio levels">
            <div>
              <span>Sample peak</span>
              <strong>{levels?.peak ?? "—"}</strong>
              <small>dBFS · preview</small>
            </div>
            <div>
              <span>RMS level</span>
              <strong>{levels?.rms ?? "—"}</strong>
              <small>dBFS</small>
            </div>
            <div>
              <span>Crest factor</span>
              <strong>{levels?.crest ?? "—"}</strong>
              <small>dB</small>
            </div>
            <div>
              <span>Source rate</span>
              <strong>{track.sampleRate / 1000}</strong>
              <small>kHz</small>
            </div>
            <div>
              <span>Listening to</span>
              <strong>{source ? ab : "—"}</strong>
              <small>{source ? ab === "A" ? "Processed" : "Original" : "Unavailable"}</small>
            </div>
          </div>
          <Waveform
            seed={track.seed}
            duration={track.duration}
            peaks={peaks}
            playheadRatio={playheadRatio}
            onSeekRatio={seek}
          />
          <RealTransport
            state={playback}
            sourceReady={source !== null && live.current !== null}
            onPlay={play}
            onPause={() => { stopScrub(false); live.current?.pause(); }}
            onOriginal={(original) => { live.current?.setBypass(original); }}
            onVolume={(volume) => { live.current?.setVolume(volume); }}
            onRestart={() => { seekSeconds(0); }}
            onForward={forward}
            onRepeat={(repeat) => { live.current?.setRepeat(repeat); }}
            onScrub={onScrub}
            {...(nextTrack ? { nextTrackTitle: nextTrack.title || "Untitled track" } : {})}
            handover={handover}
          />
          {track.mode === "deep" && track.deepMastering && <DeepTimeline script={track.deepMastering.proposal} selectedId={deepMoveId} onSelect={selectDeepMove} playheadRatio={playheadRatio} />}
          <LiveSpectrumChart frame={spectrum} playing={playback?.playing ?? false} />
          {sourceError && <div className="flex flex-wrap items-center gap-3" role="alert">
            <p className="disclosure">{sourceError}</p>
            <Button variant="secondary" onClick={() => { setSourceAttempt((attempt) => attempt + 1); }}>Retry source</Button><Button variant="secondary" onClick={() => { setRestoreOpen(true); }}>Restore source</Button>
          </div>}
          {liveError && <div className="flex flex-wrap items-center gap-3" role="alert"><p className="disclosure">{liveError}</p><Button variant="secondary" onClick={() => { setSourceAttempt((attempt) => attempt + 1); }}>Retry playback</Button><Button variant="secondary" onClick={() => { setRestoreOpen(true); }}>Restore source</Button></div>}
          <div className="render-actions">
            <Button
              disabled={!source || processing}
              onClick={() => void renderPreview()}
              icon={<Icon name={processing ? "refresh-cw" : "play"} />}
            >
              {processing ? "Rendering…" : "Render offline preview"}
            </Button>
            {fresh && <Button variant="secondary" onClick={() => {
              const url = URL.createObjectURL(previewWAV(preview));
              const anchor = document.createElement("a"); anchor.href = url; anchor.download = `${track.title.replace(/[^a-zA-Z0-9_-]/g, "-") || "aurialis"}-offline-preview.wav`; anchor.click();
              setTimeout(() => { URL.revokeObjectURL(url); }, 1000);
            }}>Download offline preview</Button>}
            <span className="disclosure">
              {track.deepMastering?.applied
                ? "Playback and export use the acknowledged applied revision. Draft edits wait for Apply; pending baseline edits wait for acknowledgment."
                : fresh
                  ? "Offline preview matches your settings. It and live meters use the preview limiter, so peaks can read higher than the export. Live playback updates independently."
                  : track.mode === "simple"
                    ? "Simple and Advanced share these settings. Set target loudness to measure the requested level; export uses the current settings."
                    : "Playback responds to your controls immediately. Render an offline preview for a full-track check; export always uses current settings."}
            </span>
          </div>
          <p className="disclosure" role="status">
            {sourceLoading ? "Loading stored audio…" : message}
          </p>
          {track.importNotice && <p className="disclosure" role="status">{track.importNotice}</p>}
          {track.limiterNotice && <div className="flex flex-wrap items-center gap-2"><p className="disclosure" role="status">{track.limiterNotice}</p><Button variant="ghost" onClick={() => { dispatch({ type: "UPDATE_TRACK", id: track.id, patch: { limiterNotice: "" } }); }}>Dismiss ceiling note</Button></div>}
          {track.persistenceWarning && (
            <p className="disclosure" role="alert">
              {track.persistenceWarning}
            </p>
          )}
        </section>
        <aside className="inspector" aria-label="Mastering controls inspector">
          <span className="eyebrow">
            {track.mode === "simple"
              ? "Simple direction"
              : track.mode === "deep"
                ? "Deep mastering"
                : "Master controls"}
          </span>
          {(deepPlayback.busy || deepPlayback.message || deepPlayback.error) && <section className="space-y-2" aria-label="Applied automation status"><p className="disclosure" role="status">{deepPlayback.message}</p>{deepPlayback.error && <><p role="alert" className="disclosure text-danger">{deepPlayback.error}</p><div className="flex flex-wrap gap-2"><Button variant="secondary" onClick={deepPlayback.retry}>Retry processing request</Button><Button variant="secondary" onClick={deepPlayback.restoreAppliedSettings}>Restore applied settings</Button></div></>}{deepPlayback.busy && <Button variant="secondary" onClick={deepPlayback.cancel}>Cancel processing publication</Button>}</section>}
          {track.deepMastering?.applied && <section className="space-y-2" aria-label="Applied Deep recovery"><p className="disclosure">Detach returns to the static baseline of the applied revision. Revert restores the complete settings saved before the first Apply.</p><div className="flex flex-wrap gap-2"><Button variant="secondary" onClick={deepPlayback.detach}>Detach automation</Button><Button variant="secondary" onClick={deepPlayback.revert}>Revert before first Apply</Button></div></section>}
          {track.mode === "simple" && (
            <SimpleControls
              track={track}
              sourceBlob={sourceBlob}
              processing={processing}
              sourceReady={source !== null && sourceBlob !== null}
              onApply={() => void applySimpleDirection()}
            />
          )}
          {track.mode === "deep" && (
            <DeepControls
              track={track}
              sourceReady={source !== null}
              selectedMoveId={deepMoveId}
              onSelectMove={selectDeepMove}
              onApplyScript={deepPlayback.apply}
              editorOpen={deepEditorOpen}
              onCloseEditor={closeDeepEditor}
            />
          )}
          {track.mode === "advanced" && (
            <AdvancedControls
              track={track}
              activeBandId={activeBandId}
              onSelectBand={setActiveBandId}
            />
          )}
        </aside>
      </div>
      <Modal
        open={exportOpen}
        eyebrow="Master delivery"
        title={`Export “${track.title}”`}
        onClose={closeExport}
        actions={
          <>
            <Button
              variant="secondary"
              onClick={closeExport}
            >
              Close
            </Button>
            <Button
              disabled={!sourceBlob || processing}
              onClick={() => void download()}
            >
              {processing ? "Rendering WAV…" : "Render & download WAV"}
            </Button>
          </>
        }
      >
        <DeliveryFormatControls
          value={delivery}
          rateChoices={rateChoices}
          rateNote={unavailableRateNote(rateChoices, track.sampleRate)}
          onChange={setExportFormat}
        />
        <p className="disclosure">
          Source sample rate: {formatRate(track.sampleRate)}. The source rate
          keeps every frame. A converted rate keeps the duration, so the frame
          count changes: a 120 dB windowed-sinc filter, flat to 90% of the
          lower Nyquist frequency, resamples the master, which re-limits to
          the true-peak ceiling at the new rate when the limiter is on, then
          applies dither at the new rate. A converted export may not exceed{" "}
          {MAX_SOURCE_FRAMES.toLocaleString("en-US")} frames, about{" "}
          {formatTime(MAX_SOURCE_FRAMES / 96000)} at 96 kHz or{" "}
          {formatTime(MAX_SOURCE_FRAMES / 44100)} at 44.1 kHz. 16-bit and 24-bit PCM clip
          samples outside ±1. Choose 32-bit Float to preserve headroom, or
          enable the limiter before exporting integer PCM. Turn dither off
          only for material that is already dithered.
        </p>
        <p className="disclosure" role="status">
          {message}
        </p>
      </Modal>
      <SourceRelink track={track} open={restoreOpen} onClose={() => { setRestoreOpen(false); }} />
    </div>
  );
}

function AdvancedControls({
  track,
  activeBandId,
  onSelectBand,
}: {
  track: Track;
  activeBandId: EQBandId;
  onSelectBand: (bandId: EQBandId) => void;
}) {
  const { dispatch } = useStore();
  const adv = track.advanced;
  const defaults = clampAdvancedToSampleRate(createDefaultAdvancedParams(), track.sampleRate);
  const selectedBand =
    adv.eqBands.find((b) => b.id === activeBandId) ?? adv.eqBands[1];

  return (
    <div className="control-stack">
      <div>
        <h2>Shape the detail</h2>
        <p>Adjust a module while you listen. Double-click a slider to restore its default.</p>
      </div>

      <SliderField
        label="Input gain"
        value={adv.input}
        defaultValue={defaults.input}
        min={-36}
        max={36}
        step={0.5}
        unit="dB"
        onChange={(input) => {
          dispatch({ type: "UPDATE_INPUT_GAIN", trackId: track.id, input });
        }}
      />

      <MasteringShortcuts track={track} />
      <DSPModule title="Equalizer">
      <SpectrumChart
        seed={track.seed}
        eqBands={adv.eqEnabled ? adv.eqBands : adv.eqBands.map((band) => ({ ...band, enabled: false }))}
        activeBandId={selectedBand.id}
        sampleRate={track.sampleRate}
        onSelectBand={onSelectBand}
        onBandChange={(bandId, patch) => {
          const bounded = typeof patch.freqHz === "number" ? { ...patch, freqHz: Math.min(Math.floor(track.sampleRate * 0.47), Math.max(20, patch.freqHz)) } : patch;
          dispatch({ type: "UPDATE_EQ_BAND", trackId: track.id, bandId, patch: bounded });
        }}
      />
      <label className="check-row">
        <input
          type="checkbox"
          checked={adv.eqEnabled}
          onChange={(event) => {
            dispatch({
              type: "TOGGLE_EQ_ENABLED",
              trackId: track.id,
              enabled: event.target.checked,
            });
          }}
        />
        <span>
          <Icon name="check" />
        </span>
        Enable EQ
      </label>
      <ControlGroup label="5-Band Parametric EQ" value={selectedBand.label}>
        <div className="filter-row" role="tablist" aria-label="EQ bands">
          {adv.eqBands.map((band) => (
            <button
              type="button"
              role="tab"
              key={band.id}
              aria-selected={band.id === selectedBand.id}
              className={
                band.id === selectedBand.id ? "chip is-active" : "chip"
              }
              onClick={() => {
                onSelectBand(band.id);
              }}
            >
              {band.label}
            </button>
          ))}
        </div>
      </ControlGroup>

      <EQBandControls track={track} band={selectedBand} />

      </DSPModule>
      <DSPModule title="Compressor">
      <label className="check-row">
        <input
          type="checkbox"
          checked={adv.compressor.enabled}
          onChange={(event) => {
            dispatch({
              type: "UPDATE_COMPRESSOR",
              trackId: track.id,
              patch: { enabled: event.target.checked },
            });
          }}
        />
        <span>
          <Icon name="check" />
        </span>
        Enable compressor
      </label>
      <SliderField
        label="Threshold"
        value={adv.compressor.threshold}
        defaultValue={defaults.compressor.threshold}
        min={-60}
        max={0}
        step={1}
        unit="dB"
        onChange={(threshold) => {
          dispatch({
            type: "UPDATE_COMPRESSOR",
            trackId: track.id,
            patch: { threshold },
          });
        }}
      />
      <SliderField
        label="Ratio"
        value={adv.compressor.ratio}
        defaultValue={defaults.compressor.ratio}
        min={1}
        max={8}
        step={0.5}
        unit=":1"
        onChange={(ratio) => {
          dispatch({
            type: "UPDATE_COMPRESSOR",
            trackId: track.id,
            patch: { ratio },
          });
        }}
      />
      <SliderField
        label="Attack"
        value={adv.compressor.attack}
        defaultValue={defaults.compressor.attack}
        min={1}
        max={100}
        step={1}
        unit="ms"
        note={`Reaches 92% of the reduction in ${String(adv.compressor.attack)} ms; time constant ≈ ${timeConstantMs(adv.compressor.attack).toFixed(1)} ms`}
        onChange={(attack) => {
          dispatch({
            type: "UPDATE_COMPRESSOR",
            trackId: track.id,
            patch: { attack },
          });
        }}
      />
      <fieldset disabled={adv.compressor.autoRelease} className="min-w-0 border-0 p-0 disabled:opacity-60">
      <SliderField
        label="Release"
        value={adv.compressor.release}
        defaultValue={defaults.compressor.release}
        min={40}
        max={500}
        step={5}
        unit="ms"
        note={`Recovers 92% in ${String(adv.compressor.release)} ms; time constant ≈ ${timeConstantMs(adv.compressor.release).toFixed(0)} ms`}
        onChange={(release) => {
          dispatch({
            type: "UPDATE_COMPRESSOR",
            trackId: track.id,
            patch: { release },
          });
        }}
      />

      </fieldset>
      <ExtendedCompressorControls track={track} />
      </DSPModule>
      <DSPModule title="Stereo image">
      <label className="check-row">
        <input
          type="checkbox"
          checked={adv.stereo.enabled}
          onChange={(event) => {
            dispatch({
              type: "UPDATE_STEREO",
              trackId: track.id,
              patch: { enabled: event.target.checked },
            });
          }}
        />
        <span>
          <Icon name="check" />
        </span>
        Enable stereo
      </label>
      <SliderField
        label="Stereo width"
        value={adv.stereo.width}
        defaultValue={defaults.stereo.width}
        min={0}
        max={200}
        step={1}
        unit="%"
        onChange={(width) => {
          dispatch({
            type: "UPDATE_STEREO",
            trackId: track.id,
            patch: { width },
          });
        }}
      />
      <label className="check-row">
        <input
          type="checkbox"
          checked={adv.stereo.monoBass}
          onChange={(e) => {
            dispatch({
              type: "UPDATE_STEREO",
              trackId: track.id,
              patch: { monoBass: e.target.checked },
            });
          }}
        />
        <span>
          <Icon name="check" />
        </span>
        Mono bass
      </label>

      <ExtendedStereoControls track={track} />
      </DSPModule>
      <DSPModule title="Saturation">
      <label className="check-row">
        <input
          type="checkbox"
          checked={adv.saturationModule.enabled}
          onChange={(event) => {
            dispatch({
              type: "UPDATE_SATURATION",
              trackId: track.id,
              patch: { enabled: event.target.checked },
            });
          }}
        />
        <span>
          <Icon name="check" />
        </span>
        Enable saturation
      </label>
      <fieldset disabled={adv.saturationModule.character === "Clean"} className="min-w-0 border-0 p-0 disabled:opacity-60">
      <SliderField
        label="Saturation"
        value={adv.saturationModule.drive}
        defaultValue={defaults.saturationModule.drive}
        min={0}
        max={100}
        step={1}
        unit="%"
        onChange={(drive) => {
          dispatch({
            type: "UPDATE_SATURATION",
            trackId: track.id,
            patch: { drive },
          });
        }}
      />
      </fieldset>
      {adv.saturationModule.character === "Clean" && <p className="text-xs text-[var(--ink-soft)]">Clean leaves the signal unchanged. Your drive setting is retained for the other characters.</p>}
      <ChoiceGroup
        label="Saturation character"
        value={adv.saturationModule.character}
        options={(["Clean", "Tube", "Tape", "Transformer", ...(["Warm", "Thick", "Crisp"].includes(adv.saturationModule.character) ? [adv.saturationModule.character] : [])] as SaturationCharacter[]).map((char) => ({ value: char, label: char }))}
        onChange={(character) => {
          dispatch({
            type: "UPDATE_SATURATION",
            trackId: track.id,
            patch: { character },
          });
        }}
      />

      </DSPModule>
      <FrequencyDynamicsControls track={track} />
      <DSPModule title="Sample-peak limiter">
      <label className="check-row">
        <input
          type="checkbox"
          checked={adv.limiter.enabled}
          onChange={(event) => {
            dispatch({
              type: "UPDATE_LIMITER",
              trackId: track.id,
              patch: { enabled: event.target.checked },
            });
          }}
        />
        <span>
          <Icon name="check" />
        </span>
        Enable limiter
      </label>
      <SliderField
        label="Limiter ceiling"
        value={adv.limiter.ceiling}
        defaultValue={defaults.limiter.ceiling}
        min={-3.0}
        max={MAX_LIMITER_CEILING_DB}
        step={0.1}
        unit="dBTP"
        onChange={(ceiling) => {
          dispatch({
            type: "UPDATE_LIMITER",
            trackId: track.id,
            patch: { ceiling },
          });
        }}
      />

      <LimiterReleaseControl track={track} />

      </DSPModule>
      <Button
        variant="secondary"
        icon={<Icon name="rotate-ccw" />}
        onClick={() => {
          dispatch({ type: "UPDATE_TRACK", id: track.id, patch: { advanced: clampAdvancedToSampleRate(createDefaultAdvancedParams(), track.sampleRate), shortcutUndo: {} } });
        }}
      >
        Reset modules
      </Button>
    </div>
  );
}

function DeepControls({ track, sourceReady, selectedMoveId, onSelectMove, editorOpen, onCloseEditor, onApplyScript }: {
  track: Track;
  sourceReady: boolean;
  selectedMoveId: string;
  editorOpen: boolean;
  onCloseEditor: () => void;
  onApplyScript: (script: ScriptV2) => Promise<void>;
  onSelectMove: (id: string) => void;
}) {
  return (
    <div className="control-stack deep-controls">
      <DeepProposalPanel track={track} sourceReady={sourceReady} selectedMoveId={selectedMoveId} onSelectMove={onSelectMove} editorOpen={editorOpen} onCloseEditor={onCloseEditor} onApply={onApplyScript} />
      <FeatureAnalysisPanel trackId={track.id} audioId={audioKey(track)} sourceReady={sourceReady} />
    </div>
  );
}

function SplitView({ trackId }: { trackId: string }) {
  const { state } = useStore();
  const track = state.tracks.find((item) => item.id === trackId);
  return (
    <div className="page">
      <PageTitle eyebrow="Smart stem splitter" title="A closer look inside the mix"
        copy="Split a song into vocals, drums, bass and more with a trained separation model. Your original audio is unchanged."
        action={<Link className={buttonClassName("secondary")} href={track ? `/master/${track.id}` : "/"}>
          {track ? "Back to master" : "Import a track"}
        </Link>} />
      <StemSplitPanel key={track?.id ?? "none"} audioId={track ? audioKey(track) : null} title={track?.title ?? "track"} />
    </div>
  );
}

function AlbumsView() {
  const { state, dispatch } = useStore();
  const create = () => {
    const album: Album = {
      id: `album-${String(Date.now())}`,
      title: `Untitled sequence ${String(state.albums.length + 1)}`,
      artist: "",
      level: DEFAULT_ALBUM_LEVEL,
      delivery: DEFAULT_DELIVERY,
      trackIds: [],
      mastered: false,
    };
    dispatch({ type: "ADD_ALBUM", album });
  };
  return (
    <div className="page">
      <PageTitle
        eyebrow="Sequence and consistency"
        title="Albums"
        copy="Shape a collection as one listening experience."
        action={
          <Button icon={<Icon name="plus" />} onClick={create}>
            New album
          </Button>
        }
      />
      {state.albums.length === 0 ? (
        <div className="album-empty paper-panel">
          <div className="album-art-large">
            <Icon name="disc" />
          </div>
          <div>
            <span className="eyebrow">Your first sequence</span>
            <h2>Bring the songs into one room.</h2>
            <p>
              Create an album to compare loudness, tone, and dynamics across
              your library.
            </p>
            <Button icon={<Icon name="plus" />} onClick={create}>
              Create an album
            </Button>
          </div>
        </div>
      ) : (
        <div className="album-grid">
          {state.albums.map((album, index) => (
            <Link
              className="album-card"
              href={`/albums/${album.id}`}
              key={album.id}
            >
              <div className={`album-art album-art--${String(index % 3)}`}>
                <span>{String(index + 1).padStart(2, "0")}</span>
              </div>
              <span className="eyebrow">{album.trackIds.length} tracks</span>
              <h2>{album.title}</h2>
              <p>{albumLevelSummary(album.level)}</p>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

type AlbumMasterFile = { id: string; title: string; blob: () => Promise<Blob | undefined>; durable: boolean; measured?: AlbumMasterLevel };
type RenderedAlbumFile = { id: string; title: string; blob: Blob; measured: AlbumMasterLevel };
// Resolved at call time, so the engine binding in use renders each master.
const albumEngine: AlbumRenderEngine = {
  normalize: (file, settings, target, signal) => normalizeSimpleAudio(file, settings, target, signal),
  // The same request Export sends, so a kept master is the single export at this format.
  render: async (file, render, format, signal) => (await renderDelivery(file, render, format.bitDepth, deliveryRequest(format), signal)).blob,
  measure: (file, params, signal) => measureAudio(file, params, signal),
};

function AlbumView({ albumId }: { albumId: string }) {
  const { state, dispatch } = useStore();
  const [working, setWorking] = useState(false);
  const operation = useRef<AbortController | null>(null);
  const cacheMemory = useRef<ReturnType<typeof reserveBrowserAudioMemory> | null>(null);
  useEffect(() => () => { operation.current?.abort(); cacheMemory.current?.dispose(); cacheMemory.current = null; }, []);
  const [message, setMessage] = useState("");
  const [rendered, setRendered] = useState<{ key: string; files: RenderedAlbumFile[]; memory: ReturnType<typeof reserveBrowserAudioMemory> } | null>(null);
  const [saved, setSaved] = useState<SavedAlbumMasters | undefined>();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const planErrorId = useId();
  useEffect(() => () => { rendered?.memory.dispose(); }, [rendered]);
  useEffect(() => {
    let current = true;
    void loadAlbumMasters(albumId).then((record) => { if (current) setSaved(record); });
    return () => { current = false; };
  }, [albumId]);
  const album =
    state.albums.find((item) => item.id === albumId);

  const albumTracks = (album?.trackIds ?? [])
    .map((id) => state.tracks.find((track) => track.id === id))
    .filter((track): track is Track => track !== undefined);
  const level = album?.level ?? DEFAULT_ALBUM_LEVEL;
  const plan = planAlbumLevels(level, albumTracks);
  const sourceFrames = (track: Track) => track.sourceIdentity?.frames ?? Math.ceil(track.duration * track.sampleRate);
  const rateChoices = albumRateChoices(albumTracks.map((track) => ({ sampleRate: track.sampleRate, frames: sourceFrames(track) })));
  // A rate some track cannot reach renders each source rate, as Export falls back.
  const chosen = album?.delivery ?? DEFAULT_DELIVERY, format = availableDelivery(chosen, rateChoices);
  const sourceRates = [...new Set(albumTracks.map((track) => track.sampleRate))].sort((a, b) => a - b);
  // Name the tracks that cannot reach the saved rate, so the fallback is never silent.
  const unreachable = chosen.sampleRate === "source" || format.sampleRate !== "source" ? [] : albumTracks.filter((track) =>
    availableDelivery(chosen, albumRateChoices([{ sampleRate: track.sampleRate, frames: sourceFrames(track) }])).sampleRate === "source");
  const fallbackNote = chosen.sampleRate === "source" || unreachable.length === 0 ? ""
    : `${unreachable.map((track) => `“${track.title}”`).join(", ")} cannot be delivered at ${formatRate(chosen.sampleRate)}, so masters render at each source rate (${deliverySummary(format)}). Remove ${unreachable.length > 1 ? "those tracks" : "that track"} or choose another sample rate.`;
  const offerCd = sourceRates.length > 1 && !(format.sampleRate === CD_DELIVERY.sampleRate && format.bitDepth === CD_DELIVERY.bitDepth)
    && rateChoices.some((choice) => choice.value === CD_DELIVERY.sampleRate && choice.unavailable === undefined);
  const artifactKey = albumMastersKey(albumTracks, level, format);
  useEffect(() => {
    if (rendered && rendered.key !== artifactKey) {
      if (cacheMemory.current === rendered.memory) cacheMemory.current = null;
      setRendered(null);
    }
  }, [artifactKey, rendered]);

  if (!album) {
    return (
      <div className="page">
        <PageTitle
          eyebrow="Album workspace"
          title="No album selected"
          copy="Create an album first to sequence tracks."
          action={
            <Link className={buttonClassName("primary")} href="/albums">
              Back to albums
            </Link>
          }
        />
      </div>
    );
  }

  const artifacts: AlbumMasterFile[] = rendered?.key === artifactKey
    ? rendered.files.map((file) => ({ id: file.id, title: file.title, blob: () => Promise.resolve(file.blob), durable: false, measured: file.measured }))
    : saved?.key === artifactKey
      ? saved.files.map((file) => ({ id: file.trackId, title: file.title, blob: () => getAudio(file.audioId), durable: true, ...(file.measured ? { measured: file.measured } : {}) }))
      : [];
  // Chart only levels measured from these rendered files; otherwise no chart.
  const measuredMasters = artifacts.flatMap((file, index): MeasuredAlbumMaster[] => {
    const step = plan.ok ? plan.tracks.at(index) : undefined;
    return file.measured ? [{ id: file.id, title: file.title, measured: file.measured, requestedLufs: step?.mode === "normalize" ? step.requestedLufs : null }] : [];
  });
  // A sequence or level change outdates the last render notice, so the status
  // line can say whether saved masters still match.
  const changeSequence = (patch: Partial<Pick<Album, "level" | "trackIds" | "delivery">>) => { setMessage(""); dispatch({ type: "UPDATE_ALBUM", id: album.id, patch }); };
  const updateLevel = (next: AlbumLevel) => { changeSequence({ level: next }); };
  const staleSaved = artifacts.length === 0 && saved !== undefined;
  const download = (run: () => Promise<void>) => { void run().catch((error: unknown) => { setMessage(error instanceof Error ? error.message : "The album master could not be downloaded. Try again."); }); };

  return (
    <div className="page">
      <h1 className="sr-only">Album mastering workspace</h1>
      <section className="album-hero">
        <div className="album-art-large">
          <Icon name="disc" />
        </div>
        <div>
          <span className="eyebrow">Album workspace</span>
          <input
            className="title-input"
            aria-label="Album title"
            value={album.title}
            onChange={(e) => {
              dispatch({
                type: "UPDATE_ALBUM",
                id: album.id,
                patch: { title: e.target.value },
              });
            }}
          />
          <input
            className="artist-input"
            aria-label="Album artist or release note"
            value={album.artist}
            placeholder="Add artist or release note"
            onChange={(e) => {
              dispatch({
                type: "UPDATE_ALBUM",
                id: album.id,
                patch: { artist: e.target.value },
              });
            }}
          />
          {!plan.ok && <p className="disclosure" id={planErrorId}>{plan.error}</p>}
          <div className="album-meta">
            <span>{albumTracks.length} tracks</span>
            <span>{albumLevelSummary(level)}</span>
            <span>{deliverySummary(format)}</span>
            <span>{artifacts.length > 0 ? "Masters ready to download" : "In progress"}</span>
          </div>
        </div>
        <Button
          icon={<Icon name="sparkles" />}
          disabled={working || albumTracks.length === 0 || !plan.ok}
          {...(plan.ok ? {} : { "aria-describedby": planErrorId })}
          onClick={() => void (async () => {
            if (!plan.ok) return;
            const steps = plan.tracks, key = artifactKey, delivery = format;
            const controller = new AbortController();
            operation.current?.abort();
            operation.current = controller;
            setWorking(true);
            setMessage(level.mode === "keep" ? "Rendering and measuring each master at its own level…" : `${albumLevelSummary(level)} plus each track’s album offset, then measures each master…`);
            setRendered(null);
            const memory = reserveBrowserAudioMemory();
            cacheMemory.current = memory;
            let retained = false;
            // Rendered masters are saved to browser storage as they finish, so
            // only the track being rendered is held in memory. Without storage,
            // they fall back to the bounded in-memory cache for this page.
            let durable: boolean | undefined;
            const stored: SavedAlbumMasters["files"] = [];
            try {
              const expectedTotal = albumTracks.reduce((total, track) => total + deliveredBytes(delivery, track.sampleRate, sourceFrames(track)), 0);
              await ensureStorageFor(expectedTotal);
              const files: RenderedAlbumFile[] = [];
              let totalBytes = 0;
              for (const [index, track] of albumTracks.entries()) {
                const step = steps.at(index);
                if (step?.trackId !== track.id) throw new Error("The album sequence changed. Render again.");
                const file = await getAudio(audioKey(track));
                if (!file) throw new Error(`The source for “${track.title}” is missing. Import it again.`);
                const expectedBytes = totalBytes + deliveredBytes(delivery, track.sampleRate, sourceFrames(track));
                if (durable === false && expectedBytes > 128 * 1024 * 1024) throw new Error("Browser storage is unavailable and the rendered album exceeds the 128 MiB in-memory cache. Allow site storage, or render a smaller sequence.");
                // Claim the final retained allocation before rendering; no gap while
                // the worker result becomes its downloadable Blob.
                memory.update(expectedBytes);
                // The project is read, never written: the album level lives on the album.
                const { blob, measured } = await renderAlbumTrack(track, file, step, delivery, albumEngine, controller.signal).catch((cause: unknown) => {
                  // In a long album the user must know which song failed.
                  throw new Error(`“${track.title}” could not be rendered: ${cause instanceof Error ? cause.message : "the render failed."}`, { cause });
                });
                if (controller.signal.aborted) return;
                if (durable !== false) {
                  const audioId = newAudioAssetId("master");
                  try {
                    await saveAudio(audioId, blob, false);
                    durable = true;
                    stored.push({ trackId: track.id, title: track.title, audioId, bytes: blob.size, measured });
                  } catch (cause) {
                    if (durable) throw new Error("Browser storage filled while saving album masters. Free space and render again.", { cause });
                    durable = false;
                  }
                }
                if (!durable) {
                  totalBytes += blob.size;
                  files.push({ id: track.id, title: track.title, blob, measured });
                }
                memory.update(totalBytes);
              }
              if (controller.signal.aborted) return;
              dispatch({ type: "UPDATE_ALBUM", id: album.id, patch: { mastered: true } });
              if (durable) {
                const record: SavedAlbumMasters = { key, createdAt: new Date().toISOString(), files: [...stored] };
                await saveAlbumMasters(album.id, record);
                stored.length = 0;
                setSaved(record);
                setMessage(`Rendered WAV masters are saved in this browser (${deliverySummary(delivery)}). Download them individually or as one ZIP. Your projects and their sources are unchanged.`);
              } else {
                setRendered({ key, files, memory });
                retained = true;
                setMessage(`Rendered WAV masters are ready below (${deliverySummary(delivery)}). Browser storage is unavailable, so they last until settings change or you leave this page. Your projects and their sources are unchanged.`);
              }
            } catch (error) {
              if (!controller.signal.aborted) setMessage(error instanceof Error ? error.message : "The sequence could not be prepared.");
            } finally {
              for (const file of stored) await deleteAudio(file.audioId).catch(() => undefined);
              if (!retained) { memory.dispose(); if (cacheMemory.current === memory) cacheMemory.current = null; }
              if (!controller.signal.aborted) setWorking(false);
            }
          })()}
        >
          {working ? "Rendering sequence…" : "Render album masters"}
        </Button>
      </section>
      <p className="disclosure" role="status">{[fallbackNote, message || (staleSaved ? "Saved masters no longer match this sequence or its settings. Render again to replace them." : "Render a measured master for each song, then download the WAV files individually or as one ZIP.")].filter(Boolean).join(" ")}</p>
      {artifacts.length > 0 && <section className="paper-panel" aria-label="Rendered album downloads">
        <h2>Your album masters</h2>
        <Button icon={<Icon name="arrow-down-to-line" />} disabled={working} onClick={() => { download(async () => {
          const blobs = await Promise.all(artifacts.map((file) => file.blob()));
          if (blobs.some((blob) => blob === undefined)) throw new Error("A saved album master is missing. Render the album again.");
          const names = albumEntryNames(artifacts.map((file) => file.title));
          const zip = await createStoredZip(blobs.map((blob, index) => ({ name: names.at(index) ?? `${String(index + 1)}.wav`, blob: blob ?? new Blob() })));
          downloadLocalBlob(zip, `${safeFileBaseName(album.title, "Aurialis album")} - album masters.zip`, { charge: !artifacts.every((file) => file.durable) });
        }); }}>Download all as ZIP</Button>
        {artifacts.map((file) => <Button key={file.id} variant="secondary" icon={<Icon name="arrow-down-to-line" />} onClick={() => { download(async () => {
          const blob = await file.blob();
          if (!blob) throw new Error("This saved album master is missing. Render the album again.");
          downloadLocalBlob(blob, `${safeFileBaseName(file.title, "Track")} - master.wav`, { charge: !file.durable });
        }); }}>Download {file.title}</Button>)}
      </section>}
      <div className="flex flex-wrap gap-2">
        {confirmDelete ? <>
          <Button variant="danger" disabled={working} onClick={() => { void deleteAlbumMasters(album.id).then(() => { dispatch({ type: "DELETE_ALBUM", id: album.id }); navigateWorkspace("/albums"); }, (error: unknown) => { setMessage(error instanceof Error ? error.message : "The album's saved masters could not be deleted. Try again."); }); }}>Confirm delete album</Button>
          <Button variant="secondary" onClick={() => { setConfirmDelete(false); }}>Keep album</Button>
        </> : <Button variant="secondary" icon={<Icon name="trash" />} disabled={working} onClick={() => { setConfirmDelete(true); }}>Delete album</Button>}
        {confirmDelete && <p className="disclosure">Deletes this album and its saved masters. Your projects and their sources stay in the Library.</p>}
      </div>
      <div className="album-layout">
        <section className="paper-panel">
          <div className="section-heading">
            <div>
              <span className="eyebrow">Running order</span>
              <h2>The sequence</h2>
            </div>
          </div>
          <div className="album-track-list">
            {albumTracks.map((track, index) => (
              <div key={track.id}>
                <span>{String(index + 1).padStart(2, "0")}</span>
                <Artwork seed={track.seed} />
                <div>
                  <Link href={`/master/${track.id}`}><strong>{track.title}</strong></Link>
                  <small>
                    {formatTime(track.duration)} ·{" "}
                    {track.measurements ? track.metrics.lufs.toFixed(1) : "Unmeasured"}{" "}
                    LUFS
                  </small>
                </div>
                <div style={{ display: "inline-flex", gap: "2px" }}>
                  <button
                    type="button"
                    className="icon-button"
                    disabled={working || index === 0}
                    aria-label={`Move ${track.title} up`}
                    onClick={() => {
                      const nextIds = [...album.trackIds];
                      const prev = nextIds.at(index - 1);
                      const curr = nextIds.at(index);
                      if (prev !== undefined && curr !== undefined) {
                        nextIds.splice(index - 1, 2, curr, prev);
                        changeSequence({ trackIds: nextIds });
                      }
                    }}
                  >
                    <Icon name="arrow-left" style={{ transform: "rotate(90deg)" }} />
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    disabled={working || index === albumTracks.length - 1}
                    aria-label={`Move ${track.title} down`}
                    onClick={() => {
                      const nextIds = [...album.trackIds];
                      const next = nextIds.at(index + 1);
                      const curr = nextIds.at(index);
                      if (next !== undefined && curr !== undefined) {
                        nextIds.splice(index, 2, next, curr);
                        changeSequence({ trackIds: nextIds });
                      }
                    }}
                  >
                    <Icon name="arrow-right" style={{ transform: "rotate(90deg)" }} />
                  </button>
                  <button
                    type="button"
                    className="icon-button"
                    disabled={working}
                    aria-label={`Remove ${track.title} from album`}
                    onClick={() => {
                      changeSequence({ trackIds: album.trackIds.filter((id) => id !== track.id) });
                    }}
                  >
                    <Icon name="x" />
                  </button>
                </div>
              </div>
            ))}
          </div>
          <div className="add-tracks">
            <span className="eyebrow">Add from library</span>
            {state.tracks
              .filter((track) => !album.trackIds.includes(track.id))
              .map((track) => (
                <button
                  type="button"
                  key={track.id}
                  disabled={working}
                  onClick={() => {
                    changeSequence({ trackIds: [...album.trackIds, track.id] });
                  }}
                >
                  <Icon name="plus" />
                  {track.title}
                </button>
              ))}
          </div>
        </section>
        <section className="paper-panel consistency" aria-labelledby={`${planErrorId}-level`}>
          <div className="section-heading">
            <div>
              <span className="eyebrow">Across the album</span>
              <h2 id={`${planErrorId}-level`}>Album level</h2>
            </div>
            <strong>{albumLevelSummary(level)}</strong>
          </div>
          <fieldset className="m-0 min-w-0 border-0 p-0" disabled={working}>
            <legend className="sr-only">Album level settings</legend>
            <ChoiceGroup label="Level" value={level.mode} className="choice-grid--pairs" options={[{ value: "keep", label: "Keep each master’s level" }, { value: "normalize", label: "Normalize to a target" }]} onChange={(mode) => { updateLevel({ ...level, mode }); }} />
            <p className="disclosure mt-2">{level.mode === "keep"
              ? "Each WAV matches that master’s own export. Album rendering never changes a project."
              : "Each track is rendered to the target plus its album offset. Offsets and target are saved on this album, not in the projects."}</p>
            {level.mode === "normalize" && <>
              <ChoiceGroup label="Target loudness" value={level.targetLufs} options={ALBUM_TARGETS.map((value) => ({ value, label: `−${String(Math.abs(value))} LUFS` }))} onChange={(targetLufs) => { updateLevel({ ...level, targetLufs }); }} />
              {albumTracks.map((track) => {
                const offset = albumOffset(level, track.id), requested = level.targetLufs + offset;
                return <SliderField key={track.id} label={track.title} ariaLabel={`${track.title} album offset`} value={offset} defaultValue={0} min={-ALBUM_OFFSET_LIMIT_DB} max={ALBUM_OFFSET_LIMIT_DB} step={0.5} unit="LU" note={`Renders at ${requested < 0 ? "−" : ""}${String(Math.abs(requested))} LUFS`} onChange={(next) => { updateLevel(withAlbumOffset(level, track.id, next)); }} />;
              })}
            </>}
            {/* Mirrors the hero's blocking reason beside the controls that cause it; always mounted so changes are announced. */}
            <p className="disclosure mt-2 font-semibold empty:mt-0" role="status">{plan.ok ? "" : plan.error}</p>
          </fieldset>
          {measuredMasters.length > 0 && measuredMasters.length === artifacts.length && <AlbumLevelChart masters={measuredMasters} />}
        </section>
        <section className="paper-panel album-delivery" aria-labelledby={`${planErrorId}-delivery`}>
          <div className="section-heading">
            <div>
              <span className="eyebrow">Every master</span>
              <h2 id={`${planErrorId}-delivery`}>Album delivery format</h2>
            </div>
          </div>
          <fieldset className="m-0 min-w-0 border-0 p-0" disabled={working}>
            <legend className="sr-only">Album delivery format settings</legend>
            <DeliveryFormatControls value={format} rateChoices={rateChoices} rateNote={albumRateNote(rateChoices)} sourceLabel="Each source rate" onChange={(delivery) => { changeSequence({ delivery }); }} />
            <p className="disclosure mt-2">{format.sampleRate === "source" && sourceRates.length > 1
              ? `These sources use ${sourceRates.map(formatRate).join(" and ")}. Choose one sample rate for a uniform album.`
              : "Each master is the file Export delivers at this format, converted and dithered once at the new rate."}</p>
            {offerCd && <Button variant="secondary" onClick={() => { changeSequence({ delivery: CD_DELIVERY }); }}>Use CD format: 44.1 kHz, 16-bit</Button>}
          </fieldset>
        </section>
      </div>
    </div>
  );
}


/** Tab-scoped memory of the Tools track choice; storage can be absent or blocked. */
const TOOLS_TRACK_KEY = "aurialis-tools-track";

function readToolsTrack(): string {
  try { return sessionStorage.getItem(TOOLS_TRACK_KEY) ?? ""; } catch { return ""; }
}

function rememberToolsTrack(id: string) {
  try { sessionStorage.setItem(TOOLS_TRACK_KEY, id); } catch { /* the choice still applies until the page closes */ }
}

function ToolsView() {
  const { state } = useStore();
  const browser = useBrowserBuild();
  const chooserId = useId();
  const [chosenId, setChosenId] = useState("");
  // Read after mount so the static prerender and the first client render agree.
  useEffect(() => { setChosenId(readToolsTrack()); }, []);
  // A deleted choice falls back to the newest import, as before the chooser existed.
  const target = state.tracks.find((item) => item.id === chosenId) ?? state.tracks[0];
  const href = (route: TrackToolRoute) => target ? trackToolHref(route, target.id) : undefined;
  return (
    <div className="page">
      <PageTitle
        eyebrow="Focused utilities"
        title="Tools"
        copy="Focused tools for your local audio projects."
      />
      {target ? (
        <div className="mb-8 max-w-md">
          <ControlGroup label="Track" htmlFor={chooserId}>
            <div className="select-wrap">
              <select id={chooserId} value={target.id} onChange={(event) => { setChosenId(event.target.value); rememberToolsTrack(event.target.value); }}>
                {state.tracks.map((item) => (
                  <option key={item.id} value={item.id}>
                    {`${item.title || "Untitled track"} · ${formatTime(item.duration)} · ${item.format}`}
                  </option>
                ))}
              </select>
              <Icon name="chevron-down" />
            </div>
          </ControlGroup>
        </div>
      ) : (
        <div className="mb-8 flex flex-wrap items-center gap-3">
          <p className="disclosure">Import a track to open these tools on it.</p>
          <Link className={buttonClassName("primary")} href="/">Import a track</Link>
        </div>
      )}
      <ul className="tools-grid" aria-label={target ? `Tools for ${target.title || "Untitled track"}` : "Tools"}>
        <ToolCard
          icon="scissors"
          eyebrow="Separation"
          title="Smart stem splitter"
          copy={`${STEM_SPLIT_PITCH} ${stemSplitAvailability(browser)}`}
          // The browser build cannot split, so the card states that instead of linking.
          href={browser ? undefined : href("split")}
        />
        <ToolCard
          icon="refresh-cw"
          eyebrow="Direction"
          title="Reference match"
          copy="Measure your starting chain against reference audio, then review bounded EQ and optional width changes."
          href={href("reference")}
        />
        <ToolCard
          icon="check"
          eyebrow="Delivery"
          title="Release check"
          copy="Measure rendered loudness, peak estimates, crest factor and stereo correlation."
          href={href("release-check")}
        />
      </ul>
    </div>
  );
}

function ToolCard({
  icon,
  eyebrow,
  title,
  copy,
  href,
}: {
  icon: IconName;
  eyebrow: string;
  title: string;
  copy: string;
  href: string | undefined;
}) {
  const body = (
    <>
      <div>
        <Icon name={icon} />
      </div>
      <span className="eyebrow">{eyebrow}</span>
      <h2>{title}</h2>
      <p>{copy}</p>
    </>
  );
  return (
    <li className="min-w-0">
      {href === undefined ? (
        <div className="tool-card h-full">{body}</div>
      ) : (
        <Link className="tool-card block h-full" href={href}>
          {body}
          <span className="text-link">
            Open tool <Icon name="arrow-right" />
          </span>
        </Link>
      )}
    </li>
  );
}
