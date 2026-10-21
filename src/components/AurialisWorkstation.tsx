"use client";

import Link from "next/link";
import {
  engineParams,
  measuredLevels,
  measureAudio,
  trackMetrics,
  normalizeSimpleAudio,
  processPreview,
  readCanonicalWAV,
  serverRender,
  sourcePeaks,
  type StereoPCM,
} from "@/lib/browser-engine";
import { DSPModule } from "./shared/DSPModule";
import { RealTransport } from "./shared/RealTransport";
import { usePathname, useRouter } from "next/navigation";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
} from "react";
import {
  createDefaultAdvancedParams,
  mapSimpleToDSP,
  mapProfileToDSP,
} from "@/lib/audio-dsp";
import { deleteAudio, saveAudio, getAudio } from "@/lib/db";
import { profiles, useStore } from "@/lib/store";
import type {
  Album,
  AdvancedParams,
  EQBandId,
  EQBandParams,
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
  Waveform,
  formatTime,
  statusLabel,
} from "./shared/Primitives";

type WorkstationRoute =
  | "home"
  | "library"
  | "master"
  | "split"
  | "albums"
  | "album"
  | "reference"
  | "release-check"
  | "tools";

const stemNames = new Map<number, string[]>([
  [2, ["Vocals", "Instrumental"]],
  [3, ["Vocals", "Drums", "Other"]],
  [4, ["Vocals", "Drums", "Bass", "Other"]],
  [5, ["Vocals", "Drums", "Bass", "Melody", "Other"]],
  [6, ["Vocals", "Drums", "Bass", "Guitar", "Piano", "Other"]],
]);

const MAX_SOURCE_BYTES = 128 * 1024 * 1024;
const MAX_SOURCE_FRAMES = 16 * 1024 * 1024;

// Capacity preflight only. The Go server remains the authoritative container validator.
async function wavCapacity(file: File): Promise<{ frames: number; sampleRate: number } | null> {
  const view = new DataView(await file.slice(0, 65536).arrayBuffer());
  const id = (offset: number) => String.fromCharCode(...Array.from({ length: 4 }, (_, index) => view.getUint8(offset + index)));
  if (view.byteLength < 12 || id(0) !== "RIFF" || id(8) !== "WAVE") return null;
  let blockAlign = 0;
  let sampleRate = 0;
  for (let offset = 12; offset + 8 <= view.byteLength;) {
    const length = view.getUint32(offset + 4, true);
    if (id(offset) === "data") return blockAlign > 0 && sampleRate > 0 ? { frames: Math.floor(length / blockAlign), sampleRate } : null;
    if (offset + 8 + length > view.byteLength) return null;
    if (id(offset) === "fmt " && length >= 16) {
      sampleRate = view.getUint32(offset + 12, true);
      blockAlign = view.getUint16(offset + 20, true);
    }
    offset += 8 + length + length % 2;
  }
  return null;
}

function paramsAtSampleRate(params: AdvancedParams, sampleRate: number): AdvancedParams {
  const maximum = Math.min(18000, Math.floor(sampleRate * 0.47));
  return { ...params, eqBands: params.eqBands.map((band) => ({ ...band, freqHz: Math.min(maximum, Math.max(20, band.freqHz)) })) as AdvancedParams["eqBands"] };
}

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
  route,
  paramId,
}: {
  route: WorkstationRoute;
  paramId?: string;
}) {
  const pathname = usePathname();
  const { state } = useStore();
  const [prefsOpen, setPrefsOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [livePath, setLivePath] = useState<string | null>(pathname);

  useEffect(() => {
    setLivePath(window.location.pathname);
  }, [pathname]);

  const inWorkspace = route === "master";
  const defaultTrackId = state.tracks[0]?.id ?? "placeholder";
  const resolvedId = resolveDynamicId(paramId, livePath, defaultTrackId);

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
        {route === "reference" && <ReferenceView key={resolvedId} trackId={resolvedId} />}
        {route === "release-check" && <ReleaseView key={resolvedId} trackId={resolvedId} />}
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
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(false);

  const importFile = async (file?: File) => {
    if (!file) return;
    if (loading) return;
    if (
      !/\.wav$/i.test(file.name) ||
      file.size === 0 ||
      file.size > MAX_SOURCE_BYTES
    ) {
      setMessage(
        "Choose a nonempty PCM WAV file up to 128 MiB. Other codecs are not supported.",
      );
      return;
    }
    setLoading(true);
    setMessage(
      "Validating and reconstructing your WAV on the local Go server…",
    );
    const id = `track-${crypto.randomUUID()}`;
    const title = file.name.replace(/\.[^.]+$/, "").replace(/[-_]/g, " ");
    let canonical: Blob;
    let pcm: StereoPCM;
    let measurement: Awaited<ReturnType<typeof measureAudio>>;
    let storageWarning = "";
    try {
      const capacity = await wavCapacity(file);
      if (capacity && capacity.frames > MAX_SOURCE_FRAMES) throw new Error(`This WAV exceeds the ${formatTime(MAX_SOURCE_FRAMES / capacity.sampleRate)} duration limit at ${String(capacity.sampleRate / 1000)} kHz. Use a shorter track or a lower source sample rate.`);
      canonical = await serverRender(file, { bypass: true }, 32);
      pcm = await readCanonicalWAV(canonical);
      measurement = await measureAudio(canonical);
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "This file could not be imported.",
      );
      setLoading(false);
      return;
    }
    try {
      await saveAudio(id, canonical);
    } catch {
      storageWarning =
        "Browser storage is unavailable; keep this tab open and export before leaving.";
    }
    const duration = pcm.left.length / pcm.sampleRate;

    const seed =
      Array.from(file.name).reduce((sum, char) => sum + char.charCodeAt(0), 0) %
      97;
    const nowIso = new Date().toISOString();
    const track: Track = {
      id,
      title,
      filename: file.name,
      duration,
      size: file.size,
      format: file.name.split(".").pop()?.toUpperCase() ?? "WAV",
      sampleRate: pcm.sampleRate,
      status: "ready",
      createdAt: nowIso,
      updatedAt: nowIso,
      seed,
      source: "upload",
      mode: "advanced",
      genre: "Pop",
      tone: "Warm",
      intensity: 50,
      target: "Streaming",
      metrics: trackMetrics(measurement.afterMetrics),
      measurements: measurement.afterMetrics,
      advanced: paramsAtSampleRate(createDefaultAdvancedParams(), pcm.sampleRate),
      profile: "modern_pop_polish",
      persistenceWarning: storageWarning,
    };
    dispatch({ type: "ADD_TRACK", track });
    setLoading(false);
    setMessage(storageWarning);
    router.push(`/master/${id}`);
  };

  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const file = Array.from(event.clipboardData?.files ?? []).find((item) =>
        item.type.startsWith("audio/"),
      );
      if (file) void importFile(file);
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
            void importFile(event.dataTransfer.files[0]);
          }}
          role="region"
          aria-label="Bring in a track: drop audio or choose a file"
        >
          <input
            ref={inputRef}
            type="file"
            accept="audio/wav,.wav"
            hidden
            aria-label="Upload audio file"
            onChange={(e) => void importFile(e.target.files?.[0])}
          />
          <div className="drop-icon">
            <Icon name="upload" />
          </div>
          <h2>{loading ? "Validating WAV…" : "Bring in a track"}</h2>
          <p>
            {message ||
              "Drop audio here, paste it, or choose a file from your device."}
          </p>
          <span className="file-types">PCM WAV · up to 128 MiB · 16,777,216 frames maximum</span>
          <Button
            variant="primary"
            icon={<Icon name="file-audio" />}
            disabled={loading}
            onClick={() => inputRef.current?.click()}
          >
            Choose audio
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
        <span className={`status status--${track.status}`}>
          {statusLabel(track.status)}
        </span>
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

function LibraryView() {
  const { state, dispatch } = useStore();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("All");
  const [pendingDelete, setPendingDelete] = useState<Track | null>(null);

  const tracks = state.tracks.filter(
    (track) =>
      track.title.toLowerCase().includes(query.toLowerCase()) &&
      (filter === "All" || statusLabel(track.status) === filter.toLowerCase()),
  );

  return (
    <div className="page">
      <PageTitle
        eyebrow="Your local archive"
        title="Library"
        copy={`${String(state.tracks.length)} projects stored only in this browser.`}
        action={
          <Link className={buttonClassName("primary")} href="/">
            <Icon name="plus" />
            New project
          </Link>
        }
      />
      <div className="library-tools">
        <label className="search-field">
          <Icon name="search" />
          <input
            value={query}
            aria-label="Search your library"
            onChange={(e) => {
              setQuery(e.target.value);
            }}
            placeholder="Search your library"
          />
        </label>
        <div
          className="filter-row"
          role="group"
          aria-label="Filter projects by status"
        >
          {["All", "Draft", "Ready", "Mastered", "Needs review"].map((item) => (
            <button
              type="button"
              className={filter === item ? "chip is-active" : "chip"}
              aria-pressed={filter === item}
              onClick={() => {
                setFilter(item);
              }}
              key={item}
            >
              {item}
            </button>
          ))}
        </div>
      </div>
      <div className="library-list">
        <div className="library-list-head">
          <span>Project</span>
          <span>Format</span>
          <span>Loudness</span>
          <span>Modified</span>
          <span />
        </div>
        {tracks.map((track, index) => (
          <div className="library-item" key={track.id}>
            <Link className="library-project" href={`/master/${track.id}`}>
              <Artwork seed={track.seed} index={index} />
              <span>
                <strong>{track.title}</strong>
                <small>
                  {formatTime(track.duration)} ·{" "}
                  <span className={`status status--${track.status}`}>
                    {statusLabel(track.status)}
                  </span>
                </small>
              </span>
            </Link>
            <span>
              {track.format}
              <small>{track.sampleRate / 1000} kHz</small>
            </span>
            <span className="metric-number">
              {track.measurements ? track.metrics.lufs.toFixed(1) : "Unmeasured"}
              <small>LUFS</small>
            </span>
            <span>
              {new Date(track.updatedAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}<small>Local</small>
            </span>
            <button
              type="button"
              className="icon-button"
              aria-label={`Delete ${track.title}`}
              onClick={() => {
                setPendingDelete(track);
              }}
            >
              <Icon name="trash" />
            </button>
          </div>
        ))}
      </div>
      <div className="storage-note">
        <div>
          <Icon name="disc" />
          <span>
            <strong>Browser storage</strong>
            <small>Audio and settings stay on this device.</small>
          </span>
        </div>
        <span className="disclosure">
          Stored only in this browser. Browser data can be cleared by your
          device.
        </span>
      </div>

      <Modal
        open={pendingDelete !== null}
        eyebrow="Confirm removal"
        title={
          pendingDelete ? `Delete “${pendingDelete.title}”?` : "Delete track"
        }
        onClose={() => {
          setPendingDelete(null);
        }}
        actions={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setPendingDelete(null);
              }}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              icon={<Icon name="trash" />}
              onClick={() => {
                if (pendingDelete) {
                  const id = pendingDelete.id;
                  dispatch({ type: "DELETE_TRACK", id });
                  void deleteAudio(id);
                  setPendingDelete(null);
                }
              }}
            >
              Delete project
            </Button>
          </>
        }
      >
        <p style={{ color: "var(--ink-soft)", margin: 0 }}>
          This removes the project and its locally stored audio from this
          browser.
        </p>
      </Modal>
    </div>
  );
}

function MasterView({ trackId }: { trackId: string }) {
  const { state, dispatch } = useStore();
  const router = useRouter();
  const track = state.tracks.find((item) => item.id === trackId);
  const [processing, setProcessing] = useState(false);
  const [source, setSource] = useState<StereoPCM | null>(null);
  const [preview, setPreview] = useState<StereoPCM | null>(null);
  const [renderedKey, setRenderedKey] = useState("");
  const [ab, setAb] = useState<"A" | "B">("A");
  const [playheadRatio, setPlayheadRatio] = useState(0);
  const [activeBandId, setActiveBandId] = useState<EQBandId>("low");
  const [exportOpen, setExportOpen] = useState(false);
  const [bitDepth, setBitDepth] = useState<ExportBitDepth>(24);
  const [message, setMessage] = useState("");
  const [sourceBlob, setSourceBlob] = useState<Blob | null>(null);
  const renderAbort = useRef<AbortController | null>(null);
  useEffect(
    () => () => {
      renderAbort.current?.abort();
    },
    [],
  );
  const settingsKey = track ? JSON.stringify(engineParams(track.advanced)) : "";
  const fresh = renderedKey === settingsKey && preview !== null;
  const audible = ab === "B" && fresh ? preview : source;
  const levels = useMemo(
    () => (audible ? measuredLevels(audible) : null),
    [audible],
  );
  const peaks = useMemo(() => (source ? sourcePeaks(source) : []), [source]);

  useEffect(() => {
    let cancelled = false;
    setSource(null);
    setPreview(null);
    setSourceBlob(null);
    setRenderedKey("");
    setMessage("");
    async function prepare() {
      if (!track) return;
      try {
        const blob = await getAudio(track.id);
        if (!blob)
          throw new Error(
            "The source audio is missing. Import the file again to create a new project.",
          );
        const canonical = await serverRender(blob, { bypass: true }, 32);
        const pcm = await readCanonicalWAV(canonical);
        if (!cancelled) {
          setSource(pcm);
          setSourceBlob(canonical);
          const advanced = paramsAtSampleRate(track.advanced, pcm.sampleRate);
          if (JSON.stringify(advanced) !== JSON.stringify(track.advanced)) dispatch({ type: "UPDATE_TRACK", id: track.id, patch: { advanced } });
          setMessage("Source ready. Adjust settings and render a preview.");
        }
      } catch (error) {
        if (!cancelled)
          setMessage(
            error instanceof Error
              ? error.message
              : "The source could not be loaded.",
          );
      }
    }
    void prepare();
    return () => {
      cancelled = true;
    };
  }, [track?.id]);

  async function renderPreview(params: AdvancedParams = track?.advanced ?? createDefaultAdvancedParams()) {
    if (!track || !source) return;
    renderAbort.current?.abort();
    const controller = new AbortController();
    renderAbort.current = controller;
    setProcessing(true);
    setMessage(
      "Rendering the uploaded audio with the shared Go WebAssembly engine…",
    );
    try {
      const pcm = await processPreview(
        source,
        params,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      setPreview(pcm);
      setRenderedKey(JSON.stringify(engineParams(params)));
      setAb("B");
      setMessage("Preview ready. Playback uses the shared Go DSP engine.");
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
  async function download() {
    if (!track || !sourceBlob) return;
    setProcessing(true);
    setMessage("Rendering WAV from the uploaded source…");
    try {
      const blob = await serverRender(
        sourceBlob,
        engineParams(track.advanced),
        bitDepth,
      );
      const url = URL.createObjectURL(blob),
        anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${track.title.replace(/[^a-zA-Z0-9_-]/g, "-") || "aurialis"}-${String(bitDepth)}bit.wav`;
      anchor.click();
      setTimeout(() => {
        URL.revokeObjectURL(url);
      }, 1000);
      setMessage(
        `Exported ${bitDepth === 32 ? "32-bit float" : `${String(bitDepth)}-bit PCM`} WAV at the source rate using the same Go DSP parameters.`,
      );
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : "Export failed. Please retry.",
      );
    } finally {
      setProcessing(false);
    }
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
            router.push("/library");
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
          <div className="metric-strip" aria-label="Measured audio levels">
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
              <strong>{ab === "B" && fresh ? "B" : "A"}</strong>
              <small>{ab === "B" && fresh ? "Processed" : "Original"}</small>
            </div>
          </div>
          <Waveform
            seed={track.seed}
            duration={track.duration}
            peaks={peaks}
            playheadRatio={playheadRatio}
            onSeekRatio={setPlayheadRatio}
          />
          <RealTransport
            pcm={audible}
            sourcePcm={source}
            processedPcm={preview}
            ab={ab}
            onAB={setAb}
            processedReady={fresh}
            playheadRatio={playheadRatio}
            onSeekRatio={setPlayheadRatio}
          />
          <div className="render-actions">
            <Button
              disabled={!source || processing}
              onClick={() => void renderPreview()}
              icon={<Icon name={processing ? "refresh-cw" : "play"} />}
            >
              {processing ? "Rendering…" : "Render preview"}
            </Button>
            <span className="disclosure">
              {fresh
                ? "Preview matches your settings."
                : "Apply your settings to hear a fresh preview. Export always renders current settings."}
            </span>
          </div>
          <p className="disclosure" role="status">
            {message || "Loading source audio…"}
          </p>
          {track.persistenceWarning && (
            <p className="disclosure" role="alert">
              {track.persistenceWarning}
            </p>
          )}
          {track.mode !== "deep" && (
            <>
              <SpectrumChart
                seed={track.seed}
                eqBands={
                  track.advanced.eqEnabled
                    ? track.advanced.eqBands
                    : track.advanced.eqBands.map((band) => ({
                        ...band,
                        enabled: false,
                      }))
                }
                activeBandId={activeBandId}
                sampleRate={track.sampleRate}
                onSelectBand={setActiveBandId}
                onBandChange={(bandId, patch) => {
                  const bounded = typeof patch.freqHz === "number" ? { ...patch, freqHz: Math.min(Math.floor(track.sampleRate * 0.47), Math.max(20, patch.freqHz)) } : patch;
                  dispatch({ type: "UPDATE_EQ_BAND", trackId: track.id, bandId, patch: bounded });
                }}
              />
              <p className="disclosure">
                The curve approximates your EQ settings; it is not a measured audio
                spectrum. Preview and export share the same Go processor.
              </p>
            </>
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
          {track.mode === "simple" && (
            <SimpleControls
              track={track}
              processing={processing}
              onApply={() => void (async () => {
                if (!sourceBlob) return;
                setProcessing(true);
                try {
                const mapped = mapSimpleToDSP(
                  track.genre,
                  track.tone,
                  track.intensity,
                  track.target,
                  track.advanced,
                );
                const next = await normalizeSimpleAudio(sourceBlob, paramsAtSampleRate(mapped, track.sampleRate), mapped.limiter.targetLufs);
                dispatch({ type: "UPDATE_TRACK", id: track.id, patch: { advanced: next } });
                await renderPreview(next);
                } catch (error) {
                  setMessage(error instanceof Error ? error.message : "Could not prepare this master.");
                } finally { setProcessing(false); }
              })()}
            />
          )}
          {track.mode === "deep" && (
            <DeepControls
              track={track}
              processing={processing}
              onApply={(next) => {
                dispatch({ type: "UPDATE_TRACK", id: track.id, patch: { advanced: next } });
                void renderPreview(next);
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
        onClose={() => {
          setExportOpen(false);
        }}
        actions={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setExportOpen(false);
              }}
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
  const selectedBand =
    adv.eqBands.find((b) => b.id === activeBandId) ?? adv.eqBands[1];

  return (
    <div className="control-stack">
      <div>
        <h2>Shape the detail</h2>
        <p>Adjust a module, then render a preview to hear your settings.</p>
      </div>

      <SliderField
        label="Input gain"
        value={adv.input}
        min={-6}
        max={6}
        step={0.5}
        unit="dB"
        onChange={(input) => {
          dispatch({ type: "UPDATE_INPUT_GAIN", trackId: track.id, input });
        }}
      />

      <DSPModule title="Equalizer">
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

      <SliderField
        label={`${selectedBand.label} gain`}
        value={selectedBand.gainDb}
        min={-12}
        max={12}
        step={0.5}
        unit="dB"
        onChange={(gainDb) => {
          dispatch({
            type: "UPDATE_EQ_BAND",
            trackId: track.id,
            bandId: selectedBand.id,
            patch: { gainDb },
          });
        }}
      />
      <SliderField
        label={`${selectedBand.label} frequency`}
        value={Math.min(selectedBand.freqHz, Math.floor(track.sampleRate * 0.47))}
        min={20}
        max={Math.min(18000, Math.floor(track.sampleRate * 0.47))}
        step={10}
        unit="Hz"
        onChange={(freqHz) => {
          dispatch({
            type: "UPDATE_EQ_BAND",
            trackId: track.id,
            bandId: selectedBand.id,
            patch: { freqHz },
          });
        }}
      />
      <SliderField
        label={`${selectedBand.label} Q`}
        value={selectedBand.q}
        min={0.3}
        max={8.0}
        step={0.1}
        onChange={(q) => {
          dispatch({
            type: "UPDATE_EQ_BAND",
            trackId: track.id,
            bandId: selectedBand.id,
            patch: { q },
          });
        }}
      />

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
      <SliderField
        label="Release"
        value={adv.compressor.release}
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
        Mono bass below 110 Hz
      </label>

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
      <SliderField
        label="Saturation"
        value={adv.saturationModule.drive}
        min={0}
        max={40}
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
      <ControlGroup label="Saturation character">
        <div
          className="choice-grid"
          role="group"
          aria-label="Saturation character"
        >
          {(["Warm", "Thick", "Crisp"] as SaturationCharacter[]).map((char) => (
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

      </DSPModule>
      <Button
        variant="secondary"
        icon={<Icon name="rotate-ccw" />}
        onClick={() => {
          dispatch({ type: "UPDATE_TRACK", id: track.id, patch: { advanced: paramsAtSampleRate(createDefaultAdvancedParams(), track.sampleRate) } });
        }}
      >
        Reset modules
      </Button>
    </div>
  );
}

function SimpleControls({
  track,
  processing,
  onApply,
}: {
  track: Track;
  processing: boolean;
  onApply: () => void;
}) {
  const { dispatch } = useStore();
  const update = (patch: Partial<Track>) => {
    dispatch({ type: "UPDATE_TRACK", id: track.id, patch });
  };

  return (
    <div className="control-stack">
      <div>
        <h2>Find the feeling</h2>
        <p>Choose a broad musical direction. Real DSP parameters map to your choices.</p>
      </div>
      <ControlGroup label="Genre">
        <div className="choice-grid">
          {["Pop", "Hip-hop", "Rock", "Electronic", "Acoustic", "R&B"].map(
            (item) => (
              <button
                type="button"
                className={track.genre === item ? "choice is-active" : "choice"}
                aria-pressed={track.genre === item}
                key={item}
                onClick={() => {
                  update({ genre: item });
                }}
              >
                {item}
              </button>
            ),
          )}
        </div>
      </ControlGroup>
      <ControlGroup label="Tone intention">
        <div className="choice-grid">
          {["Warm", "Open", "Punchy", "Intimate", "Wide", "Clean"].map(
            (item) => (
              <button
                type="button"
                className={track.tone === item ? "choice is-active" : "choice"}
                aria-pressed={track.tone === item}
                key={item}
                onClick={() => {
                  update({ tone: item });
                }}
              >
                {item}
              </button>
            ),
          )}
        </div>
      </ControlGroup>
      <SliderField
        label="Intensity"
        value={track.intensity}
        min={0}
        max={100}
        step={1}
        unit="%"
        onChange={(intensity) => {
          update({ intensity });
        }}
      />
      <ControlGroup label="Output target">
        <div className="select-wrap">
          <select
            value={track.target}
            aria-label="Output target"
            onChange={(e) => {
              update({ target: e.target.value });
            }}
          >
            <option value="Streaming">Streaming (−14 LUFS)</option>
            <option value="Loud">Loud (−9 LUFS)</option>
            <option value="Dynamic">Dynamic (−16 LUFS)</option>
            <option value="Podcast">Podcast (−16 LUFS)</option>
          </select>
          <Icon name="chevron-down" />
        </div>
      </ControlGroup>
      <Button
        className="full-button"
        disabled={processing}
        icon={
          <Icon
            name={processing ? "refresh-cw" : "sparkles"}
            className={processing ? "spin" : ""}
          />
        }
        onClick={onApply}
      >
        {processing ? "Rendering master…" : "Apply master direction"}
      </Button>
    </div>
  );
}

function DeepControls({ track, processing, onApply }: {
  track: Track;
  processing: boolean;
  onApply: (params: AdvancedParams) => void;
}) {
  const { dispatch } = useStore();
  const [selectedProfile, setSelectedProfile] = useState<ProfileId>(track.profile);
  return (
    <div className="control-stack deep-controls">
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
      <p className="disclosure">Musical section detection, timeline automation and AI repair are not available. These profiles apply the same settings throughout your track.</p>
      <Button className="full-button" disabled={processing} icon={<Icon name="sparkles" />}
        onClick={() => {
          const params = paramsAtSampleRate(mapProfileToDSP(selectedProfile), track.sampleRate);
          dispatch({ type: "UPDATE_TRACK", id: track.id, patch: { profile: selectedProfile } });
          onApply(params);
        }}>
        {processing ? "Rendering profile…" : "Apply profile"}
      </Button>
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
  const artifactKey = JSON.stringify(albumTracks.map((track) => [track.id, engineParams(track.advanced)]));
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
          <div className="album-meta">
            <span>{albumTracks.length} tracks</span>
            <span>{album.target}</span>
            <span>{artifacts.length > 0 ? "Masters ready to download" : "In progress"}</span>
          </div>
        </div>
        <Button
          icon={<Icon name="sparkles" />}
          disabled={working || albumTracks.length === 0}
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
                const file = await getAudio(track.id);
                if (!file) throw new Error(`The source for “${track.title}” is missing. Import it again.`);
                const advanced = await normalizeSimpleAudio(file, track.advanced, -14, controller.signal);
                const measurement = await measureAudio(file, engineParams(advanced), controller.signal);
                if (totalBytes + measurement.frames * 6 + 44 > 128 * 1024 * 1024) throw new Error("The rendered album exceeds the 128 MiB download cache. Export a smaller sequence or render tracks individually.");
                const blob = await serverRender(file, engineParams(advanced), 24);
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
                } });
              }
              dispatch({ type: "UPDATE_ALBUM", id: album.id, patch: { mastered: true } });
              setRendered({ key: JSON.stringify(prepared.map((item) => [item.track.id, engineParams(item.advanced)])), files });
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
              <h2>Loudness contour</h2>
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

function ReferenceView({ trackId }: { trackId: string }) {
  const { state, dispatch } = useStore();
  const router = useRouter();
  const track =
    state.tracks.find((item) => item.id === trackId);
  const [referenceId, setReferenceId] = useState(
    state.tracks.find((item) => item.id !== track?.id)?.id ?? "",
  );
  const [amount, setAmount] = useState(62);
  const [protectLowEnd, setProtectLowEnd] = useState(true);
  const [includeWidth, setIncludeWidth] = useState(false);

  if (!track) return <div className="page"><PageTitle eyebrow="Reference settings" title="Choose your audio first" copy="Import a track, then compare its EQ settings with another project." /><Link className={buttonClassName("primary")} href="/">Import audio</Link></div>;
  const reference = state.tracks.find((item) => item.id === referenceId);

  return (
    <div className="page">
      <PageTitle
        eyebrow="Reference direction"
        title="Compare without copying"
        copy="Compare two projects and blend their EQ settings. Audio spectrum matching remains in development."
        action={
          <Button
            variant="secondary"
            icon={<Icon name="arrow-left" />}
            onClick={() => {
              router.push(`/master/${track.id}`);
            }}
          >
            Back to master
          </Button>
        }
      />
      <div className="reference-layout">
        <section className="paper-panel">
          <div className="compare-head">
            <div>
              <span className="eyebrow">Source</span>
              <h2>{track.title}</h2>
              <MetricMini track={track} />
            </div>
            <span className="versus">and</span>
            <div>
              <span className="eyebrow">Reference</span>
              <div className="select-wrap">
                <select
                  aria-label="Reference track"
                  value={referenceId}
                  onChange={(e) => {
                    setReferenceId(e.target.value);
                  }}
                >
                  <option value="">Choose a reference project</option>
                  {state.tracks
                    .filter((item) => item.id !== track.id)
                    .map((item) => (
                      <option value={item.id} key={item.id}>
                        {item.title}
                      </option>
                    ))}
                </select>
                <Icon name="chevron-down" />
              </div>
              {reference !== undefined && <MetricMini track={reference} />}
            </div>
          </div>
          <div className="overlay-chart">
            <SpectrumChart seed={track.seed} eqBands={track.advanced.eqBands} />
            {reference !== undefined && (
              <svg
                className="reference-line"
                viewBox="0 0 100 60"
                preserveAspectRatio="none"
                role="img"
                aria-label={`Reference tonal contour for ${reference.title}`}
              >
                <title>{`Reference tonal contour for ${reference.title}`}</title>
                <polyline
                  points={reference.advanced.eqBands
                    .map((band, idx) => {
                      const x = (idx / 4) * 100;
                      const y = Math.max(5, Math.min(55, 30 - band.gainDb * 2.5));
                      return `${x.toFixed(1)},${y.toFixed(1)}`;
                    })
                    .join(" ")}
                  fill="none"
                  stroke="var(--moss)"
                  strokeWidth="1.8"
                  vectorEffect="non-scaling-stroke"
                />
              </svg>
            )}
          </div>
        </section>
        <aside className="paper-panel reference-controls">
          <span className="eyebrow">Match direction</span>
          <h2>Keep what matters</h2>
          <p>
            Blend the other project’s EQ settings into this project. This does not measure or match the source audio spectrum.
          </p>
          <SliderField
            label="Match amount"
            value={amount}
            min={0}
            max={100}
            step={1}
            unit="%"
            onChange={setAmount}
          />
          <label className="check-row">
            <input type="checkbox" checked={protectLowEnd} onChange={(event) => { setProtectLowEnd(event.target.checked); }} />
            <span><Icon name="check" /></span>Protect low end
          </label>
          <label className="check-row">
            <input type="checkbox" checked={includeWidth} onChange={(event) => { setIncludeWidth(event.target.checked); }} />
            <span><Icon name="check" /></span>Include width
          </label>
          <Button
            className="full-button"
            disabled={!reference}
            icon={<Icon name="arrow-right" />}
            onClick={() => {
              if (reference) {
                const ratio = amount / 100;
                const nextBands = track.advanced.eqBands.map((band, i) => {
                  const refBand = reference.advanced.eqBands.at(i);
                  const refGain = refBand ? refBand.gainDb : 0;
                  const delta = protectLowEnd && i < 2 ? 0 : (refGain - band.gainDb) * ratio;
                  return {
                    ...band,
                    gainDb: Math.round((band.gainDb + delta) * 10) / 10,
                  };
                }) as [
                  EQBandParams,
                  EQBandParams,
                  EQBandParams,
                  EQBandParams,
                  EQBandParams,
                ];
                const widthDelta =
                  (reference.advanced.stereo.width -
                    track.advanced.stereo.width) *
                  ratio;
                const nextWidth = includeWidth ? Math.round(track.advanced.stereo.width + widthDelta) : track.advanced.stereo.width;
                dispatch({
                  type: "UPDATE_TRACK",
                  id: track.id,
                  patch: {
                    advanced: {
                      ...track.advanced,
                      eqBands: nextBands,
                      stereo: {
                        ...track.advanced.stereo,
                        width: nextWidth,
                      },
                    },
                    tone: `Match: ${reference.title}`,
                    intensity: amount,
                  },
                });
              } else {
                dispatch({
                  type: "UPDATE_SIMPLE",
                  id: track.id,
                  patch: { tone: "Reference-led", intensity: amount },
                });
              }
              router.push(`/master/${track.id}`);
            }}
          >
            Apply EQ settings
          </Button>
        </aside>
      </div>
    </div>
  );
}

function MetricMini({ track }: { track: Track }) {
  return (
    <div className="metric-mini">
      <span>
        <strong>
          {track.measurements ? track.metrics.lufs.toFixed(1) : "Unmeasured"}
        </strong>
        <small>LUFS</small>
      </span>
      <span>
        <strong>{track.metrics.dynamics.toFixed(1)}</strong>
        <small>Crest dB</small>
      </span>
      <span>
        <strong>{track.advanced.stereo.width}%</strong>
        <small>Width</small>
      </span>
    </div>
  );
}

function ReleaseView({ trackId }: { trackId: string }) {
  const { state } = useStore();
  const track = state.tracks.find((item) => item.id === trackId);
  const [platform, setPlatform] = useState("Streaming");
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState("");
  const [scan, setScan] = useState<{ key: string; metrics: Awaited<ReturnType<typeof measureAudio>>["afterMetrics"] } | null>(null);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => { pending.current?.abort(); }, []);
  if (!track) return <div className="page"><PageTitle eyebrow="Release check" title="Choose your audio first" copy="Import a track to measure its rendered audio." /><Link className={buttonClassName("primary")} href="/">Import audio</Link></div>;
  const key = JSON.stringify([track.id, engineParams(track.advanced)]);
  const metrics = scan?.key === key ? scan.metrics : null;
  const targetLufs = platform === "Dynamic" || platform === "Spoken word" ? -16 : -14;
  const maxPeak = -1;
  const loudnessDelta = metrics ? Math.abs(metrics.integratedLufs - targetLufs) : 0;
  const checks: [string, string, "pass" | "warn", string][] = metrics ? [
    ["Integrated loudness", `${metrics.integratedLufs.toFixed(1)} LUFS`, loudnessDelta <= 1 ? "pass" : "warn", `Working target ${String(targetLufs)} LUFS; measured difference ${loudnessDelta.toFixed(1)} LU.`],
    ["Reconstructed peak estimate", `${metrics.truePeakDbtp.toFixed(1)} dBTP`, metrics.truePeakDbtp <= maxPeak ? "pass" : "warn", "4× FIR estimate. Leave headroom for delivery codecs; this is not a delivery certification."],
    ["Sample peak", `${metrics.samplePeakDbfs.toFixed(1)} dBFS`, metrics.clippingSamples === 0 ? "pass" : "warn", `${String(metrics.clippingSamples)} samples at or above the clipping threshold.`],
    ["Crest factor", `${metrics.dynamicRangeDb.toFixed(1)} dB`, metrics.dynamicRangeDb >= 6 ? "pass" : "warn", "Peak-to-RMS diagnostic; this is not loudness range (LRA) or a DR certification."],
    ["Stereo correlation", metrics.correlation.toFixed(2), metrics.correlation >= 0 ? "pass" : "warn", "Negative correlation can indicate mono cancellation. Listen to the rendered master in mono."],
  ] : [];
  const score = metrics ? Math.round(100 * checks.filter((check) => check[2] === "pass").length / checks.length) : undefined;
  const run = async () => {
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    setScanning(true); setError("");
    try {
      const file = await getAudio(track.id);
      if (!file) throw new Error("The source audio is missing. Import the track again.");
      const result = await measureAudio(file, engineParams(track.advanced), controller.signal);
      if (!controller.signal.aborted) setScan({ key, metrics: result.afterMetrics });
    } catch (cause) {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Measurement failed. Please retry.");
    } finally { if (!controller.signal.aborted) setScanning(false); }
  };
  return (
    <div className="page">
      <PageTitle eyebrow="Release check" title="Ready for the handoff?" copy="Measure your current master against working delivery targets."
        action={<Link className={buttonClassName("secondary")} href={`/master/${track.id}`}>Back to master</Link>} />
      <div className="release-top paper-panel">
        <div className="score-ring" aria-label="Checks within working targets"><strong>{score ?? "—"}</strong><span>checks passed</span></div>
        <div><span className="eyebrow">Selected release</span><h2>{track.title}</h2>
          <p>{metrics ? "Measurements reflect the current rendered settings." : "Run a check to measure actual rendered audio. Settings changes invalidate the previous check."}</p>
          <div className="platforms" role="group" aria-label="Working delivery target">
            {["Streaming", "Dynamic", "Spoken word"].map((item) => <button type="button" key={item} className={platform === item ? "chip is-active" : "chip"} aria-pressed={platform === item} onClick={() => { setPlatform(item); }}>{item}</button>)}
          </div>
        </div>
        <Button onClick={() => void run()} disabled={scanning} icon={<Icon name={scanning ? "refresh-cw" : "gauge"} />}>{scanning ? "Measuring audio…" : "Run release check"}</Button>
      </div>
      <p className="disclosure" role={error ? "alert" : "status"}>{error || "Targets are working preferences, not platform requirements or delivery certification."}</p>
      {metrics && <section className="check-list">
        <div className="check-list-head"><span>Check</span><span>Reading</span><span>Guidance</span></div>
        {checks.map(([name, value, status, note]) => <div className="check-item" key={name}>
          <span className={`check-icon check-icon--${status}`}><Icon name={status === "pass" ? "check" : "circle-alert"} /></span>
          <strong>{name} ({status === "pass" ? "Pass" : "Review"})</strong><span>{value}</span><p>{note}</p>
        </div>)}
        <div className="report-actions"><Button variant="secondary" icon={<Icon name="arrow-down-to-line" />} onClick={() => {
          const url = URL.createObjectURL(new Blob([JSON.stringify({ track: track.title, target: platform, targetLufs, score, metrics, checks, settings: engineParams(track.advanced) }, null, 2)], { type: "application/json" }));
          const anchor = document.createElement("a"); anchor.href = url; anchor.download = "aurialis-audio-review.json"; anchor.click();
          setTimeout(() => { URL.revokeObjectURL(url); }, 1000);
        }}>Download JSON report</Button></div>
      </section>}
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
          copy="Reference audio analysis and automatic matching are not available."
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
