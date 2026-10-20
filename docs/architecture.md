# Aurialis-WASM Technical Architecture

Maintained by [`aurialis-tech-writer`](../.claude/agents/aurialis-tech-writer.md) in collaboration with [`aurialis-backend`](../.claude/agents/aurialis-backend.md), [`aurialis-frontend`](../.claude/agents/aurialis-frontend.md), and [`aurialis-designer`](../.claude/agents/aurialis-designer.md).

---

## 1. High-Level System Topology

```mermaid
flowchart LR
  subgraph Browser["Browser (Mobile 320px -> Desktop 1440px+)"]
    UI["Next.js 16 App Router UI\n(Tailwind CSS v4 + Custom Inline SVGs)"]
    IDB["IndexedDB Stores\n(projects, audio Blobs, albums, stemProjects)"]
    SAB["SharedArrayBuffer Ring Buffers"]
    AW["AudioWorkletProcessor\n+ aurialis-dsp.wasm"]
    UI <--> IDB
    UI <--> SAB
    SAB <--> AW
  end

  subgraph GoBinary["Single Go 1.26 Binary (cmd/aurialis)"]
    Embed["//go:embed Next.js Static + .wasm Assets\n(COOP: same-origin, COEP: require-corp)"]
    API["HTTP / Multipart API Server\n(Magic-Byte Sniff + 413 Cap + CORS)"]
    Pool["Bounded Concurrent Job Pool\n(Context Cancellation + sync.Pool Buffers)"]
    Engine["In-House Mastering & Separation Engine\n(MasteringScript v1, 2-6 Stems, AI Artifacts)"]
    Embed --> API
    API --> Pool
    Pool --> Engine
  end

  UI <-->|"REST / Polling / cURL / Newman"| API
  Embed -.->|"Serves HTML/JS/CSS & application/wasm"| UI
```

---

## 2. Single-Binary Go + Next.js 16 Embedding (`cmd/aurialis`)

- **Frontend Build**: Next.js 16 (`^16.4.2`) compiles with `pnpm run build` on Node `26.12.0` into static/standalone assets.
- **WASM Compilation**: `GOOS=js GOARCH=wasm go build -trimpath -o public/wasm/aurialis-dsp.wasm ./wasm/dsp` compiles our Go DSP package into a compact WebAssembly binary before the Go host binary embeds the static bundle.
- **Cross-Origin Isolation Middleware**: Every response serving the application shell, scripts, and worklets attaches:
  - `Cross-Origin-Opener-Policy: same-origin`
  - `Cross-Origin-Embedder-Policy: require-corp`
  - `Content-Type: application/wasm` on `.wasm` routes.

---

## 3. Concurrent Job Orchestration (`internal/jobs`)

When multiple users or batch operations trigger simultaneous jobs (Smart Split `2–6` stems, Deep Analysis `MasteringScript` v1, Album Batch Mastering):
- **Bounded Worker Pool**: A fixed-size worker pool bounded by CPU/memory semaphores prevents unbounded goroutine spawning or OOM spikes.
- **Context Cancellation**: Every job owns a `context.WithCancel` stored in the job registry; `DELETE /jobs/{id}` or client disconnect cancels the context and stops DSP/analysis loops immediately.
- **Zero-Copy Buffer Pooling**: `sync.Pool` recycles Float32 sample buffers and FFT scratch slices so 10-minute audio files (`TS-012`) do not trigger GC thrashing.

---

## 4. Frontend Component Reuse & Mobile-First Architecture (`src/`)

- **Zero External Icon Libraries**: All icons are rendered through `src/components/shared/Icon.tsx` using inline SVG paths. Waveforms, 5-band parametric EQ curves, Deep automation timelines, album consistency charts, and reference overlays are bespoke responsive SVGs paired with accessible text summaries and labeled form inputs.
- **Shared Primitive Hierarchy**:
  - `src/components/layout/{AppShell,Navigation,PageHeader}.tsx`
  - `src/components/shared/{Button,Icon,DropZone,Modal,BottomSheet,EmptyState,StatusBadge}.tsx`
  - `src/components/controls/{SliderField,SegmentedControl,Toggle,ProcessingState}.tsx`
  - `src/components/audio/{Transport,Waveform,MetricStrip,SpectrumChart,DeepTimeline,DeepMoveEditor,EngineerProfilePicker}.tsx`
- **Mobile-First Responsive Breakpoints**:
  - `320px–767px` (Base): Compact top bar, 4-item bottom nav, sticky mini-transport, accordion DSP panels, horizontally scrollable Deep timeline with sticky lane headers, bottom-sheet move editor, `>=44×44px` touch targets.
  - `768px–1023px` (`md:`): 2-column analysis cards and side-by-side module layouts.
  - `1024px–1440px+` (`lg:`/`xl:`): Fixed `230px` left rail, central visualization canvas, `360px` right inspector, and sticky bottom transport.
