"use client";

import { WorkspaceLink as Link } from "./shared/WorkspaceLink";
import {
  engineParams,
  measureAudio,
  trackMetrics,
  normalizeSimpleAudio,
  processPreview,
  previewWAV,
  serverRender,
  serverRenderScript,
  readCanonicalWAV,
  sourcePeaks,
  type StereoPCM,
} from "@/lib/browser-engine";
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
  useRef,
  useState,
  type DragEvent,
} from "react";
import {
  createDefaultAdvancedParams,
  clampAdvancedToSampleRate,
  mapProfileToDSP,
} from "@/lib/audio-dsp";
import { saveAudio, getAudio, discardStagedAudio } from "@/lib/db";
import { profiles, useStore } from "@/lib/store";
import type {
  Album,
  AdvancedParams,
  EQBandId,
  ExportBitDepth,
  ProfileId,
  SaturationCharacter,
  Track,
} from "@/lib/types";
import { Icon, type IconName } from "./shared/Icon";
import {
  Artwork,
  BottomSheet,
  Button,
  buttonClassName,
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

import { readStoredSource, prepareProjectFile, importedTrack } from "@/lib/project-import";
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
import type { ScriptV2 } from "@/lib/deep-mastering";
import { DeepTimeline } from "./shared/DeepTimeline";

const stemNames = new Map<number, string[]>([
  [2, ["Vocals", "Instrumental"]],
  [3, ["Vocals", "Drums", "Other"]],
  [4, ["Vocals", "Drums", "Bass", "Other"]],
  [5, ["Vocals", "Drums", "Bass", "Melody", "Other"]],
  [6, ["Vocals", "Drums", "Bass", "Guitar", "Piano", "Other"]],
]);




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
          <p>Audio stays on your device and local server.</p>
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
          Aurialis processes audio with a shared Go engine in your browser and
          local server. Audio is stored in IndexedDB; project settings are
          stored in this browser.
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
      const files = Array.from(event.clipboardData?.files ?? []).filter((item) => item.type.startsWith("audio/") || /\.wav$/iu.test(item.name));
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
            <span>
              Local by default. Audio is processed by your local Go server and
              browser.
            </span>
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
            accept="audio/wav,.wav"
            hidden
            aria-label="Upload audio file"
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
          <span className="file-types">PCM WAV · up to 128 MiB · 16,777,216 frames maximum</span>
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
        {state.tracks.length === 0 && <p className="empty-state">Your library starts with your own audio. Import a WAV to create your first project.</p>}
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
            copy="Instrument separation is planned. It is not available in this build."
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


function masteringSettingsKey(settings: AdvancedParams) {
  return JSON.stringify({ ...engineParams(settings), requestedTargetLufs: settings.limiter.targetLufs });
}


function MasterView({ trackId }: { trackId: string }) {
  const { state, dispatch } = useStore();
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
  const [bitDepth, setBitDepth] = useState<ExportBitDepth>(24);
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

  async function renderPreview(params: AdvancedParams = track?.advanced ?? createDefaultAdvancedParams(), pending?: AbortController) {
    if (!track || !source) return;
    if (!pending) renderAbort.current?.abort();
    const controller = pending ?? new AbortController();
    renderAbort.current = controller;
    renderSettings.current = appliedRevisionKey(track) ?? masteringSettingsKey(params);
    setProcessing(true);
    setMessage(
      track.deepMastering?.applied ? "Rendering the applied script with the common native Go engine…" : "Rendering the uploaded audio with the shared Go WebAssembly engine…",
    );
    try {
      const pcm = track.deepMastering?.applied && sourceBlob
        ? await readCanonicalWAV(await serverRenderScript(sourceBlob, track.deepMastering.applied, 32, controller.signal))
        : await processPreview(source, params, controller.signal);
      if (controller.signal.aborted) return;
      setPreview(pcm);
      setRenderedKey(appliedRevisionKey(track) ?? masteringSettingsKey(params));
      live.current?.setBypass(false);
      setMessage(track.deepMastering?.applied ? "Preview ready. The applied script uses the common Go DSP engine." : "Preview ready. Playback uses the shared Go DSP engine.");
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
      const measured = await normalizeSimpleAudio(sourceBlob, expected, expected.limiter.targetLufs, controller.signal);
      if (controller.signal.aborted) return;
      if (canonicalSettings.current !== expected) { setMessage("Settings changed. Set target loudness again."); return; }
      const next = { ...expected, input: measured.input };
      renderSettings.current = masteringSettingsKey(next);
      dispatch({ type: "APPLY_NORMALIZED_GAIN", id: track.id, expected, input: next.input });
      await renderPreview(next, controller);
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
    setMessage("Rendering WAV from the uploaded source…");
    try {
      const blob = track.deepMastering?.applied
        ? await serverRenderScript(sourceBlob, track.deepMastering.applied, bitDepth, controller.signal)
        : await serverRender(sourceBlob, engineParams(track.advanced), bitDepth, controller.signal);
      if (controller.signal.aborted || renderAbort.current !== controller) return;
      const url = URL.createObjectURL(blob),
        anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${track.title.replace(/[^a-zA-Z0-9_-]/g, "-") || "aurialis"}-${String(bitDepth)}bit.wav`;
      anchor.click();
      setTimeout(() => {
        URL.revokeObjectURL(url);
      }, 1000);
      setMessage(
        `Exported ${bitDepth === 32 ? "32-bit float" : `${String(bitDepth)}-bit PCM`} WAV at the source rate ${track.deepMastering?.applied ? "from applied revision " + String(track.deepMastering.applied.revision) : "using the same Go DSP parameters"}.`,
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
            {formatTime(track.duration)} · {track.sampleRate / 1000} kHz · WAV
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
      </header>
      <div className="workspace-layout">
        <section className="workspace-canvas">
          <div className="metric-strip" role="region" tabIndex={0} aria-label="Measured audio levels">
            <div>
              <span>Sample peak</span>
              <strong>{levels?.peak ?? "—"}</strong>
              <small>dBFS</small>
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
                  ? "Offline preview matches your settings. Live playback updates independently."
                  : track.mode === "simple"
                    ? "Simple and Advanced share these settings. Set target loudness to measure the requested level; export uses the current settings."
                    : "Playback responds to your controls immediately. Render an offline preview for a full-track check; export always uses current settings."}
            </span>
          </div>
          <p className="disclosure" role="status">
            {sourceLoading ? "Loading stored audio…" : message}
          </p>
          {track.importNotice && <p className="disclosure" role="status">{track.importNotice}</p>}
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
              processing={processing}
              sourceReady={source !== null}
              selectedMoveId={deepMoveId}
              onSelectMove={selectDeepMove}
              onApplyScript={deepPlayback.apply}
              editorOpen={deepEditorOpen}
              onCloseEditor={closeDeepEditor}
              onApply={(next) => {
                dispatch({ type: "UPDATE_TRACK", id: track.id, patch: { advanced: next, shortcutUndo: {} } });
                setMessage("Profile applied to live playback. Adjust it in Advanced mode while you listen.");
              }}
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
        <ControlGroup label="Bit depth">
          <div className="choice-grid">
            {([16, 24, 32] as const).map((depth) => (
              <button
                type="button"
                className={bitDepth === depth ? "choice is-active" : "choice"}
                aria-pressed={bitDepth === depth}
                key={depth}
                onClick={() => {
                  setBitDepth(depth);
                }}
              >
                {depth === 32 ? "32-bit Float" : `${String(depth)}-bit PCM`}
              </button>
            ))}
          </div>
        </ControlGroup>
        <p className="disclosure">
          Source sample rate: {track.sampleRate / 1000} kHz. Original duration
          and stereo frames are preserved. 16-bit and 24-bit PCM clip samples
          outside ±1. Choose 32-bit Float to preserve headroom, or enable the
          limiter before exporting integer PCM.
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
      <ControlGroup label="Saturation character">
        <div
          className="choice-grid"
          role="group"
          aria-label="Saturation character"
        >
          {(["Clean", "Tube", "Tape", "Transformer", ...(["Warm", "Thick", "Crisp"].includes(adv.saturationModule.character) ? [adv.saturationModule.character] : [])] as SaturationCharacter[]).map((char) => (
            <button
              type="button"
              key={char}
              className={
                adv.saturationModule.character === char
                  ? "choice is-active"
                  : "choice"
              }
              aria-pressed={adv.saturationModule.character === char}
              onClick={() => {
                dispatch({
                  type: "UPDATE_SATURATION",
                  trackId: track.id,
                  patch: { character: char },
                });
              }}
            >
              {char}
            </button>
          ))}
        </div>
      </ControlGroup>

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
        max={-0.1}
        step={0.1}
        unit="dBFS"
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

function DeepControls({ track, processing, sourceReady, onApply, selectedMoveId, onSelectMove, editorOpen, onCloseEditor, onApplyScript }: {
  track: Track;
  processing: boolean;
  sourceReady: boolean;
  onApply: (params: AdvancedParams) => void;
  selectedMoveId: string;
  editorOpen: boolean;
  onCloseEditor: () => void;
  onApplyScript: (script: ScriptV2) => Promise<void>;
  onSelectMove: (id: string) => void;
}) {
  const { dispatch } = useStore();
  const [selectedProfile, setSelectedProfile] = useState<ProfileId>(track.profile);
  return (
    <div className="control-stack deep-controls">
      <DeepProposalPanel track={track} sourceReady={sourceReady} selectedMoveId={selectedMoveId} onSelectMove={onSelectMove} editorOpen={editorOpen} onCloseEditor={onCloseEditor} onApply={onApplyScript} />
      <div>
        <h2>Engineer profiles</h2>
        <p>Apply a static tonal starting point, then refine it in Advanced mode.</p>
      </div>
      <ControlGroup label="Engineer profile">
        <div className="profile-list">
          {profiles.map((profile) => (
            <button type="button" key={profile.id}
              className={selectedProfile === profile.id ? "profile-card is-active" : "profile-card"}
              aria-pressed={selectedProfile === profile.id}
              onClick={() => { setSelectedProfile(profile.id); }}>
              <strong>{profile.name}</strong><span>{profile.note}</span>
            </button>
          ))}
        </div>
      </ControlGroup>
      <p className="disclosure">These legacy static profiles apply the same settings throughout your track. Deep proposals above use source-frame automation. Musical role detection and AI repair remain unavailable.</p>
      <Button className="full-button" disabled={processing || !sourceReady} icon={<Icon name="sparkles" />}
        onClick={() => {
          const params = clampAdvancedToSampleRate(mapProfileToDSP(selectedProfile), track.sampleRate);
          dispatch({ type: "UPDATE_TRACK", id: track.id, patch: { profile: selectedProfile } });
          onApply(params);
        }}>
        {processing ? "Rendering profile…" : "Apply profile"}
      </Button>
      <FeatureAnalysisPanel trackId={track.id} audioId={audioKey(track)} sourceReady={sourceReady} />
    </div>
  );
}

function SplitView({ trackId }: { trackId: string }) {
  const { state } = useStore();
  const track = state.tracks.find((item) => item.id === trackId);
  const [count, setCount] = useState(4);
  return (
    <div className="page">
      <PageTitle eyebrow="Smart stem splitter" title="A closer look inside the mix"
        copy="Instrument separation is still in development. No stem audio is generated in this build."
        action={<Link className={buttonClassName("secondary")} href={track ? `/master/${track.id}` : "/"}>
          {track ? "Back to master" : "Import a track"}
        </Link>} />
      <section className="split-intro paper-panel">
        <div><span className="eyebrow">Planned output layouts</span><h2>Choose a stem layout</h2>
          <p>Preview the intended layout. Separation, stem playback and downloads are unavailable.</p></div>
        <div className="stem-count" role="group" aria-label="Stem count">
          {[2,3,4,5,6].map((number) => (
            <button type="button" key={number} aria-pressed={count === number}
              className={count === number ? "is-active" : ""}
              onClick={() => { setCount(number); }}>{number}</button>
          ))}
        </div>
        <div className="stem-preview">{(stemNames.get(count) ?? []).map((name) => <span key={name}>{name}</span>)}</div>
        <p className="disclosure" role="status">Separation unavailable — your original audio is unchanged.</p>
      </section>
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
      target: "−14 LUFS",
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
              <p>Target {album.target}</p>
              <div className="album-score">
                <span>Consistency</span>
                <strong>—</strong>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

function AlbumView({ albumId }: { albumId: string }) {
  const { state, dispatch } = useStore();
  const [working, setWorking] = useState(false);
  const operation = useRef<AbortController | null>(null);
  useEffect(() => () => { operation.current?.abort(); }, []);
  const [message, setMessage] = useState("");
  const [rendered, setRendered] = useState<{ key: string; files: { id: string; title: string; blob: Blob }[] } | null>(null);
  const album =
    state.albums.find((item) => item.id === albumId);

  const albumTracks = (album?.trackIds ?? [])
    .map((id) => state.tracks.find((track) => track.id === id))
    .filter((track): track is Track => track !== undefined);
  const artifactKey = JSON.stringify(albumTracks.map((track) => [track.id, track.sourceRevision, appliedRevisionKey(track) ?? engineParams(track.advanced)]));
  useEffect(() => {
    setRendered((previous) => previous && previous.key !== artifactKey ? null : previous);
  }, [artifactKey]);

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

  const artifacts = rendered?.key === artifactKey ? rendered.files : [];

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
          {albumTracks.some((track) => track.deepMastering?.applied) && <p className="disclosure">Detach Deep automation in each master before applying album normalization. Individual live playback and export keep the applied script.</p>}
          <div className="album-meta">
            <span>{albumTracks.length} tracks</span>
            <span>{album.target}</span>
            <span>{artifacts.length > 0 ? "Masters ready to download" : "In progress"}</span>
          </div>
        </div>
        <Button
          icon={<Icon name="sparkles" />}
          disabled={working || albumTracks.length === 0 || albumTracks.some((track) => track.deepMastering?.applied)}
          onClick={() => void (async () => {
            const controller = new AbortController();
            operation.current?.abort();
            operation.current = controller;
            setWorking(true);
            setMessage("Measuring and rendering each track in sequence…");
            setRendered(null);
            try {
              const prepared: { track: Track; advanced: AdvancedParams; measurement: Awaited<ReturnType<typeof measureAudio>> }[] = [];
              const files: { id: string; title: string; blob: Blob }[] = [];
              let totalBytes = 0;
              for (const track of albumTracks) {
                if (track.deepMastering?.applied) throw new Error("Detach Deep automation in the master before applying album normalization. Your applied script is preserved.");
                const file = await getAudio(audioKey(track));
                if (!file) throw new Error(`The source for “${track.title}” is missing. Import it again.`);
                const advanced = await normalizeSimpleAudio(file, track.advanced, -14, controller.signal);
                const measurement = await measureAudio(file, engineParams(advanced), controller.signal);
                if (totalBytes + measurement.frames * 6 + 44 > 128 * 1024 * 1024) throw new Error("The rendered album exceeds the 128 MiB download cache. Export a smaller sequence or render tracks individually.");
                const blob = await serverRender(file, engineParams(advanced), 24, controller.signal);
                if (controller.signal.aborted) return;
                totalBytes += blob.size;
                files.push({ id: track.id, title: track.title, blob });
                prepared.push({ track, advanced, measurement });
              }
              if (controller.signal.aborted) return;
              for (const item of prepared) {
                dispatch({ type: "UPDATE_TRACK", id: item.track.id, patch: {
                  advanced: item.advanced,
                  metrics: trackMetrics(item.measurement.afterMetrics),
                  measurements: item.measurement.afterMetrics,
                  measurementKind: "album-render",
                } });
              }
              dispatch({ type: "UPDATE_ALBUM", id: album.id, patch: { mastered: true } });
              setRendered({ key: JSON.stringify(prepared.map((item) => [item.track.id, item.track.sourceRevision, engineParams(item.advanced)])), files });
              setMessage("Rendered 24-bit WAV masters are ready below. Original source files are preserved. Downloads remain available until settings change or you leave this page.");
            } catch (error) {
              if (!controller.signal.aborted) setMessage(error instanceof Error ? error.message : "The sequence could not be prepared.");
            } finally { if (!controller.signal.aborted) setWorking(false); }
          })()}
        >
          {working ? "Rendering sequence…" : "Render album masters"}
        </Button>
      </section>
      <p className="disclosure" role="status">{message || "Render a measured master for each song, then download the WAV files individually."}</p>
      {artifacts.length > 0 && <section className="paper-panel" aria-label="Rendered album downloads">
        <h2>Your album masters</h2>
        {artifacts.map((file) => <Button key={file.id} variant="secondary" icon={<Icon name="arrow-down-to-line" />} onClick={() => {
          const url = URL.createObjectURL(file.blob);
          const anchor = document.createElement("a"); anchor.href = url; anchor.download = `${file.title.replace(/[^a-zA-Z0-9_-]/g, "-") || "aurialis"}-album-master.wav`; anchor.click();
          setTimeout(() => { URL.revokeObjectURL(url); }, 1000);
        }}>Download {file.title}</Button>)}
      </section>}
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
                        dispatch({
                          type: "UPDATE_ALBUM",
                          id: album.id,
                          patch: { trackIds: nextIds },
                        });
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
                        dispatch({
                          type: "UPDATE_ALBUM",
                          id: album.id,
                          patch: { trackIds: nextIds },
                        });
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
                      dispatch({
                        type: "UPDATE_ALBUM",
                        id: album.id,
                        patch: {
                          trackIds: album.trackIds.filter(
                            (id) => id !== track.id,
                          ),
                        },
                      });
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
                    dispatch({
                      type: "UPDATE_ALBUM",
                      id: album.id,
                      patch: { trackIds: [...album.trackIds, track.id] },
                    });
                  }}
                >
                  <Icon name="plus" />
                  {track.title}
                </button>
              ))}
          </div>
        </section>
        <section className="paper-panel consistency">
          <div className="section-heading">
            <div>
              <span className="eyebrow">Across the album</span>
              <h2>Saved loudness measurements</h2>
            </div>
            <strong>Target {album.target}</strong>
          </div>
          <div
            className="consistency-chart"
            role="img"
            aria-label="Album loudness contour across sequenced tracks"
          >
            {albumTracks.length > 0 ? (
              albumTracks.map((track, index) => (
                <div key={track.id}>
                  <span
                    style={{
                      height: `${String(Math.max(15, Math.min(95, 55 + (track.metrics.lufs + 18) * 8)))}%`,
                    }}
                  >
                    <i>
                      {track.measurements ? track.metrics.lufs.toFixed(1) : "Unmeasured"}
                    </i>
                  </span>
                  <small>{index + 1}</small>
                </div>
              ))
            ) : (
              <p>Add tracks to see how the sequence moves.</p>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}


function ToolsView() {
  const { state } = useStore();
  const first = state.tracks[0];
  const targetId = first?.id ?? "placeholder";
  return (
    <div className="page">
      <PageTitle
        eyebrow="Focused utilities"
        title="Tools"
        copy="Focused tools for your local audio projects."
      />
      <div className="tools-grid">
        <ToolCard
          icon="scissors"
          eyebrow="Separation"
          title="Smart stem splitter"
          copy="Instrument separation is not available. No stems will be generated."
          href={`/split/${targetId}`}
        />
        <ToolCard
          icon="refresh-cw"
          eyebrow="Direction"
          title="Reference match"
          copy="Measure your starting chain against reference audio, then review bounded EQ and optional width changes."
          href={`/reference/${targetId}`}
        />
        <ToolCard
          icon="check"
          eyebrow="Delivery"
          title="Release check"
          copy="Measure rendered loudness, peak estimates, crest factor and stereo correlation."
          href={`/release-check/${targetId}`}
        />
      </div>
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
  href: string;
}) {
  return (
    <Link className="tool-card" href={href}>
      <div>
        <Icon name={icon} />
      </div>
      <span className="eyebrow">{eyebrow}</span>
      <h2>{title}</h2>
      <p>{copy}</p>
      <span className="text-link">
        Open tool <Icon name="arrow-right" />
      </span>
    </Link>
  );
}
