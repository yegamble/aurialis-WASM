# Aurialis-WASM Developer Task Tracker

Maintained by [`aurialis-tech-writer`](../.claude/agents/aurialis-tech-writer.md) and [`aurialis-product-engineer`](../.claude/agents/aurialis-product-engineer.md). Every engineer agent (`aurialis-backend`, `aurialis-dsp-plugin-engineer`, `aurialis-audio-engineer`, `aurialis-grammy-veteran`, `aurialis-frontend`, `aurialis-designer`, `aurialis-security`, `aurialis-qa`) catches up with `aurialis-tech-writer` to update this file and [`.claude/war-room/ledger.md`](../.claude/war-room/ledger.md) before merging a branch to `main`.

---

## Workflow Rules

1. **Small, Atomic Commits**: Break every task below into small, single-concern commits (`feat`, `fix`, `test`, `docs`) on a short-lived branch.
2. **Developer → Technical Writer Catch-Up**: Before requesting final QA/Product Engineer sign-off, brief `aurialis-tech-writer` on any changed flags, endpoints, components, or test commands so `README.md`, `docs/api.md`, `docs/architecture.md`, and this file are updated in the same branch.
3. **Pessimistic Verification (`aurialis-qa` + `aurialis-devils-advocate`)**: No task moves to `verified` until all fail-fast static checks (`golangci-lint`, `identypo`, `govulncheck`, `tsc --noEmit`, `eslint --max-warnings=0`, `knip`, `cspell`), Postman/Newman (`TS-001`–`TS-015`), raw `curl` security probes, and Playwright `320px–1440px` responsive + axe WCAG 2.2 AA tests pass.
4. **Finished Means Merged (`aurialis-product-engineer`)**: A task is never marked `done` or `verified` while still on a feature branch. It is marked `open — awaiting merge` until merged to `main`.

---

## Task Matrix (Iteration 1 — Branch: `feat/war-room-iter1-vertical-slices`)

| Task ID | Priority | Title | Status | Evidence Tier | Implementing Commits |
|---|---|---|---|---|---|
| `WASM-1` | **P0** | Single Go 1.26 + Next.js 16 (`pnpm`, Node 26) scaffold & `//go:embed` server (`cmd/aurialis`) with COOP/COEP headers | `open — awaiting merge (feat/war-room-iter1-vertical-slices)` | `compiled-binary-smoke` | `3049756`, `41386c8` |
| `WASM-2` | **P0** | Warm editorial HCL/OKLCH design system tokens, custom inline SVG `<Icon />` primitive (zero icon libraries), and mobile-first responsive `AppShell` (`320px–1440px+`) | `open — awaiting merge (feat/war-room-iter1-vertical-slices)` | `playwright-a11y-responsive` | `8470405`, `421acca`, `3875075` |
| `WASM-3` | **P0** | Waves-grade Go/WASM DSP core (`wasm/dsp`) + `AudioWorklet` / `SharedArrayBuffer` bridge + Audio Transformation Verification Suite | `open — awaiting merge (feat/war-room-iter1-vertical-slices)` | `wasm-bridge`, `unit` | `f565ab3`, `3049756` |
| `WASM-4` | **P1** | Concurrent job engine (`internal/jobs`) + Audio Content Disarm & Reconstruction (CDR) & host-machine upload security | `open — awaiting merge (feat/war-room-iter1-vertical-slices)` | `newman-e2e`, `api-curl` | `f565ab3`, `3049756`, `41386c8`, `587731f` |
| `WASM-5` | **P1** | Upload/Home (`/`) & persisted IndexedDB Library (`/library`) reusing `Button`, `DropZone`, `StatusBadge`, `Modal` | `open — awaiting merge (feat/war-room-iter1-vertical-slices)` | `playwright-a11y-responsive` | `421acca`, `3875075` |
| `WASM-6` | **P1** | Mastering Workspace (`/master/[trackId]`): Transport, SVG Waveform, Simple mode, Advanced 5-band EQ/DSP, and 16/24/32-bit WAV export with TPDF dither | `open — awaiting merge (feat/war-room-iter1-vertical-slices)` | `playwright-a11y-responsive`, `unit` | `421acca`, `3875075` |
| `WASM-7` | **P1** | In-house Deep Mastering (`MasteringScript` v1): 5 engineer profiles, section detection, AI Repair, and responsive 5-lane automation timeline | `open — awaiting merge (feat/war-room-iter1-vertical-slices)` | `newman-e2e`, `unit` | `f565ab3`, `41386c8`, `587731f` |
| `WASM-8` | **P1** | Smart Stem Splitter (`/split/[trackId]`) with exact `2–6` stem selector, count-change confirmation, and "Send to mastering" | `open — awaiting merge (feat/war-room-iter1-vertical-slices)` | `newman-e2e`, `playwright-a11y-responsive` | `f565ab3`, `3049756`, `421acca`, `587731f` |
| `WASM-9` | **P2** | Albums (`/albums`, `/albums/[albumId]`), Reference Match (`/reference/[trackId]`), and Release Check (`/release-check/[trackId]`) | `open — awaiting merge (feat/war-room-iter1-vertical-slices)` | `playwright-a11y-responsive` | `421acca`, `3875075` |
| `WASM-10` | **P1** | Unified GitHub Actions CI/CD pipeline (`.github/workflows/ci.yml`) with all skip guards removed | `open — awaiting merge (feat/war-room-iter1-vertical-slices)` | `compiled-binary-smoke` | `5e07560` |

---

## Open Architectural Follow-Ups & Caveats

1. **Client TS DSP vs. Go/WASM Reference Engine**:
   - The browser UI includes a per-sample TypeScript DSP chain (`src/lib/audio-dsp.ts`) featuring a 1-pole mono-bass crossover and sample-peak limiter for interactive responsiveness.
   - The Go/WASM engine (`internal/audio/dsp`, `wasm/dsp`) is the calibrated reference implementation with ZDF/TPT SVF filters, 4th-order Linkwitz-Riley mono-bass crossover, and 4× oversampled True-Peak limiting.
2. **AudioWorklet Live Playback Routing**:
   - Interactive preview playback currently runs through `HTMLAudioElement` and client TypeScript DSP.
   - Direct routing of real-time browser playback through the compiled WASM `AudioWorklet` processor (`public/worklets/aurialis-dsp-worklet.js`) is planned for a subsequent integration slice.
3. **Simple-Mode Metrics Estimation**:
   - Simple-mode UI metrics are parameter-estimated approximations rather than measured directly from decoded PCM waveforms.
4. **Vulnerability Gate (`govulncheck`)**:
   - `govulncheck ./...` reports Go standard library finding `GO-2026-6617` on Go `1.26.2`. This is an upstream Go standard library vulnerability resolved in Go `1.26.9`.

