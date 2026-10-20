import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type ReactNode,
} from "react"
import {
  Album,
  ArrowDownToLine,
  ArrowLeft,
  ArrowRight,
  AudioLines,
  Check,
  ChevronDown,
  CircleAlert,
  Clock3,
  Disc3,
  FileAudio,
  Gauge,
  Headphones,
  Library,
  Menu,
  MoreHorizontal,
  Pause,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Scissors,
  Search,
  Settings2,
  SlidersHorizontal,
  Sparkles,
  Trash2,
  Upload,
  WandSparkles,
  X,
} from "lucide-react"
import {
  BrowserRouter,
  Link,
  NavLink,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
} from "react-router-dom"
import { deleteAudio, getAudio, saveAudio } from "./db"
import { generateScript, profiles, StoreProvider, useStore } from "./store"
import type { Album as AlbumType, MasterMode, Move, Stem, Track } from "./types"

const stemNames: Record<number, string[]> = {
  2: ["Vocals", "Instrumental"],
  3: ["Vocals", "Drums", "Other"],
  4: ["Vocals", "Drums", "Bass", "Other"],
  5: ["Vocals", "Drums", "Bass", "Melody", "Other"],
  6: ["Vocals", "Drums", "Bass", "Guitar", "Piano", "Other"],
}

const formatTime = (seconds: number) =>
  `${Math.floor(seconds / 60)}:${Math.floor(seconds % 60)
    .toString()
    .padStart(2, "0")}`
const formatSize = (bytes: number) => `${(bytes / 1_000_000).toFixed(1)} MB`
const statusLabel = (status: Track["status"]) => status.replace("-", " ")

function Button({
  children,
  variant = "primary",
  icon,
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger"
  icon?: ReactNode
}) {
  return (
    <button className={`button button--${variant} ${className}`} {...props}>
      {icon}
      {children}
    </button>
  )
}

function AppShell() {
  const location = useLocation()
  const inWorkspace = location.pathname.startsWith("/master/")
  return (
    <div className="app-shell">
      <aside className="side-nav">
        <Link className="brand" to="/">
          <span className="brand-mark">
            <span />
          </span>
          <span>Aurialis</span>
        </Link>
        <nav className="primary-nav" aria-label="Primary navigation">
          <NavLink to="/" end>
            <Disc3 /> <span>Home</span>
          </NavLink>
          <NavLink to="/library">
            <Library /> <span>Library</span>
          </NavLink>
          <NavLink to="/albums">
            <Album /> <span>Albums</span>
          </NavLink>
          <NavLink to="/tools">
            <WandSparkles /> <span>Tools</span>
          </NavLink>
        </nav>
        <div className="nav-note">
          <span className="eyebrow">Local workspace</span>
          <p>Your audio stays in this browser.</p>
        </div>
        <button className="profile-button" aria-label="Open local preferences">
          <span>AG</span>
          <span>
            <strong>Local profile</strong>
            <small>Preferences</small>
          </span>
          <MoreHorizontal />
        </button>
      </aside>
      <header className="mobile-header">
        <Link className="brand" to="/">
          <span className="brand-mark">
            <span />
          </span>
          <span>Aurialis</span>
        </Link>
        <button className="icon-button" aria-label="Open menu">
          <Menu />
        </button>
      </header>
      <main
        className={
          inWorkspace ? "main-content main-content--workspace" : "main-content"
        }
      >
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route path="/library" element={<LibraryPage />} />
          <Route path="/master/:trackId" element={<MasterPage />} />
          <Route path="/split/:trackId" element={<SplitPage />} />
          <Route path="/albums" element={<AlbumsPage />} />
          <Route path="/albums/:albumId" element={<AlbumPage />} />
          <Route path="/reference/:trackId" element={<ReferencePage />} />
          <Route path="/release-check/:trackId" element={<ReleasePage />} />
          <Route path="/tools" element={<ToolsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
      <nav className="bottom-nav" aria-label="Mobile navigation">
        <NavLink to="/" end>
          <Disc3 />
          <span>Home</span>
        </NavLink>
        <NavLink to="/library">
          <Library />
          <span>Library</span>
        </NavLink>
        <NavLink to="/albums">
          <Album />
          <span>Albums</span>
        </NavLink>
        <NavLink to="/tools">
          <WandSparkles />
          <span>Tools</span>
        </NavLink>
      </nav>
    </div>
  )
}

function HomePage() {
  const { state, dispatch } = useStore()
  const navigate = useNavigate()
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const [message, setMessage] = useState("")
  const [loading, setLoading] = useState(false)

  async function importFile(file?: File) {
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
        audio.onloadedmetadata = () =>
          resolve(Number.isFinite(audio.duration) ? audio.duration : 180)
        audio.onerror = () => resolve(180)
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
    const track: Track = {
      id,
      title,
      filename: file.name,
      duration,
      size: file.size,
      format: file.name.split(".").pop()?.toUpperCase() || "AUDIO",
      sampleRate: 48000,
      status: "ready",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
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
      advanced: {
        input: 0,
        threshold: -18,
        ratio: 2.5,
        attack: 25,
        release: 220,
        width: 100,
        saturation: 8,
      },
      profile: "modern_pop_polish",
    }
    dispatch({ type: "ADD_TRACK", track })
    setTimeout(() => navigate(`/master/${id}`), 500)
  }

  useEffect(() => {
    const onPaste = (event: ClipboardEvent) => {
      const file = Array.from(event.clipboardData?.files || []).find((item) =>
        item.type.startsWith("audio/"),
      )
      if (file) void importFile(file)
    }
    document.addEventListener("paste", onPaste)
    return () => document.removeEventListener("paste", onPaste)
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
            <Headphones />
            <span>
              Private by default. Your audio never leaves this browser.
            </span>
          </div>
        </div>
        <div
          className={`drop-zone ${dragging ? "is-dragging" : ""}`}
          onDragOver={(event) => {
            event.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event: DragEvent) => {
            event.preventDefault()
            setDragging(false)
            void importFile(event.dataTransfer.files[0])
          }}
          onClick={() => inputRef.current?.click()}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ")
              inputRef.current?.click()
          }}
          role="button"
          tabIndex={0}
        >
          <input
            ref={inputRef}
            type="file"
            accept="audio/*,.wav,.aif,.aiff,.flac"
            hidden
            onChange={(e) => void importFile(e.target.files?.[0])}
          />
          <div className="drop-icon">
            <Upload />
          </div>
          <h2>{loading ? "Listening closely…" : "Bring in a track"}</h2>
          <p>
            {message ||
              "Drop audio here, paste it, or choose a file from your device."}
          </p>
          <span className="file-types">
            WAV · AIFF · FLAC · MP3 · M4A · OGG
          </span>
          <Button type="button" variant="primary" icon={<FileAudio />}>
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
          <Link to="/library">
            View library <ArrowRight />
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
            icon={<AudioLines />}
            title="Master"
            copy="Set a direction, refine the detail, and keep the dynamics that make it yours."
          />
          <WorkflowCard
            number="02"
            icon={<Scissors />}
            title="Split"
            copy="Explore the balance with two to six simulated stem groups."
          />
          <WorkflowCard
            number="03"
            icon={<Check />}
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
  icon: ReactNode
  title: string
  copy: string
}) {
  return (
    <article className="workflow-card">
      <span>{number}</span>
      <div className="workflow-icon">{icon}</div>
      <h3>{title}</h3>
      <p>{copy}</p>
    </article>
  )
}

function Artwork({ seed, index = 0 }: { seed: number index?: number }) {
  return (
    <div
      className={`artwork artwork--${(seed + index) % 4}`}
      aria-hidden="true"
    >
      <span />
      <span />
      <span />
    </div>
  )
}

function TrackCard({ track, index = 0 }: { track: Track index?: number }) {
  return (
    <Link className="track-card" to={`/master/${track.id}`}>
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
        <ArrowRight />
      </span>
    </Link>
  )
}

function PageTitle({
  eyebrow,
  title,
  copy,
  action,
}: {
  eyebrow: string
  title: string
  copy?: string
  action?: ReactNode
}) {
  return (
    <header className="page-title">
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        {copy && <p>{copy}</p>}
      </div>
      {action}
    </header>
  )
}

function LibraryPage() {
  const { state, dispatch } = useStore()
  const [query, setQuery] = useState("")
  const [filter, setFilter] = useState("All")
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
          <Link className="button button--primary" to="/">
            <Plus />
            New project
          </Link>
        }
      />
      <div className="library-tools">
        <label className="search-field">
          <Search />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search your library"
          />
        </label>
        <div className="filter-row">
          {["All", "Draft", "Mastered", "Needs review"].map((item) => (
            <button
              className={filter === item ? "chip is-active" : "chip"}
              onClick={() => setFilter(item)}
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
            <Link className="library-project" to={`/master/${track.id}`}>
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
              className="icon-button"
              aria-label={`Delete ${track.title}`}
              onClick={async () => {
                if (
                  confirm(
                    `Delete “${track.title}” and its locally stored audio?`,
                  )
                ) {
                  dispatch({ type: "DELETE_TRACK", id: track.id })
                  await deleteAudio(track.id)
                }
              }}
            >
              <Trash2 />
            </button>
          </div>
        ))}
      </div>
      <div className="storage-note">
        <div>
          <Disc3 />
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
    </div>
  )
}

function MasterPage() {
  const { trackId } = useParams()
  const { state, dispatch } = useStore()
  const navigate = useNavigate()
  const track = state.tracks.find((item) => item.id === trackId)
  const [processing, setProcessing] = useState(false)
  const [processed, setProcessed] = useState(track?.status === "mastered")
  const [ab, setAb] = useState<"A" | "B">("B")
  if (!track) return <Navigate to="/library" replace />

  const update = (patch: Partial<Track>) =>
    dispatch({ type: "UPDATE_TRACK", id: track.id, patch })
  const startMaster = () => {
    setProcessing(true)
    setTimeout(() => {
      setProcessing(false)
      setProcessed(true)
      update({
        status: "mastered",
        metrics: {
          ...track.metrics,
          lufs: -14 + (track.intensity - 50) * 0.035,
          peak: -1,
          dynamics: Math.max(
            5.5,
            track.metrics.dynamics - track.intensity * 0.025,
          ),
        },
      })
    }, 1700)
  }
  return (
    <div className="master-page">
      <header className="workspace-header">
        <button
          className="icon-button"
          onClick={() => navigate("/library")}
          aria-label="Back to library"
        >
          <ArrowLeft />
        </button>
        <Artwork seed={track.seed} />
        <div className="workspace-track">
          <h1>{track.title}</h1>
          <p>
            {formatTime(track.duration)} · {track.sampleRate / 1000} kHz ·{" "}
            {track.format}
          </p>
        </div>
        <div className="mode-tabs" role="tablist">
          {(["simple", "advanced", "deep"] as MasterMode[]).map((mode) => (
            <button
              role="tab"
              aria-selected={track.mode === mode}
              className={track.mode === mode ? "is-active" : ""}
              key={mode}
              onClick={() => update({ mode })}
            >
              {mode}
            </button>
          ))}
        </div>
        <div className="workspace-actions">
          <Button
            variant="secondary"
            icon={<Scissors />}
            onClick={() => navigate(`/split/${track.id}`)}
          >
            Split
          </Button>
          <Button
            variant="primary"
            icon={<ArrowDownToLine />}
            onClick={() =>
              alert(
                "Prototype export: the original source would be downloaded unchanged. No DSP or transcoding is performed.",
              )
            }
          >
            Export
          </Button>
        </div>
      </header>
      <div className="workspace-layout">
        <section className="workspace-canvas">
          <MetricStrip track={track} processed={processed && ab === "B"} />
          <Waveform seed={track.seed} duration={track.duration} />
          <Transport track={track} ab={ab} setAb={setAb} />
          <Spectrum seed={track.seed} />
          <div className="tool-links">
            <Link to={`/reference/${track.id}`}>
              <RefreshCw />
              <span>
                <strong>Reference match</strong>
                <small>Borrow direction, not identity</small>
              </span>
              <ArrowRight />
            </Link>
            <Link to={`/release-check/${track.id}`}>
              <Check />
              <span>
                <strong>Release check</strong>
                <small>Review delivery readiness</small>
              </span>
              <ArrowRight />
            </Link>
          </div>
        </section>
        <aside className="inspector">
          <span className="eyebrow">Master controls</span>
          {track.mode === "simple" && (
            <SimpleControls
              track={track}
              update={update}
              processing={processing}
              processed={processed}
              startMaster={startMaster}
            />
          )}
          {track.mode === "advanced" && (
            <AdvancedControls track={track} update={update} />
          )}
          {track.mode === "deep" && <DeepControls track={track} />}
        </aside>
      </div>
    </div>
  )
}

function MetricStrip({
  track,
  processed,
}: {
  track: Track
  processed: boolean
}) {
  const m = track.metrics
  const metrics = [
    ["Integrated", processed ? m.lufs : m.lufs - 1.6, "LUFS"],
    ["True peak", processed ? m.peak : m.peak - 0.7, "dBTP"],
    ["Loudness range", m.range, "LU"],
    ["Dynamics", m.dynamics, "DR"],
    ["Stereo", m.correlation, "corr"],
  ]
  return (
    <div className="metric-strip">
      {metrics.map(([label, value, unit]) => (
        <div key={label}>
          <span>{label}</span>
          <strong>{Number(value).toFixed(label === "Stereo" ? 2 : 1)}</strong>
          <small>{unit}</small>
        </div>
      ))}
    </div>
  )
}

function bars(seed: number, count = 84) {
  return Array.from(
    { length: count },
    (_, index) => 14 + ((seed * (index + 3) * 17 + index * index * 3) % 72),
  )
}

function Waveform({
  seed,
  duration,
  compact = false,
}: {
  seed: number
  duration: number
  compact?: boolean
}) {
  return (
    <div className={`waveform ${compact ? "waveform--compact" : ""}`}>
      {!compact && (
        <div className="chart-label">
          <span>Source waveform</span>
          <span>{formatTime(duration)}</span>
        </div>
      )}
      <div className="wave-bars">
        {bars(seed, compact ? 52 : 96).map((height, i) => (
          <i key={i} style={{ height: `${height}%` }} />
        ))}
        <span className="playhead" />
      </div>
    </div>
  )
}

function Transport({
  track,
  ab,
  setAb,
}: {
  track: Track
  ab: "A" | "B"
  setAb: (value: "A" | "B") => void
}) {
  const audioRef = useRef<HTMLAudioElement>(null)
  const [src, setSrc] = useState("")
  const [playing, setPlaying] = useState(false)
  const [time, setTime] = useState(0)
  useEffect(() => {
    let url = ""
    if (track.source === "upload")
      getAudio(track.id).then((blob) => {
        if (blob) {
          url = URL.createObjectURL(blob)
          setSrc(url)
        }
      })
    return () => {
      if (url) URL.revokeObjectURL(url)
    }
  }, [track.id, track.source])
  const toggle = async () => {
    if (!src) {
      setPlaying((v) => !v)
      return
    }
    if (audioRef.current?.paused) await audioRef.current.play()
    else audioRef.current?.pause()
  }
  return (
    <div className="transport">
      <audio
        ref={audioRef}
        src={src}
        onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
      />
      <div className="ab-toggle">
        <button
          className={ab === "A" ? "is-active" : ""}
          onClick={() => setAb("A")}
        >
          A <span>Original</span>
        </button>
        <button
          className={ab === "B" ? "is-active" : ""}
          onClick={() => setAb("B")}
        >
          B <span>Direction</span>
        </button>
      </div>
      <button
        className="play-button"
        onClick={() => void toggle()}
        aria-label={playing ? "Pause" : "Play"}
      >
        {playing ? <Pause /> : <Play />}
      </button>
      <span className="transport-time">
        {formatTime(time)} <i>/</i> {formatTime(track.duration)}
      </span>
      {!src && <span className="demo-audio-note">Visual demo</span>}
    </div>
  )
}

function Spectrum({ seed }: { seed: number }) {
  const points = Array.from(
    { length: 13 },
    (_, i) => `${i * 8.33},${55 - ((seed * (i + 2) * 7 + i * 11) % 34)}`,
  ).join(" ")
  return (
    <div className="spectrum">
      <div className="chart-label">
        <span>Tonal balance</span>
        <span>20 Hz — 20 kHz</span>
      </div>
      <svg
        viewBox="0 0 100 60"
        preserveAspectRatio="none"
        aria-label="Simulated tonal balance curve"
      >
        <defs>
          <linearGradient id="fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="var(--clay)" stopOpacity=".22" />
            <stop offset="1" stopColor="var(--clay)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <polygon points={`0,60 ${points} 100,60`} fill="url(#fill)" />
        <polyline
          points={points}
          fill="none"
          stroke="var(--clay)"
          strokeWidth="1.4"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <div className="axis">
        <span>Sub</span>
        <span>Low</span>
        <span>Mid</span>
        <span>Presence</span>
        <span>Air</span>
      </div>
    </div>
  )
}

function SimpleControls({
  track,
  update,
  processing,
  processed,
  startMaster,
}: {
  track: Track
  update: (patch: Partial<Track>) => void
  processing: boolean
  processed: boolean
  startMaster: () => void
}) {
  return (
    <div className="control-stack">
      <div>
        <h2>Find the feeling</h2>
        <p>Choose a broad direction. You can refine every detail later.</p>
      </div>
      <ControlGroup label="Genre">
        <div className="choice-grid">
          {["Pop", "Hip-hop", "Rock", "Electronic", "Acoustic", "R&B"].map(
            (item) => (
              <button
                className={track.genre === item ? "choice is-active" : "choice"}
                key={item}
                onClick={() => update({ genre: item })}
              >
                {item}
              </button>
            ),
          )}
        </div>
      </ControlGroup>
      <ControlGroup label="Tone intention">
        <div className="tone-grid">
          {["Warm", "Open", "Punchy", "Intimate", "Wide", "Clean"].map(
            (item) => (
              <button
                className={track.tone === item ? "choice is-active" : "choice"}
                key={item}
                onClick={() => update({ tone: item })}
              >
                {item}
              </button>
            ),
          )}
        </div>
      </ControlGroup>
      <ControlGroup label="Intensity" value={`${track.intensity}%`}>
        <input
          type="range"
          min="0"
          max="100"
          value={track.intensity}
          onChange={(e) => update({ intensity: Number(e.target.value) })}
        />
        <div className="range-notes">
          <span>Gentle</span>
          <span>Forward</span>
        </div>
      </ControlGroup>
      <ControlGroup label="Output">
        <div className="select-wrap">
          <select
            value={track.target}
            onChange={(e) => update({ target: e.target.value })}
          >
            <option>Streaming</option>
            <option>Loud</option>
            <option>Dynamic</option>
            <option>Podcast</option>
            <option>Custom</option>
          </select>
          <ChevronDown />
        </div>
      </ControlGroup>
      <Button
        className="full-button"
        onClick={startMaster}
        disabled={processing}
        icon={
          processing ? (
            <RefreshCw className="spin" />
          ) : processed ? (
            <Check />
          ) : (
            <Sparkles />
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
        Simulated processing changes the analysis and controls, not the source
        audio.
      </p>
    </div>
  )
}

function ControlGroup({
  label,
  value,
  children,
}: {
  label: string
  value?: string
  children: ReactNode
}) {
  return (
    <div className="control-group">
      <div className="control-label">
        <span>{label}</span>
        {value && <strong>{value}</strong>}
      </div>
      {children}
    </div>
  )
}

function AdvancedControls({
  track,
  update,
}: {
  track: Track
  update: (patch: Partial<Track>) => void
}) {
  const set = (key: keyof Track["advanced"], value: number) =>
    update({ advanced: { ...track.advanced, [key]: value } })
  return (
    <div className="control-stack">
      <div>
        <h2>Shape the detail</h2>
        <p>Fine controls stay linked to the simulated analysis.</p>
      </div>
      {[
        ["Input gain", "input", -6, 6, "dB"],
        ["Threshold", "threshold", -36, -6, "dB"],
        ["Ratio", "ratio", 1, 8, ":1"],
        ["Attack", "attack", 1, 100, "ms"],
        ["Release", "release", 40, 500, "ms"],
        ["Stereo width", "width", 50, 150, "%"],
        ["Saturation", "saturation", 0, 40, "%"],
      ].map(([label, key, min, max, unit]) => (
        <ControlGroup
          key={String(key)}
          label={String(label)}
          value={`${track.advanced[(key as keyof Track["advanced"])]} ${unit}`}
        >
          <input
            type="range"
            min={Number(min)}
            max={Number(max)}
            step={key === "ratio" ? 0.5 : 1}
            value={track.advanced[(key as keyof Track["advanced"])]}
            onChange={(e) =>
              set(key as keyof Track["advanced"], Number(e.target.value))
            }
          />
        </ControlGroup>
      ))}
      <Button
        variant="secondary"
        icon={<RotateCcw />}
        onClick={() =>
          update({
            advanced: {
              input: 0,
              threshold: -18,
              ratio: 2.5,
              attack: 25,
              release: 220,
              width: 100,
              saturation: 8,
            },
          })
        }
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
    const phases = [
      "Detecting sections",
      "Analyzing stems and artifacts",
      "Writing the mastering script",
    ]
    setProgress(8)
    setPhase(phases[0])
    phases.forEach((item, index) =>
      setTimeout(
        () => {
          setPhase(item)
          setProgress((index + 1) * 33)
        },
        550 * (index + 1),
      ),
    )
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
    }, 2100)
  }
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
        <div className="profile-list">
          {profiles.map((profile) => (
            <button
              key={profile.id}
              className={
                selected === profile.id
                  ? "profile-choice is-active"
                  : "profile-choice"
              }
              onClick={() => setSelected(profile.id)}
            >
              <strong>{profile.name}</strong>
              <span>{profile.note}</span>
            </button>
          ))}
        </div>
      </ControlGroup>
      {phase && (
        <div className="progress-card">
          <div>
            <span>{phase}</span>
            <strong>{progress}%</strong>
          </div>
          <div className="progress-track">
            <span style={{ width: `${progress}%` }} />
          </div>
        </div>
      )}
      <Button className="full-button" icon={<Sparkles />} onClick={run}>
        Analyze deeply
      </Button>
      <p className="disclosure">
        This is a simulated proposal—not AI analysis or audio processing.
      </p>
      {track.script && (
        <DeepTimeline script={track.script} onSelect={setActiveMove} />
      )}
      {activeMove && (
        <MoveEditor
          trackId={track.id}
          move={activeMove}
          close={() => setActiveMove(null)}
        />
      )}
    </div>
  )
}

function DeepTimeline({
  script,
  onSelect,
}: {
  script: NonNullable<Track["script"]>
  onSelect: (move: Move) => void
}) {
  const lanes: Move["lane"][] = [
    "Volume",
    "EQ",
    "Comp/Sat",
    "Width",
    "AI Repair",
  ]
  return (
    <div className="deep-summary">
      <div className="deep-summary-head">
        <span>Script v{script.version}</span>
        <span>
          {script.sections.length} sections · {script.moves.length} moves
        </span>
      </div>
      <div className="section-strip">
        {script.sections.map((section) => (
          <span key={section.id} style={{ flex: section.end - section.start }}>
            {section.type}
          </span>
        ))}
      </div>
      {lanes.map((lane) => (
        <div className="lane" key={lane}>
          <strong>{lane}</strong>
          <div>
            {script.moves
              .filter((move) => move.lane === lane)
              .map((move) => (
                <button
                  key={move.id}
                  className={`${move.edited ? "is-edited" : ""} ${
                    move.muted ? "is-muted" : ""
                  }`}
                  style={{
                    left: `${(move.start / script.duration) * 100}%`,
                    width: `${((move.end - move.start) / script.duration) * 100}%`,
                  }}
                  onClick={() => onSelect(move)}
                  aria-label={`Edit ${move.parameter}`}
                />
              ))}
          </div>
        </div>
      ))}
      {script.findings.length > 0 && (
        <div className="finding">
          <CircleAlert />
          <span>
            <strong>Simulated artifact indicator</strong>
            <small>
              {script.findings[0].stem}:{" "}
              {Math.round(script.findings[0].confidence * 100)}% confidence.
              This is not proof of AI generation.
            </small>
          </span>
        </div>
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
  const save = (patch: Partial<Move>) =>
    dispatch({ type: "UPDATE_MOVE", trackId, move: { ...move, ...patch } })
  return (
    <div className="move-editor">
      <div className="move-editor-head">
        <span className="eyebrow">Move editor</span>
        <button
          className="icon-button"
          onClick={close}
          aria-label="Close editor"
        >
          <X />
        </button>
      </div>
      <h3>{move.parameter.replaceAll("_", " ")}</h3>
      <p>{move.reason}</p>
      <ControlGroup label="Proposed value" value={value.toFixed(1)}>
        <input
          type="range"
          min="-24"
          max="24"
          step=".1"
          value={value}
          onChange={(e) => setValue(Number(e.target.value))}
          onPointerUp={() =>
            save({ value, edited: value !== move.originalValue })
          }
        />
      </ControlGroup>
      <div className="editor-actions">
        <Button
          variant="secondary"
          onClick={() => save({ muted: !move.muted })}
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

function SplitPage() {
  const { trackId } = useParams()
  const { state, dispatch } = useStore()
  const navigate = useNavigate()
  const track = state.tracks.find((item) => item.id === trackId)
  const existing = state.stems.find((item) => item.trackId === trackId)
  const [count, setCount] = useState(existing?.count || 4)
  const [working, setWorking] = useState(false)
  const [stems, setStems] = useState<Stem[]>(existing?.stems || [])
  if (!track) return <Navigate to="/library" replace />
  const split = () => {
    setWorking(true)
    setTimeout(() => {
      const generated = stemNames[count].map((name, index) => ({
        id: `${track.id}-${index}`,
        name,
        level: 0,
        pan: 0,
        muted: false,
        solo: false,
      }))
      setStems(generated)
      dispatch({
        type: "SAVE_STEMS",
        project: { trackId: track.id, count, complete: true, stems: generated },
      })
      setWorking(false)
    }, 1400)
  }
  const updateStem = (id: string, patch: Partial<Stem>) => {
    const next = stems.map((stem) =>
      stem.id === id ? { ...stem, ...patch } : stem,
    )
    setStems(next)
    dispatch({
      type: "SAVE_STEMS",
      project: { trackId: track.id, count, complete: true, stems: next },
    })
  }
  return (
    <div className="page">
      <PageTitle
        eyebrow="Smart stem splitter"
        title={`Open up “${track.title}”`}
        copy="Choose an exact layout. Separation and controls are simulated; playback remains the original source mix."
        action={
          <Button
            variant="secondary"
            icon={<ArrowLeft />}
            onClick={() => navigate(`/master/${track.id}`)}
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
            Labels adapt to the selected count before the simulated split
            begins.
          </p>
        </div>
        <div className="stem-count">
          {[2, 3, 4, 5, 6].map((number) => (
            <button
              className={count === number ? "is-active" : ""}
              key={number}
              onClick={() => {
                if (
                  !stems.length ||
                  confirm("Replace the current simulated stem layout?")
                ) {
                  setCount(number)
                  setStems([])
                }
              }}
            >
              {number}
            </button>
          ))}
        </div>
        <div className="stem-preview">
          {stemNames[count].map((name) => (
            <span key={name}>{name}</span>
          ))}
        </div>
        <Button
          onClick={split}
          disabled={working}
          icon={working ? <RefreshCw className="spin" /> : <Scissors />}
        >
          {working
            ? "Separating source…"
            : stems.length
              ? "Run split again"
              : "Separate into stems"}
        </Button>
      </section>
      {stems.length > 0 && (
        <section className="stem-workspace">
          <div className="section-heading">
            <div>
              <span className="eyebrow">Simulated result</span>
              <h2>{count} stem mix</h2>
            </div>
            <Button
              icon={<ArrowRight />}
              onClick={() => navigate(`/master/${track.id}`)}
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
                    aria-label="Stem name"
                    onChange={(e) =>
                      updateStem(stem.id, { name: e.target.value })
                    }
                  />
                </div>
                <Waveform
                  seed={track.seed + index * 11}
                  duration={track.duration}
                  compact
                />
                <ControlGroup label="Level" value={`${stem.level} dB`}>
                  <input
                    type="range"
                    min="-24"
                    max="6"
                    value={stem.level}
                    onChange={(e) =>
                      updateStem(stem.id, { level: Number(e.target.value) })
                    }
                  />
                </ControlGroup>
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
                    min="-100"
                    max="100"
                    value={stem.pan}
                    onChange={(e) =>
                      updateStem(stem.id, { pan: Number(e.target.value) })
                    }
                  />
                </ControlGroup>
                <div className="mute-solo">
                  <button
                    className={stem.muted ? "is-active" : ""}
                    onClick={() => updateStem(stem.id, { muted: !stem.muted })}
                  >
                    Mute
                  </button>
                  <button
                    className={stem.solo ? "is-active" : ""}
                    onClick={() => updateStem(stem.id, { solo: !stem.solo })}
                  >
                    Solo
                  </button>
                </div>
              </article>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

function AlbumsPage() {
  const { state, dispatch } = useStore()
  const create = () => {
    const album: AlbumType = {
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
          <Button icon={<Plus />} onClick={create}>
            New album
          </Button>
        }
      />
      {state.albums.length === 0 ? (
        <div className="album-empty paper-panel">
          <div className="album-art-large">
            <Disc3 />
          </div>
          <div>
            <span className="eyebrow">Your first sequence</span>
            <h2>Bring the songs into one room.</h2>
            <p>
              Create an album to compare loudness, tone, and dynamics across
              your library.
            </p>
            <Button icon={<Plus />} onClick={create}>
              Create an album
            </Button>
          </div>
        </div>
      ) : (
        <div className="album-grid">
          {state.albums.map((album, index) => (
            <Link
              className="album-card"
              to={`/albums/${album.id}`}
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
                <strong>{album.trackIds.length ? 86 : "—"}</strong>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}

function AlbumPage() {
  const { albumId } = useParams()
  const { state, dispatch } = useStore()
  const album = state.albums.find((item) => item.id === albumId)
  if (!album) return <Navigate to="/albums" replace />
  const albumTracks = album.trackIds
    .map((id) => state.tracks.find((track) => track.id === id))
    .filter(Boolean) as Track[]
  return (
    <div className="page">
      <section className="album-hero">
        <div className="album-art-large">
          <Disc3 />
        </div>
        <div>
          <span className="eyebrow">Album workspace</span>
          <input
            className="title-input"
            value={album.title}
            onChange={(e) =>
              dispatch({
                type: "UPDATE_ALBUM",
                id: album.id,
                patch: { title: e.target.value },
              })
            }
          />
          <input
            className="artist-input"
            value={album.artist}
            placeholder="Add artist or release note"
            onChange={(e) =>
              dispatch({
                type: "UPDATE_ALBUM",
                id: album.id,
                patch: { artist: e.target.value },
              })
            }
          />
          <div className="album-meta">
            <span>{albumTracks.length} tracks</span>
            <span>{album.target}</span>
            <span>{album.mastered ? "Sequence mastered" : "In progress"}</span>
          </div>
        </div>
        <Button
          icon={<Sparkles />}
          onClick={() =>
            dispatch({
              type: "UPDATE_ALBUM",
              id: album.id,
              patch: { mastered: true },
            })
          }
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
                  className="icon-button"
                  onClick={() =>
                    dispatch({
                      type: "UPDATE_ALBUM",
                      id: album.id,
                      patch: {
                        trackIds: album.trackIds.filter(
                          (id) => id !== track.id,
                        ),
                      },
                    })
                  }
                >
                  <X />
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
                  key={track.id}
                  onClick={() =>
                    dispatch({
                      type: "UPDATE_ALBUM",
                      id: album.id,
                      patch: { trackIds: [...album.trackIds, track.id] },
                    })
                  }
                >
                  <Plus />
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
          <div className="consistency-chart">
            {albumTracks.length ? (
              albumTracks.map((track, index) => (
                <div key={track.id}>
                  <span
                    style={{ height: `${55 + (track.metrics.lufs + 18) * 8}%` }}
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

function ReferencePage() {
  const { trackId } = useParams()
  const { state, dispatch } = useStore()
  const navigate = useNavigate()
  const track = state.tracks.find((item) => item.id === trackId)
  const [referenceId, setReferenceId] = useState(
    state.tracks.find((item) => item.id !== trackId)?.id || "",
  )
  const [amount, setAmount] = useState(62)
  if (!track) return <Navigate to="/library" replace />
  const reference = state.tracks.find((item) => item.id === referenceId)
  return (
    <div className="page">
      <PageTitle
        eyebrow="Reference direction"
        title="Compare without copying"
        copy="Use another track as a tonal compass. The estimate is simulated and does not alter audio."
        action={
          <Button
            variant="secondary"
            icon={<ArrowLeft />}
            onClick={() => navigate(`/master/${track.id}`)}
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
                  value={referenceId}
                  onChange={(e) => setReferenceId(e.target.value)}
                >
                  {state.tracks
                    .filter((item) => item.id !== track.id)
                    .map((item) => (
                      <option value={item.id} key={item.id}>
                        {item.title}
                      </option>
                    ))}
                </select>
                <ChevronDown />
              </div>
              {reference && <MetricMini track={reference} />}
            </div>
          </div>
          <div className="overlay-chart">
            <Spectrum seed={track.seed} />
            {reference && (
              <svg
                className="reference-line"
                viewBox="0 0 100 60"
                preserveAspectRatio="none"
              >
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
          <ControlGroup label="Match amount" value={`${amount}%`}>
            <input
              type="range"
              value={amount}
              onChange={(e) => setAmount(Number(e.target.value))}
            />
          </ControlGroup>
          {[
            "Prioritize tone",
            "Protect low end",
            "Protect transients",
            "Include width",
          ].map((item, i) => (
            <label className="check-row" key={item}>
              <input type="checkbox" defaultChecked={i !== 3} />
              <span>
                <Check />
              </span>
              {item}
            </label>
          ))}
          <Button
            className="full-button"
            icon={<ArrowRight />}
            onClick={() => {
              dispatch({
                type: "UPDATE_TRACK",
                id: track.id,
                patch: { tone: "Reference-led", intensity: amount },
              })
              navigate(`/master/${track.id}`)
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
        <strong>{track.advanced.width}%</strong>
        <small>Width</small>
      </span>
    </div>
  )
}

function ReleasePage() {
  const { trackId } = useParams()
  const { state, dispatch } = useStore()
  const navigate = useNavigate()
  const track = state.tracks.find((item) => item.id === trackId)
  const [platform, setPlatform] = useState("Spotify")
  const [scanning, setScanning] = useState(false)
  const [score, setScore] = useState(track?.releaseScore)
  if (!track) return <Navigate to="/library" replace />
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
    }, 1300)
  }
  const checks = [
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
        copy="A simulated technical review for common distribution considerations."
        action={
          <Button
            variant="secondary"
            icon={<ArrowLeft />}
            onClick={() => navigate(`/master/${track.id}`)}
          >
            Back to master
          </Button>
        }
      />
      <div className="release-top paper-panel">
        <div className="score-ring">
          <strong>{score || "—"}</strong>
          <span>readiness</span>
        </div>
        <div>
          <span className="eyebrow">Selected release</span>
          <h2>{track.title}</h2>
          <p>
            {score
              ? score >= 90
                ? "This track is in strong shape for delivery."
                : "A few small decisions remain before delivery."
              : "Run the check to review loudness, peaks, dynamics, compatibility, and format."}
          </p>
          <div className="platforms">
            {[
              "Spotify",
              "Apple Music",
              "YouTube",
              "SoundCloud",
              "CD",
              "Podcast",
            ].map((item) => (
              <button
                className={platform === item ? "chip is-active" : "chip"}
                onClick={() => setPlatform(item)}
                key={item}
              >
                {item}
              </button>
            ))}
          </div>
        </div>
        <Button
          icon={scanning ? <RefreshCw className="spin" /> : <Gauge />}
          onClick={run}
          disabled={scanning}
        >
          {scanning ? "Reviewing release…" : "Run release check"}
        </Button>
      </div>
      {score && (
        <section className="check-list">
          <div className="check-list-head">
            <span>Check</span>
            <span>Reading</span>
            <span>Guidance</span>
          </div>
          {checks.map(([name, value, status, note]) => (
            <div className="check-item" key={name}>
              <span className={`check-icon check-icon--${status}`}>
                {status === "pass" ? <Check /> : <CircleAlert />}
              </span>
              <strong>{name}</strong>
              <span>{value}</span>
              <p>{note}</p>
            </div>
          ))}
          <div className="report-actions">
            <Button
              variant="secondary"
              icon={<ArrowDownToLine />}
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

function ToolsPage() {
  const { state } = useStore()
  const first = state.tracks[0]
  return (
    <div className="page">
      <PageTitle
        eyebrow="Focused utilities"
        title="Tools"
        copy="Different ways to listen to the same source more closely."
      />
      <div className="tools-grid">
        <ToolCard
          icon={<Scissors />}
          eyebrow="Separation"
          title="Smart stem splitter"
          copy="Open a mix into an exact two-to-six-stem layout."
          to={first ? `/split/${first.id}` : "/"}
        />
        <ToolCard
          icon={<RefreshCw />}
          eyebrow="Direction"
          title="Reference match"
          copy="Compare tone, dynamics, and width to another local track."
          to={first ? `/reference/${first.id}` : "/"}
        />
        <ToolCard
          icon={<Check />}
          eyebrow="Delivery"
          title="Release check"
          copy="Review common technical concerns before the handoff."
          to={first ? `/release-check/${first.id}` : "/"}
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
  to,
}: {
  icon: ReactNode
  eyebrow: string
  title: string
  copy: string
  to: string
}) {
  return (
    <Link className="tool-card" to={to}>
      <div>{icon}</div>
      <span className="eyebrow">{eyebrow}</span>
      <h2>{title}</h2>
      <p>{copy}</p>
      <span className="text-link">
        Open tool <ArrowRight />
      </span>
    </Link>
  )
}

export default function App() {
  return (
    <StoreProvider>
      <BrowserRouter>
        <AppShell />
      </BrowserRouter>
    </StoreProvider>
  )
}
