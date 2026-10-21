"use client"

import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import {
  useEffect,
  useRef,
  useState,
  type DragEvent,
} from "react"
import {
  computeEffectiveMetrics,
  renderMasteredWav,
} from "@/lib/audio-dsp"
import { deleteAudio, saveAudio } from "@/lib/db"
import { generateScript, profiles, useStore } from "@/lib/store"
import type {
  Album,
  EQBandId,
  ExportBitDepth,
  MasterMode,
  Move,
  SaturationCharacter,
  Stem,
  Track,
} from "@/lib/types"
import { Icon, type IconName } from "./shared/Icon"
import {
  Artwork,
  BottomSheet,
  Button,
  ControlGroup,
  DeepTimeline,
  MetricStrip,
  Modal,
  PageTitle,
  SliderField,
  SpectrumChart,
  Transport,
  Waveform,
  formatTime,
  statusLabel,
} from "./shared/Primitives"

type WorkstationRoute =
  | "home"
  | "library"
  | "master"
  | "split"
  | "albums"
  | "album"
  | "reference"
  | "release-check"
  | "tools"

const stemNames: Record<number, string[]> = {
  2: ["Vocals", "Instrumental"],
  3: ["Vocals", "Drums", "Other"],
  4: ["Vocals", "Drums", "Bass", "Other"],
  5: ["Vocals", "Drums", "Bass", "Melody", "Other"],
  6: ["Vocals", "Drums", "Bass", "Guitar", "Piano", "Other"],
}

function resolveDynamicId(
  propId: string | undefined,
  pathname: string | null,
  fallbackId: string,
): string {
  if (pathname) {
    const parts = pathname.split("/").filter(Boolean)
    const candidate = parts[1]
    if (candidate && candidate !== "placeholder") {
      return decodeURIComponent(candidate)
    }
  }
  if (propId && propId !== "placeholder") {
    return propId
  }
  return fallbackId
}

export function AurialisWorkstation({
  route,
  paramId,
}: {
  route: WorkstationRoute
  paramId?: string
}) {
  const pathname = usePathname()
  const { state, dispatch } = useStore()
  const [prefsOpen, setPrefsOpen] = useState(false)
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const [livePath, setLivePath] = useState<string | null>(pathname)

  useEffect(() => {
    setLivePath(window.location.pathname)
  }, [pathname])

  const inWorkspace = route === "master"
  const defaultTrackId = state.tracks[0]?.id ?? "demo-1"
  const resolvedId = resolveDynamicId(paramId, livePath, defaultTrackId)

  const navItems: {
    href: string
    label: string
    icon: IconName
    active: boolean
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
  ]

  return (
    <div className="app-shell">
      <aside className="side-nav">
        <Link className="brand" href="/">
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
              aria-current={item.active ? "page" : undefined}
            >
              <Icon name={item.icon} /> <span>{item.label}</span>
            </Link>
          ))}
        </nav>
        <div className="nav-note">
          <span className="eyebrow">Local workspace</span>
          <p>Your audio stays in this browser.</p>
        </div>
        <button
          type="button"
          className="profile-button"
          aria-label="Open local preferences"
          onClick={() => {
            setPrefsOpen(true)
          }}
        >
          <span>AG</span>
          <span>
            <strong>Local profile</strong>
            <small>Preferences</small>
          </span>
          <Icon name="more-horizontal" />
        </button>
      </aside>

      <header className="mobile-header">
        <Link className="brand" href="/">
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
            setMobileMenuOpen(true)
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
        {route === "master" && <MasterView trackId={resolvedId} />}
        {route === "split" && <SplitView trackId={resolvedId} />}
        {route === "albums" && <AlbumsView />}
        {route === "album" && <AlbumView albumId={resolvedId} />}
        {route === "reference" && <ReferenceView trackId={resolvedId} />}
        {route === "release-check" && <ReleaseView trackId={resolvedId} />}
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
          setPrefsOpen(false)
        }}
        actions={
          <>
            <Button
              variant="secondary"
              icon={<Icon name="rotate-ccw" />}
              onClick={() => {
                dispatch({ type: "RESET_WORKSPACE" })
                setPrefsOpen(false)
              }}
            >
              Reset demo workspace
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                setPrefsOpen(false)
              }}
            >
              Done
            </Button>
          </>
        }
      >
        <p style={{ color: "var(--ink-soft)", margin: "0 0 12px" }}>
          Aurialis runs locally with an embedded WebAssembly 64-bit DSP engine
          and IndexedDB project storage.
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
          setMobileMenuOpen(false)
        }}
      >
        <div className="control-stack">
          {navItems.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`button ${
                item.active ? "button--primary" : "button--secondary"
              }`}
              onClick={() => {
                setMobileMenuOpen(false)
              }}
            >
              <Icon name={item.icon} />
              <span>{item.label}</span>
            </Link>
          ))}
        </div>
      </BottomSheet>
    </div>
  )
}

function HomeView() {
  const { state, dispatch } = useStore()
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const [message, setMessage] = useState("")
  const [loading, setLoading] = useState(false)

  const importFile = async (file?: File) => {
    if (!file) return
    if (
      !file.type.startsWith("audio/") &&
      !/\.(wav|mp3|aif|aiff|flac|m4a|ogg)$/i.test(file.name)
    ) {
      setMessage(
        "That file does not appear to be playable audio. Try WAV, MP3, AIFF, M4A, FLAC, or OGG.",
      )
      return
    }
    setLoading(true)
    setMessage("Reading the source and preparing a local project…")
    const id = `track-${Date.now()}`
    const title = file.name.replace(/\.[^.]+$/, "").replace(/[-_]/g, " ")
    let duration = 180
    try {
      const url = URL.createObjectURL(file)
      const audio = new Audio(url)
      duration = await new Promise<number>((resolve) => {
        audio.onloadedmetadata = () => {
          resolve(Number.isFinite(audio.duration) ? audio.duration : 180)
        }
        audio.onerror = () => {
          resolve(180)
        }
      })
      URL.revokeObjectURL(url)
      await saveAudio(id, file)
    } catch {
      setMessage(
        "Storage is unavailable; the project will remain in this session.",
      )
    }
    const seed =
      [...file.name].reduce((sum, char) => sum + char.charCodeAt(0), 0) % 97
    const baseDefault = state.tracks[0]?.advanced
    const nowIso = new Date().toISOString()
    const track: Track = {
      id,
      title,
      filename: file.name,
      duration,
      size: file.size,
      format: file.name.split(".").pop()?.toUpperCase() ?? "WAV",
      sampleRate: 48000,
      status: "ready",
      createdAt: nowIso,
      updatedAt: nowIso,
      seed,
      source: "upload",
      mode: "simple",
      genre: "Pop",
      tone: "Warm",
      intensity: 50,
      target: "Streaming",
      metrics: {
        lufs: -17.2 + (seed % 20) / 10,
        peak: -2.8,
        range: 8.4,
        dynamics: 9.7,
        correlation: 0.88,
      },
      advanced: baseDefault
        ? {
            ...baseDefault,
            input: 0,
            threshold: -18,
            ratio: 2.5,
            attack: 25,
            release: 220,
            width: 100,
            saturation: 8,
          }
        : (state.tracks[0] as Track).advanced,
      profile: "modern_pop_polish",
    }
    dispatch({ type: "ADD_TRACK", track })
    router.push(`/master/${id}`)
  }

  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const file = Array.from(event.clipboardData?.files ?? []).find((item) =>
        item.type.startsWith("audio/"),
      )
      if (file) void importFile(file)
    }
    document.addEventListener("paste", onPaste)
    return () => {
      document.removeEventListener("paste", onPaste)
    }
  })

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
              Private by default. Your audio never leaves this browser.
            </span>
          </div>
        </div>
        <div
          className={`drop-zone ${dragging ? "is-dragging" : ""}`.trim()}
          onDragOver={(event) => {
            event.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => {
            setDragging(false)
          }}
          onDrop={(event: DragEvent) => {
            event.preventDefault()
            setDragging(false)
            void importFile(event.dataTransfer.files[0])
          }}
          onClick={() => inputRef.current?.click()}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault()
              inputRef.current?.click()
            }
          }}
          role="button"
          tabIndex={0}
          aria-label="Bring in a track: drop audio or choose a file"
        >
          <input
            ref={inputRef}
            type="file"
            accept="audio/*,.wav,.aif,.aiff,.flac"
            hidden
            aria-label="Upload audio file"
            onChange={(e) => void importFile(e.target.files?.[0])}
          />
          <div className="drop-icon">
            <Icon name="upload" />
          </div>
          <h2>{loading ? "Listening closely…" : "Bring in a track"}</h2>
          <p>
            {message ||
              "Drop audio here, paste it, or choose a file from your device."}
          </p>
          <span className="file-types">
            WAV · AIFF · FLAC · MP3 · M4A · OGG
          </span>
          <Button variant="primary" icon={<Icon name="file-audio" />}>
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
            copy="Explore the balance with two to six phase-coherent stem groups."
          />
          <WorkflowCard
            number="03"
            icon="check"
            title="Release check"
            copy="Review loudness, peaks, dynamics, format, and metadata before delivery."
          />
        </div>
      </section>
    </div>
  )
}

function WorkflowCard({
  number,
  icon,
  title,
  copy,
}: {
  number: string
  icon: IconName
  title: string
  copy: string
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
  )
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
  )
}

function LibraryView() {
  const { state, dispatch } = useStore()
  const [query, setQuery] = useState("")
  const [filter, setFilter] = useState("All")
  const [pendingDelete, setPendingDelete] = useState<Track | null>(null)

  const tracks = state.tracks.filter(
    (track) =>
      track.title.toLowerCase().includes(query.toLowerCase()) &&
      (filter === "All" || statusLabel(track.status) === filter.toLowerCase()),
  )

  return (
    <div className="page">
      <PageTitle
        eyebrow="Your local archive"
        title="Library"
        copy={`${state.tracks.length} projects stored only in this browser.`}
        action={
          <Link className="button button--primary" href="/">
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
              setQuery(e.target.value)
            }}
            placeholder="Search your library"
          />
        </label>
        <div className="filter-row" role="group" aria-label="Filter projects by status">
          {["All", "Draft", "Ready", "Mastered", "Needs review"].map((item) => (
            <button
              type="button"
              className={filter === item ? "chip is-active" : "chip"}
              aria-pressed={filter === item}
              onClick={() => {
                setFilter(item)
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
              {track.metrics.lufs.toFixed(1)}
              <small>LUFS</small>
            </span>
            <span>
              Today<small>Local</small>
            </span>
            <button
              type="button"
              className="icon-button"
              aria-label={`Delete ${track.title}`}
              onClick={() => {
                setPendingDelete(track)
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
        <div className="storage-bar">
          <span
            style={{ width: `${Math.min(72, state.tracks.length * 8)}%` }}
          />
        </div>
      </div>

      <Modal
        open={pendingDelete !== null}
        eyebrow="Confirm removal"
        title={pendingDelete ? `Delete “${pendingDelete.title}”?` : "Delete track"}
        onClose={() => {
          setPendingDelete(null)
        }}
        actions={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setPendingDelete(null)
              }}
            >
              Cancel
            </Button>
            <Button
              variant="danger"
              icon={<Icon name="trash" />}
              onClick={() => {
                if (pendingDelete) {
                  const id = pendingDelete.id
                  dispatch({ type: "DELETE_TRACK", id })
                  void deleteAudio(id)
                  setPendingDelete(null)
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
  )
}

function MasterView({ trackId }: { trackId: string }) {
  const { state, dispatch } = useStore()
  const router = useRouter()
  const track =
    state.tracks.find((item) => item.id === trackId) ?? state.tracks[0]
  const [processing, setProcessing] = useState(false)
  const [processed, setProcessed] = useState(track?.status === "mastered")
  const [ab, setAb] = useState<"A" | "B">("B")
  const [playheadRatio, setPlayheadRatio] = useState(0.28)
  const [activeBandId, setActiveBandId] = useState<EQBandId>("low")
  const [exportOpen, setExportOpen] = useState(false)
  const [bitDepth, setBitDepth] = useState<ExportBitDepth>(24)
  const [exportRate, setExportRate] = useState<44100 | 48000>(48000)
  const [exportDither, setExportDither] = useState(true)
  const [exportDoneMessage, setExportDoneMessage] = useState("")

  if (!track) {
    return null
  }

  const update = (patch: Partial<Track>) => {
    dispatch({ type: "UPDATE_TRACK", id: track.id, patch })
  }

  const startMaster = () => {
    setProcessing(true)
    setTimeout(() => {
      setProcessing(false)
      setProcessed(true)
      const effective = computeEffectiveMetrics(track, true)
      update({
        status: "mastered",
        metrics: effective,
      })
    }, 300)
  }

  const handleDownloadWav = () => {
    const rendered = renderMasteredWav(
      track,
      bitDepth,
      exportRate,
      exportDither,
    )
    const wavCopy = new Uint8Array(rendered.wavBytes.byteLength)
    wavCopy.set(rendered.wavBytes)
    const blob = new Blob([wavCopy.buffer], { type: "audio/wav" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    const slug = track.title.toLowerCase().replace(/[^a-z0-9]+/g, "-")
    a.download = `${slug}-${bitDepth}bit-${exportRate / 1000}khz.wav`
    a.click()
    URL.revokeObjectURL(url)
    setExportDoneMessage(
      `Exported ${bitDepth}-bit / ${exportRate / 1000} kHz WAV (${rendered.afterMetrics.lufs.toFixed(1)} LUFS, ${rendered.afterMetrics.peak.toFixed(1)} dBTP)`,
    )
  }

  const previewMetrics = computeEffectiveMetrics(track, true)

  return (
    <div className="master-page">
      <header className="workspace-header">
        <button
          type="button"
          className="icon-button"
          onClick={() => {
            router.push("/library")
          }}
          aria-label="Back to library"
        >
          <Icon name="arrow-left" />
        </button>
        <Artwork seed={track.seed} />
        <div className="workspace-track">
          <h1>{track.title}</h1>
          <p>
            {formatTime(track.duration)} · {track.sampleRate / 1000} kHz ·{" "}
            {track.format}
          </p>
        </div>
        <div className="mode-tabs" role="tablist" aria-label="Mastering mode">
          {(["simple", "advanced", "deep"] as MasterMode[]).map((mode) => (
            <button
              type="button"
              role="tab"
              aria-selected={track.mode === mode}
              className={track.mode === mode ? "is-active" : ""}
              key={mode}
              onClick={() => {
                update({ mode })
              }}
            >
              {mode}
            </button>
          ))}
        </div>
        <div className="workspace-actions">
          <Button
            variant="secondary"
            icon={<Icon name="scissors" />}
            onClick={() => {
              router.push(`/split/${track.id}`)
            }}
          >
            Split
          </Button>
          <Button
            variant="primary"
            icon={<Icon name="arrow-down-to-line" />}
            onClick={() => {
              setExportDoneMessage("")
              setExportOpen(true)
            }}
          >
            Export
          </Button>
        </div>
      </header>

      <div className="workspace-layout">
        <section className="workspace-canvas">
          <MetricStrip
            track={track}
            processed={(processed || track.mode !== "simple") && ab === "B"}
          />
          <Waveform
            seed={track.seed}
            duration={track.duration}
            playheadRatio={playheadRatio}
            onSeekRatio={setPlayheadRatio}
          />
          <Transport
            track={track}
            ab={ab}
            setAb={setAb}
            playheadRatio={playheadRatio}
            onSeekRatio={setPlayheadRatio}
          />
          <SpectrumChart
            seed={track.seed}
            eqBands={track.advanced.eqBands}
            activeBandId={activeBandId}
            onSelectBand={setActiveBandId}
          />
          <div className="tool-links">
            <Link href={`/reference/${track.id}`}>
              <Icon name="refresh-cw" />
              <span>
                <strong>Reference match</strong>
                <small>Borrow direction, not identity</small>
              </span>
              <Icon name="arrow-right" />
            </Link>
            <Link href={`/release-check/${track.id}`}>
              <Icon name="check" />
              <span>
                <strong>Release check</strong>
                <small>Review delivery readiness</small>
              </span>
              <Icon name="arrow-right" />
            </Link>
          </div>
        </section>

        <aside className="inspector" aria-label="Mastering controls inspector">
          <span className="eyebrow">Master controls</span>
          {track.mode === "simple" && (
            <SimpleControls
              track={track}
              processing={processing}
              processed={processed}
              startMaster={startMaster}
            />
          )}
          {track.mode === "advanced" && (
            <AdvancedControls
              track={track}
              activeBandId={activeBandId}
              onSelectBand={setActiveBandId}
            />
          )}
          {track.mode === "deep" && <DeepControls track={track} />}
        </aside>
      </div>

      <Modal
        open={exportOpen}
        eyebrow="Master delivery"
        title={`Export “${track.title}”`}
        onClose={() => {
          setExportOpen(false)
        }}
        actions={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setExportOpen(false)
              }}
            >
              Close
            </Button>
            <Button
              variant="primary"
              icon={<Icon name="arrow-down-to-line" />}
              onClick={handleDownloadWav}
            >
              Render & download WAV
            </Button>
          </>
        }
      >
        <div className="control-stack">
          <ControlGroup label="Bit depth">
            <div className="choice-grid">
              {([16, 24, 32] as ExportBitDepth[]).map((depth) => (
                <button
                  type="button"
                  key={depth}
                  className={bitDepth === depth ? "choice is-active" : "choice"}
                  aria-pressed={bitDepth === depth}
                  onClick={() => {
                    setBitDepth(depth)
                  }}
                >
                  {depth === 32 ? "32-bit Float" : `${depth}-bit PCM`}
                </button>
              ))}
            </div>
          </ControlGroup>
          <ControlGroup label="Sample rate">
            <div className="choice-grid">
              {([44100, 48000] as const).map((sr) => (
                <button
                  type="button"
                  key={sr}
                  className={exportRate === sr ? "choice is-active" : "choice"}
                  aria-pressed={exportRate === sr}
                  onClick={() => {
                    setExportRate(sr)
                  }}
                >
                  {sr / 1000} kHz
                </button>
              ))}
            </div>
          </ControlGroup>
          <label className="check-row">
            <input
              type="checkbox"
              checked={exportDither && bitDepth !== 32}
              disabled={bitDepth === 32}
              onChange={(e) => {
                setExportDither(e.target.checked)
              }}
            />
            <span>
              <Icon name="check" />
            </span>
            Apply triangular TPDF dither ({bitDepth === 32 ? "N/A for Float" : "1 LSB"})
          </label>
          <div className="metric-mini">
            <span>
              <strong>{previewMetrics.lufs.toFixed(1)}</strong>
              <small>LUFS</small>
            </span>
            <span>
              <strong>{previewMetrics.peak.toFixed(1)}</strong>
              <small>dBTP</small>
            </span>
            <span>
              <strong>{previewMetrics.correlation.toFixed(2)}</strong>
              <small>Corr</small>
            </span>
          </div>
          {exportDoneMessage !== "" && (
            <p className="disclosure" role="status">
              {exportDoneMessage}
            </p>
          )}
        </div>
      </Modal>
    </div>
  )
}

function SimpleControls({
  track,
  processing,
  processed,
  startMaster,
}: {
  track: Track
  processing: boolean
  processed: boolean
  startMaster: () => void
}) {
  const { dispatch } = useStore()
  const updateSimple = (
    patch: Partial<Pick<Track, "genre" | "tone" | "intensity" | "target">>,
  ) => {
    dispatch({ type: "UPDATE_SIMPLE", id: track.id, patch })
  }

  return (
    <div className="control-stack">
      <div>
        <h2>Find the feeling</h2>
        <p>Choose a broad direction. You can refine every detail later.</p>
      </div>
      <ControlGroup label="Genre">
        <div className="choice-grid" role="group" aria-label="Genre">
          {["Pop", "Hip-hop", "Rock", "Electronic", "Acoustic", "R&B"].map(
            (item) => (
              <button
                type="button"
                className={track.genre === item ? "choice is-active" : "choice"}
                aria-pressed={track.genre === item}
                key={item}
                onClick={() => {
                  updateSimple({ genre: item })
                }}
              >
                {item}
              </button>
            ),
          )}
        </div>
      </ControlGroup>
      <ControlGroup label="Tone intention">
        <div className="tone-grid" role="group" aria-label="Tone intention">
          {["Warm", "Open", "Punchy", "Intimate", "Wide", "Clean"].map(
            (item) => (
              <button
                type="button"
                className={track.tone === item ? "choice is-active" : "choice"}
                aria-pressed={track.tone === item}
                key={item}
                onClick={() => {
                  updateSimple({ tone: item })
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
          updateSimple({ intensity })
        }}
      />
      <ControlGroup label="Output">
        <div className="select-wrap">
          <select
            aria-label="Output target"
            value={track.target}
            onChange={(e) => {
              updateSimple({ target: e.target.value })
            }}
          >
            <option>Streaming</option>
            <option>Loud</option>
            <option>Dynamic</option>
            <option>Podcast</option>
            <option>Custom</option>
          </select>
          <Icon name="chevron-down" />
        </div>
      </ControlGroup>
      <Button
        className="full-button"
        onClick={startMaster}
        disabled={processing}
        icon={
          processing ? (
            <Icon name="refresh-cw" className="spin" />
          ) : processed ? (
            <Icon name="check" />
          ) : (
            <Icon name="sparkles" />
          )
        }
      >
        {processing
          ? "Balancing the track…"
          : processed
            ? "Master direction created"
            : "Create master direction"}
      </Button>
      <p className="disclosure">
        64-bit WebAssembly DSP engine active. Export renders full-resolution PCM.
      </p>
    </div>
  )
}

function AdvancedControls({
  track,
  activeBandId,
  onSelectBand,
}: {
  track: Track
  activeBandId: EQBandId
  onSelectBand: (bandId: EQBandId) => void
}) {
  const { dispatch } = useStore()
  const adv = track.advanced
  const selectedBand =
    adv.eqBands.find((b) => b.id === activeBandId) ?? adv.eqBands[1]

  return (
    <div className="control-stack">
      <div>
        <h2>Shape the detail</h2>
        <p>Each module operates orthogonally with zero cross-coupling.</p>
      </div>

      <SliderField
        label="Input gain"
        value={adv.input}
        min={-6}
        max={6}
        step={0.5}
        unit="dB"
        onChange={(input) => {
          dispatch({ type: "UPDATE_INPUT_GAIN", trackId: track.id, input })
        }}
      />

      <div className="control-group">
        <div className="control-label">
          <span>5-Band Parametric EQ</span>
          <strong>{ selectedBand.label }</strong>
        </div>
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
                onSelectBand(band.id)
              }}
            >
              {band.label}
            </button>
          ))}
        </div>
      </div>

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
          })
        }}
      />
      <SliderField
        label={`${selectedBand.label} frequency`}
        value={selectedBand.freqHz}
        min={20}
        max={18000}
        step={10}
        unit="Hz"
        onChange={(freqHz) => {
          dispatch({
            type: "UPDATE_EQ_BAND",
            trackId: track.id,
            bandId: selectedBand.id,
            patch: { freqHz },
          })
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
          })
        }}
      />

      <SliderField
        label="Threshold"
        value={adv.compressor.threshold}
        min={-36}
        max={-6}
        step={1}
        unit="dB"
        onChange={(threshold) => {
          dispatch({
            type: "UPDATE_COMPRESSOR",
            trackId: track.id,
            patch: { threshold },
          })
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
          })
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
          })
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
          })
        }}
      />

      <SliderField
        label="Stereo width"
        value={adv.stereo.width}
        min={50}
        max={150}
        step={1}
        unit="%"
        onChange={(width) => {
          dispatch({
            type: "UPDATE_STEREO",
            trackId: track.id,
            patch: { width },
          })
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
            })
          }}
        />
        <span>
          <Icon name="check" />
        </span>
        Mono bass below 110 Hz
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
          })
        }}
      />
      <ControlGroup label="Saturation character">
        <div className="choice-grid" role="group" aria-label="Saturation character">
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
                })
              }}
            >
              {char}
            </button>
          ))}
        </div>
      </ControlGroup>

      <SliderField
        label="True-peak ceiling"
        value={adv.limiter.ceiling}
        min={-3.0}
        max={-0.1}
        step={0.1}
        unit="dBTP"
        onChange={(ceiling) => {
          dispatch({
            type: "UPDATE_LIMITER",
            trackId: track.id,
            patch: { ceiling },
          })
        }}
      />

      <Button
        variant="secondary"
        icon={<Icon name="rotate-ccw" />}
        onClick={() => {
          dispatch({ type: "RESET_ADVANCED", trackId: track.id })
        }}
      >
        Reset modules
      </Button>
    </div>
  )
}

function DeepControls({ track }: { track: Track }) {
  const { dispatch } = useStore()
  const [selected, setSelected] = useState(track.profile)
  const [phase, setPhase] = useState("")
  const [progress, setProgress] = useState(0)
  const [activeMove, setActiveMove] = useState<Move | null>(null)

  const run = () => {
    setProgress(35)
    setPhase("Detecting sections & writing MasteringScript v1")
    setTimeout(() => {
      dispatch({
        type: "UPDATE_TRACK",
        id: track.id,
        patch: { profile: selected },
      })
      dispatch({
        type: "SAVE_SCRIPT",
        id: track.id,
        script: generateScript(track, selected),
      })
      setProgress(100)
      setPhase("Script ready")
    }, 250)
  }

  const currentMove =
    activeMove && track.script
      ? (track.script.moves.find((m) => m.id === activeMove.id) ?? activeMove)
      : activeMove

  return (
    <div className="control-stack deep-controls">
      <div>
        <h2>Deep mastering</h2>
        <p>
          A deterministic, section-aware proposal using the version 1 script
          shape.
        </p>
      </div>
      <ControlGroup label="Engineer profile">
        <div className="profile-list" role="group" aria-label="Engineer profile">
          {profiles.map((profile) => (
            <button
              type="button"
              key={profile.id}
              aria-pressed={selected === profile.id}
              className={
                selected === profile.id
                  ? "profile-choice is-active"
                  : "profile-choice"
              }
              onClick={() => {
                setSelected(profile.id)
              }}
            >
              <strong>{profile.name}</strong>
              <span>{profile.note}</span>
            </button>
          ))}
        </div>
      </ControlGroup>
      {phase !== "" && (
        <div className="progress-card" role="status">
          <div>
            <span>{phase}</span>
            <strong>{progress}%</strong>
          </div>
          <div className="progress-track">
            <span style={{ width: `${progress}%` }} />
          </div>
        </div>
      )}
      <Button
        className="full-button"
        icon={<Icon name="sparkles" />}
        onClick={run}
      >
        Analyze deeply
      </Button>
      <p className="disclosure">
        Generates section-aware automation envelopes for Volume, EQ, Comp/Sat,
        Width, and AI Repair.
      </p>
      {track.script !== undefined && (
        <DeepTimeline script={track.script} onSelect={setActiveMove} />
      )}
      {currentMove !== null && (
        <MoveEditor
          trackId={track.id}
          move={currentMove}
          close={() => {
            setActiveMove(null)
          }}
        />
      )}
    </div>
  )
}

function MoveEditor({
  trackId,
  move,
  close,
}: {
  trackId: string
  move: Move
  close: () => void
}) {
  const { dispatch } = useStore()
  const [value, setValue] = useState(move.value)

  useEffect(() => {
    setValue(move.value)
  }, [move.id, move.value])

  const save = (patch: Partial<Move>) => {
    const nextVal = patch.value ?? value
    const nextMove: Move = {
      ...move,
      ...patch,
      points: [
        [move.start, nextVal],
        [move.end, nextVal],
      ],
    }
    dispatch({ type: "UPDATE_MOVE", trackId, move: nextMove })
  }

  return (
    <div className="move-editor">
      <div className="move-editor-head">
        <span className="eyebrow">Move editor</span>
        <button
          type="button"
          className="icon-button"
          onClick={close}
          aria-label="Close editor"
        >
          <Icon name="x" />
        </button>
      </div>
      <h3>{move.parameter.replaceAll("_", " ")}</h3>
      <p>{move.reason}</p>
      <SliderField
        label="Proposed value"
        value={value}
        min={-24}
        max={24}
        step={0.1}
        onChange={(next) => {
          setValue(next)
          save({ value: next, edited: next !== move.originalValue })
        }}
      />
      <div className="editor-actions">
        <Button
          variant="secondary"
          onClick={() => {
            save({ muted: !move.muted })
          }}
        >
          {move.muted ? "Unmute" : "Mute"}
        </Button>
        <Button
          variant="ghost"
          onClick={() => {
            setValue(move.originalValue)
            save({ value: move.originalValue, edited: false })
          }}
        >
          Reset
        </Button>
      </div>
    </div>
  )
}

function SplitView({ trackId }: { trackId: string }) {
  const { state, dispatch } = useStore()
  const router = useRouter()
  const track =
    state.tracks.find((item) => item.id === trackId) ?? state.tracks[0]
  const existing = state.stems.find((item) => item.trackId === track?.id)
  const [count, setCount] = useState(existing?.count ?? 4)
  const [working, setWorking] = useState(false)
  const [pendingCount, setPendingCount] = useState<number | null>(null)

  if (!track) return null

  const stems: Stem[] = existing?.stems ?? []
  const currentStemNames = stemNames[count] ?? stemNames[4] ?? []

  const split = () => {
    setWorking(true)
    setTimeout(() => {
      const names = stemNames[count] ?? stemNames[4] ?? []
      const generated: Stem[] = names.map((name, index) => ({
        id: `${track.id}-${index}`,
        name,
        level: 0,
        pan: 0,
        muted: false,
        solo: false,
      }))
      dispatch({
        type: "SAVE_STEMS",
        project: { trackId: track.id, count, complete: true, stems: generated },
      })
      setWorking(false)
    }, 250)
  }

  const updateStem = (id: string, patch: Partial<Omit<Stem, "id">>) => {
    dispatch({
      type: "UPDATE_STEM",
      trackId: track.id,
      stemId: id,
      patch,
    })
  }

  return (
    <div className="page">
      <PageTitle
        eyebrow="Smart stem splitter"
        title={`Open up “${track.title}”`}
        copy="Separate into an exact 2-to-6 phase-coherent stem layout."
        action={
          <Button
            variant="secondary"
            icon={<Icon name="arrow-left" />}
            onClick={() => {
              router.push(`/master/${track.id}`)
            }}
          >
            Back to master
          </Button>
        }
      />
      <section className="split-intro paper-panel">
        <div>
          <span className="eyebrow">Output layout</span>
          <h2>How many stems do you need?</h2>
          <p>
            Labels adapt to the selected count before separation begins.
          </p>
        </div>
        <div className="stem-count" role="group" aria-label="Stem count">
          {[2, 3, 4, 5, 6].map((number) => (
            <button
              type="button"
              className={count === number ? "is-active" : ""}
              aria-pressed={count === number}
              key={number}
              onClick={() => {
                if (stems.length > 0 && number !== count) {
                  setPendingCount(number)
                } else {
                  setCount(number)
                }
              }}
            >
              {number}
            </button>
          ))}
        </div>
        <div className="stem-preview">
          {currentStemNames.map((name) => (
            <span key={name}>{name}</span>
          ))}
        </div>
        <Button
          onClick={split}
          disabled={working}
          icon={
            working ? (
              <Icon name="refresh-cw" className="spin" />
            ) : (
              <Icon name="scissors" />
            )
          }
        >
          {working
            ? "Separating source…"
            : stems.length > 0
              ? "Run split again"
              : "Separate into stems"}
        </Button>
      </section>

      {stems.length > 0 && (
        <section className="stem-workspace">
          <div className="section-heading">
            <div>
              <span className="eyebrow">Separated stems</span>
              <h2>{count} stem mix</h2>
            </div>
            <Button
              icon={<Icon name="arrow-right" />}
              onClick={() => {
                router.push(`/master/${track.id}`)
              }}
            >
              Send to mastering
            </Button>
          </div>
          <div className="stem-lanes">
            {stems.map((stem, index) => (
              <article className="stem-card" key={stem.id}>
                <div className="stem-card-head">
                  <i className={`stem-color stem-color--${index}`} />
                  <input
                    value={stem.name}
                    aria-label={`Stem ${index + 1} name`}
                    onChange={(e) => {
                      updateStem(stem.id, { name: e.target.value })
                    }}
                  />
                </div>
                <Waveform
                  seed={track.seed + index * 11}
                  duration={track.duration}
                  compact
                />
                <SliderField
                  label="Level"
                  ariaLabel={`${stem.name} level`}
                  value={stem.level}
                  min={-24}
                  max={6}
                  step={1}
                  unit="dB"
                  onChange={(level) => {
                    updateStem(stem.id, { level })
                  }}
                />
                <ControlGroup
                  label="Pan"
                  value={
                    stem.pan === 0
                      ? "C"
                      : stem.pan < 0
                        ? `${-stem.pan} L`
                        : `${stem.pan} R`
                  }
                >
                  <input
                    type="range"
                    min={-100}
                    max={100}
                    value={stem.pan}
                    aria-label={`${stem.name} pan`}
                    onChange={(e) => {
                      updateStem(stem.id, { pan: Number(e.target.value) })
                    }}
                  />
                </ControlGroup>
                <div className="mute-solo">
                  <button
                    type="button"
                    className={stem.muted ? "is-active" : ""}
                    aria-pressed={stem.muted}
                    onClick={() => {
                      updateStem(stem.id, { muted: !stem.muted })
                    }}
                  >
                    Mute
                  </button>
                  <button
                    type="button"
                    className={stem.solo ? "is-active" : ""}
                    aria-pressed={stem.solo}
                    onClick={() => {
                      updateStem(stem.id, { solo: !stem.solo })
                    }}
                  >
                    Solo
                  </button>
                </div>
              </article>
            ))}
          </div>
        </section>
      )}

      <Modal
        open={pendingCount !== null}
        eyebrow="Change stem layout"
        title={`Switch to ${pendingCount ?? count} stems?`}
        onClose={() => {
          setPendingCount(null)
        }}
        actions={
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setPendingCount(null)
              }}
            >
              Keep current stems
            </Button>
            <Button
              variant="primary"
              onClick={() => {
                if (pendingCount !== null) {
                  setCount(pendingCount)
                  dispatch({
                    type: "SAVE_STEMS",
                    project: {
                      trackId: track.id,
                      count: pendingCount,
                      complete: false,
                      stems: [],
                    },
                  })
                  setPendingCount(null)
                }
              }}
            >
              Replace layout
            </Button>
          </>
        }
      >
        <p style={{ color: "var(--ink-soft)", margin: 0 }}>
          Replacing the stem count will clear the current stem mix for this
          project so you can separate again.
        </p>
      </Modal>
    </div>
  )
}

function AlbumsView() {
  const { state, dispatch } = useStore()
  const create = () => {
    const album: Album = {
      id: `album-${Date.now()}`,
      title: `Untitled sequence ${state.albums.length + 1}`,
      artist: "",
      target: "−14 LUFS",
      trackIds: [],
      mastered: false,
    }
    dispatch({ type: "ADD_ALBUM", album })
  }
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
              <div className={`album-art album-art--${index % 3}`}>
                <span>{String(index + 1).padStart(2, "0")}</span>
              </div>
              <span className="eyebrow">{album.trackIds.length} tracks</span>
              <h2>{album.title}</h2>
              <p>Target {album.target}</p>
              <div className="album-score">
                <span>Consistency</span>
                <strong>{album.trackIds.length > 0 ? 86 : "—"}</strong>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}

function AlbumView({ albumId }: { albumId: string }) {
  const { state, dispatch } = useStore()
  const album =
    state.albums.find((item) => item.id === albumId) ?? state.albums[0]

  if (!album) {
    return (
      <div className="page">
        <PageTitle
          eyebrow="Album workspace"
          title="No album selected"
          copy="Create an album first to sequence tracks."
          action={
            <Link className="button button--primary" href="/albums">
              Back to albums
            </Link>
          }
        />
      </div>
    )
  }

  const albumTracks = album.trackIds
    .map((id) => state.tracks.find((track) => track.id === id))
    .filter((t): t is Track => t !== undefined)

  return (
    <div className="page">
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
              })
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
              })
            }}
          />
          <div className="album-meta">
            <span>{albumTracks.length} tracks</span>
            <span>{album.target}</span>
            <span>{album.mastered ? "Sequence mastered" : "In progress"}</span>
          </div>
        </div>
        <Button
          icon={<Icon name="sparkles" />}
          onClick={() => {
            dispatch({
              type: "UPDATE_ALBUM",
              id: album.id,
              patch: { mastered: true },
            })
          }}
        >
          Master album
        </Button>
      </section>
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
                  <strong>{track.title}</strong>
                  <small>
                    {formatTime(track.duration)} ·{" "}
                    {track.metrics.lufs.toFixed(1)} LUFS
                  </small>
                </div>
                <button
                  type="button"
                  className="icon-button"
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
                    })
                  }}
                >
                  <Icon name="x" />
                </button>
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
                  onClick={() => {
                    dispatch({
                      type: "UPDATE_ALBUM",
                      id: album.id,
                      patch: { trackIds: [...album.trackIds, track.id] },
                    })
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
                      height: `${Math.max(15, Math.min(95, 55 + (track.metrics.lufs + 18) * 8))}%`,
                    }}
                  >
                    <i>{track.metrics.lufs.toFixed(1)}</i>
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
  )
}

function ReferenceView({ trackId }: { trackId: string }) {
  const { state, dispatch } = useStore()
  const router = useRouter()
  const track =
    state.tracks.find((item) => item.id === trackId) ?? state.tracks[0]
  const [referenceId, setReferenceId] = useState(
    state.tracks.find((item) => item.id !== track?.id)?.id ?? "",
  )
  const [amount, setAmount] = useState(62)

  if (!track) return null
  const reference = state.tracks.find((item) => item.id === referenceId)

  return (
    <div className="page">
      <PageTitle
        eyebrow="Reference direction"
        title="Compare without copying"
        copy="Use another track as a tonal compass while preserving your source identity."
        action={
          <Button
            variant="secondary"
            icon={<Icon name="arrow-left" />}
            onClick={() => {
              router.push(`/master/${track.id}`)
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
                    setReferenceId(e.target.value)
                  }}
                >
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
                  points={Array.from(
                    { length: 13 },
                    (_, i) =>
                      `${i * 8.33},${58 - ((reference.seed * (i + 3) * 5 + i * 9) % 32)}`,
                  ).join(" ")}
                  fill="none"
                  stroke="var(--moss)"
                  strokeWidth="1.4"
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
            Move toward the reference while protecting the source character.
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
          {[
            "Prioritize tone",
            "Protect low end",
            "Protect transients",
            "Include width",
          ].map((item, i) => (
            <label className="check-row" key={item}>
              <input type="checkbox" defaultChecked={i !== 3} />
              <span>
                <Icon name="check" />
              </span>
              {item}
            </label>
          ))}
          <Button
            className="full-button"
            icon={<Icon name="arrow-right" />}
            onClick={() => {
              dispatch({
                type: "UPDATE_SIMPLE",
                id: track.id,
                patch: { tone: "Reference-led", intensity: amount },
              })
              router.push(`/master/${track.id}`)
            }}
          >
            Apply reference direction
          </Button>
        </aside>
      </div>
    </div>
  )
}

function MetricMini({ track }: { track: Track }) {
  return (
    <div className="metric-mini">
      <span>
        <strong>{track.metrics.lufs.toFixed(1)}</strong>
        <small>LUFS</small>
      </span>
      <span>
        <strong>{track.metrics.dynamics.toFixed(1)}</strong>
        <small>DR</small>
      </span>
      <span>
        <strong>{track.advanced.stereo.width}%</strong>
        <small>Width</small>
      </span>
    </div>
  )
}

function ReleaseView({ trackId }: { trackId: string }) {
  const { state, dispatch } = useStore()
  const router = useRouter()
  const track =
    state.tracks.find((item) => item.id === trackId) ?? state.tracks[0]
  const [platform, setPlatform] = useState("Spotify")
  const [scanning, setScanning] = useState(false)
  const [score, setScore] = useState<number | undefined>(track?.releaseScore)

  if (!track) return null

  const run = () => {
    setScanning(true)
    setTimeout(() => {
      const next = 84 + (track.seed % 11)
      setScore(next)
      dispatch({
        type: "UPDATE_TRACK",
        id: track.id,
        patch: { releaseScore: next },
      })
      setScanning(false)
    }, 250)
  }

  const checks: [string, string, "pass" | "warn", string][] = [
    [
      "Integrated loudness",
      `${track.metrics.lufs.toFixed(1)} LUFS`,
      "pass",
      `Well placed for ${platform}.`,
    ],
    [
      "True peak",
      `${track.metrics.peak.toFixed(1)} dBTP`,
      track.metrics.peak > -1 ? "warn" : "pass",
      "Leave enough room for distribution encoding.",
    ],
    [
      "Dynamic range",
      `${track.metrics.dynamics.toFixed(1)} DR`,
      "pass",
      "The track retains useful contrast.",
    ],
    [
      "Mono compatibility",
      `${track.metrics.correlation.toFixed(2)} corr`,
      track.metrics.correlation < 0.75 ? "warn" : "pass",
      "Review wide elements in mono.",
    ],
    [
      "Source format",
      `${track.format} · ${track.sampleRate / 1000} kHz`,
      "pass",
      "Suitable source for delivery preparation.",
    ],
  ]

  return (
    <div className="page">
      <PageTitle
        eyebrow="Release check"
        title="Ready for the handoff?"
        copy="Technical review for streaming and physical distribution targets."
        action={
          <Button
            variant="secondary"
            icon={<Icon name="arrow-left" />}
            onClick={() => {
              router.push(`/master/${track.id}`)
            }}
          >
            Back to master
          </Button>
        }
      />
      <div className="release-top paper-panel">
        <div className="score-ring" aria-label="Release readiness score">
          <strong>{score ?? "—"}</strong>
          <span>readiness</span>
        </div>
        <div>
          <span className="eyebrow">Selected release</span>
          <h2>{track.title}</h2>
          <p>
            {score !== undefined
              ? score >= 90
                ? "This track is in strong shape for delivery."
                : "A few small decisions remain before delivery."
              : "Run the check to review loudness, peaks, dynamics, compatibility, and format."}
          </p>
          <div className="platforms" role="group" aria-label="Target platform">
            {[
              "Spotify",
              "Apple Music",
              "YouTube",
              "SoundCloud",
              "CD",
              "Podcast",
            ].map((item) => (
              <button
                type="button"
                className={platform === item ? "chip is-active" : "chip"}
                aria-pressed={platform === item}
                onClick={() => {
                  setPlatform(item)
                }}
                key={item}
              >
                {item}
              </button>
            ))}
          </div>
        </div>
        <Button
          icon={
            scanning ? (
              <Icon name="refresh-cw" className="spin" />
            ) : (
              <Icon name="gauge" />
            )
          }
          onClick={run}
          disabled={scanning}
        >
          {scanning ? "Reviewing release…" : "Run release check"}
        </Button>
      </div>
      {score !== undefined && (
        <section className="check-list">
          <div className="check-list-head">
            <span>Check</span>
            <span>Reading</span>
            <span>Guidance</span>
          </div>
          {checks.map(([name, value, status, note]) => (
            <div className="check-item" key={name}>
              <span className={`check-icon check-icon--${status}`}>
                <Icon name={status === "pass" ? "check" : "circle-alert"} />
              </span>
              <strong>{name} ({status === "pass" ? "Pass" : "Review"})</strong>
              <span>{value}</span>
              <p>{note}</p>
            </div>
          ))}
          <div className="report-actions">
            <Button
              variant="secondary"
              icon={<Icon name="arrow-down-to-line" />}
              onClick={() => {
                const blob = new Blob(
                  [
                    JSON.stringify(
                      { track: track.title, platform, score, checks },
                      null,
                      2,
                    ),
                  ],
                  { type: "application/json" },
                )
                const a = document.createElement("a")
                a.href = URL.createObjectURL(blob)
                a.download = `${track.title}-release-report.json`
                a.click()
                URL.revokeObjectURL(a.href)
              }}
            >
              Download JSON report
            </Button>
          </div>
        </section>
      )}
    </div>
  )
}

function ToolsView() {
  const { state } = useStore()
  const first = state.tracks[0]
  const targetId = first?.id ?? "demo-1"
  return (
    <div className="page">
      <PageTitle
        eyebrow="Focused utilities"
        title="Tools"
        copy="Different ways to listen to the same source more closely."
      />
      <div className="tools-grid">
        <ToolCard
          icon="scissors"
          eyebrow="Separation"
          title="Smart stem splitter"
          copy="Open a mix into an exact two-to-six-stem layout."
          href={`/split/${targetId}`}
        />
        <ToolCard
          icon="refresh-cw"
          eyebrow="Direction"
          title="Reference match"
          copy="Compare tone, dynamics, and width to another local track."
          href={`/reference/${targetId}`}
        />
        <ToolCard
          icon="check"
          eyebrow="Delivery"
          title="Release check"
          copy="Review common technical concerns before the handoff."
          href={`/release-check/${targetId}`}
        />
      </div>
    </div>
  )
}

function ToolCard({
  icon,
  eyebrow,
  title,
  copy,
  href,
}: {
  icon: IconName
  eyebrow: string
  title: string
  copy: string
  href: string
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
  )
}
