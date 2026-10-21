# Aurialis-WASM War-Room Ledger
<!-- cspell:words Embedder -->

Source of truth for the **Aurialis-WASM** backlog across `/war-room` and `/war-room-loop` iterations. The Chair updates this file after every Round D ruling and every Round E verification pass. One row per item; never delete a row — move completed items to **Verified & Merged** with commit/PR and test evidence, or to **Declined** with the reason.

**Statuses**:
`open` · `in-progress (<branch>)` · `awaiting-tech-writer (<branch>)` · `open — awaiting merge (<branch/PR>)` · `implemented — open, awaiting merge (<branch/PR>)` · `verified (<commit/PR>, <evidence-tier>)` · `blocked (<prerequisite>)` · `declined (<reason>)`

**Evidence Tiers** (from `.claude/war-room/repo-map.md`):
`unit` · `wasm-bridge` · `api-curl` · `newman-e2e` · `playwright-a11y-responsive` · `compiled-binary-smoke`

---

## Iteration Log

| Iteration | Date | Scope | Active Seats | Outcome |
|---|---|---|---|---|
| 0 | 2026-10-20 | Initial War Room & Multi-Model Agent Architecture Setup (Gemini Argon, Claude Code, OpenAI Codex) | `aurialis-backend`, `aurialis-frontend`, `aurialis-designer`, `aurialis-qa`, `aurialis-devils-advocate`, `aurialis-tech-writer`, `aurialis-product-engineer` | Seeded multi-model War Room roster, `/war-room` & `/war-room-loop` skills/commands, HCL/OKLCH & mobile-first rules, Postman/Newman + cURL QA protocol, and initial `WASM-1`…`WASM-10` product backlog. |
| 1 | 2026-10-21 | Vertical Slices Implementation & Verification Wave (`feat/war-room-iter1-vertical-slices`) | `aurialis-backend`, `aurialis-dsp-plugin-engineer`, `aurialis-frontend`, `aurialis-designer`, `aurialis-qa`, `aurialis-devils-advocate`, `aurialis-tech-writer`, `aurialis-product-engineer` | Implemented end-to-end vertical slices across single Go binary embedding (`cmd/aurialis`), Audio CDR, 5-profile mastering engine, 2–6 stem separation, Next.js 16 warm editorial workstation (9 routes), client DSP & WAV export, control-isolation tests, Newman TS-001..TS-015 + curl probes, Playwright a11y/responsive suites, and unconditional CI pipeline. Status: `implemented — open, awaiting merge`. |

---

## Active Backlog (`P0` / `P1` / `P2` / `P3`)

| ID | Priority | Area | Title | Acceptance Criteria | Test Plan & Evidence Tier | Docs Impact | Status |
|---|---|---|---|---|---|---|---|
| `WASM-1` | **P0** | `go-backend` / `git-ci` | Single Go 1.26 + Next.js 16 (`pnpm`, Node 26) scaffold & `//go:embed` server (`cmd/aurialis`) with COOP/COEP headers | `go build ./cmd/aurialis` produces a single binary serving Next.js 16 static export (`internal/webui`), `/health`, and `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp` headers; flags `-addr`, `-workers`, `-max-upload-bytes`. | `go test -race ./...`, `curl -i http://127.0.0.1:<port>/health`, `TS-001` (`compiled-binary-smoke`) | `README.md`, `docs/architecture.md`, `docs/api.md` | `implemented — open, awaiting merge (feat/war-room-iter1-vertical-slices)` |
| `WASM-2` | **P0** | `nextjs-ui` / `a11y-hcl` / `mobile-responsive` | Warm editorial HCL/OKLCH design system tokens, custom inline SVG `<Icon />` primitive (zero icon libraries), and mobile-first responsive `AppShell` | `src/app/globals.css` defines HCL/OKLCH-calibrated warm paper/ink/clay/moss/ochre tokens; zero external icon libraries; mobile (`320px–390px`) renders top bar + 4-item bottom nav + sticky mini-transport; desktop renders left rail + canvas + right inspector; all touch targets `>=44×44px`; WCAG 2.2 AA contrast verified. | `pnpm run lint`, `vitest` (Icon test), Playwright `320px`/`375px`/`768px`/`1024px`/`1440px` + axe WCAG 2.2 AA (`playwright-a11y-responsive`) | `docs/architecture.md`, `docs/tasks.md` | `implemented — open, awaiting merge (feat/war-room-iter1-vertical-slices)` |
| `WASM-3` | **P0** | `wasm-dsp` / `audio-verify` | Waves-grade Go/WASM DSP core (`wasm/dsp`) + `AudioWorklet` / `SharedArrayBuffer` lock-free bridge + War-Room Audio Transformation Verification Suite | Compiles `public/wasm/aurialis-dsp.wasm` implementing ZDF/TPT 5-band parametric EQ, program-dependent optical/FET/VCA compressor with 90 Hz sidechain HPF, 4× oversampled True-Peak limiter, ADAA tube/tape/transformer saturation, Linkwitz-Riley mono-bass + M/S width, and TPDF dither. Audio verification suite confirms physical accuracy. | `go test -race -v ./wasm/... ./internal/audio/...`, `orthogonality_test.go` (`wasm-bridge`, `unit`) | `docs/architecture.md`, `README.md`, `docs/tasks.md` | `implemented — open, awaiting merge (feat/war-room-iter1-vertical-slices)` |
| `WASM-4` | **P1** | `go-backend` / `security` / `qa-newman` | Concurrent job engine (`internal/jobs`) + Audio Content Disarm & Reconstruction (CDR) & host-machine upload security (`aurialis-security`) | Bounded worker pool with `context.Context` cancellation; Audio CDR strips all non-audio chunks/trailers and rejects polyglots (`MZ`, `ELF`, Mach-O, `PK\x03\x04`, `%PDF`); zero user-filename disk writes (in-memory Float32 PCM buffers); `413` size cap; CRLF/path-traversal sanitization; `Host` & `Origin` DNS-rebinding/CSRF defense; `DELETE /jobs/{id}` idempotency. | `go test -race ./internal/...`, Newman `TS-001`…`TS-015` + raw `curl` 413 & DNS-rebinding probes (`newman-e2e`, `api-curl`) | `docs/api.md`, `docs/architecture.md`, `docs/tasks.md` | `implemented — open, awaiting merge (feat/war-room-iter1-vertical-slices)` |
| `WASM-5` | **P1** | `nextjs-ui` / `mobile-responsive` | Upload/Home (`/`) & persisted IndexedDB Library (`/library`) with reusable primitives | Click, drag/drop, keyboard, and paste upload; media metadata validation; IndexedDB `projects` + `audio` Blob stores with fallback warning; mobile card view + desktop editorial table reusing `Button`, `StatusBadge`, `DropZone`, `Modal`. | Vitest + Playwright upload/library persistence & responsive specs (`playwright-a11y-responsive`) | `README.md`, `docs/tasks.md` | `implemented — open, awaiting merge (feat/war-room-iter1-vertical-slices)` |
| `WASM-6` | **P1** | `wasm-dsp` / `nextjs-ui` / `mobile-responsive` | Mastering Workspace (`/master/[trackId]`): Transport, custom SVG Waveform, Simple mode, Advanced 5-band EQ/DSP mode, and WAV export (16/24/32-bit + TPDF dither) | Draggable 5-band SVG EQ with accessible numeric inputs and text summary; reducer control isolation (`src/lib/store.tsx`); client DSP processing & 16/24/32-bit dithered WAV export (`src/lib/audio-dsp.ts`); mobile accordions vs desktop right inspector. | Vitest `control-isolation.test.ts` + Playwright `control-isolation.spec.ts` & `audio-export-verify.spec.ts` (`playwright-a11y-responsive`, `unit`) | `docs/architecture.md`, `docs/tasks.md` | `implemented — open, awaiting merge (feat/war-room-iter1-vertical-slices)` |
| `WASM-7` | **P1** | `ai-mastering` / `nextjs-ui` / `mobile-responsive` | In-house Deep Mastering (`MasteringScript` v1): 5 engineer profiles, section detection, AI-artifact analysis (`AI Repair`), and responsive 5-lane automation timeline | Go backend + WASM engine generates & applies schema-valid v1 `MasteringScript` across 5 profiles (`Warm Analog`, `Punchy Commercial`, `Dynamic & Open`, `Vocal Forward`, `Bass Heavy`) and UI aliases; staged progress; 5 automation lanes; mobile scrollable timeline with sticky lane labels; accessible text summary. | Go `mastering_test.go` + Newman `TS-003` + Playwright Deep mode spec (`newman-e2e`, `unit`) | `docs/api.md`, `docs/architecture.md`, `docs/tasks.md` | `implemented — open, awaiting merge (feat/war-room-iter1-vertical-slices)` |
| `WASM-8` | **P1** | `go-backend` / `nextjs-ui` / `mobile-responsive` | Smart Stem Splitter (`/split/[trackId]`) with exact `2–6` stem selector & "Send to mastering" | Exact `2`, `3`, `4`, `5`, `6` stem mappings; model parameter support (`htdemucs`); per-stem mute/solo/level/pan/rename reusing `SliderField` and `Toggle`; stem audio downloads (`/jobs/{id}/stems/{stem}`); handoff to mastering. | Newman `TS-002`, `TS-013` + Playwright Smart Split spec (`newman-e2e`, `playwright-a11y-responsive`) | `docs/api.md`, `docs/tasks.md` | `implemented — open, awaiting merge (feat/war-room-iter1-vertical-slices)` |
| `WASM-9` | **P2** | `nextjs-ui` / `go-backend` / `mobile-responsive` | Albums (`/albums`, `/albums/[albumId]`), Reference Match (`/reference/[trackId]`), and Release Check (`/release-check/[trackId]`) | Album track ordering & consistency SVG chart; Reference Match dual-curve SVG overlay; Release Check across Spotify, Apple Music, YouTube, SoundCloud, CD, and Podcast with compliance audits. | Playwright responsive & navigation journeys across all 9 routes (`playwright-a11y-responsive`) | `docs/api.md`, `docs/tasks.md` | `implemented — open, awaiting merge (feat/war-room-iter1-vertical-slices)` |
| `WASM-10` | **P1** | `git-ci` / `qa-newman` | Unified GitHub Actions CI/CD pipeline (`ci-cd` gate) | Unconditional execution of all quality gates in `.github/workflows/ci.yml`: repo/agent hygiene, Go/WASM quality gate, Next.js/TS frontend quality, Newman PR suite (`TS-001`..`TS-015`) + raw curl probes, and Playwright a11y/responsive checks. | `.github/workflows/ci.yml` unconditional configuration (`compiled-binary-smoke`) | `README.md`, `docs/architecture.md` | `implemented — open, awaiting merge (feat/war-room-iter1-vertical-slices)` |

---

## Verified & Merged

| ID | Priority | Area | Title | Merged Commit / PR | Verification Evidence |
|---|---|---|---|---|---|
| *(None yet — War Room Loop starts with pessimistic baseline: 0 features verified until merged to main)* | | | | | |

---

## Declined (Bloat / Out of Scope)

| ID | Area | Proposal | Why Declined |
|---|---|---|---|
| `D-1` | `nextjs-ui` | Import `lucide-react` or `@heroicons/react` for rapid prototyping | Violates the Low-Bundle, Zero-Icon-Library invariant; all icons must use custom inline SVGs in `src/components/shared/Icon.tsx`. |
| `D-2` | `go-backend` | Keep a separate Python FastAPI container alongside the Go binary in production | Violates the Single Self-Contained Go Binary invariant; all web serving, job orchestration, DSP, and smart AI/LLM mastering run in-house from the Go + WASM binary. |
| `D-3` | `nextjs-ui` | Desktop-only DAW layout that scales down via CSS `zoom` or horizontal scroll on phones | Violates the Mobile-First & Responsive Design invariant enforced by `aurialis-frontend` and `aurialis-designer`. |
| `D-4` | `a11y-hcl` | Dark-mode / neon plugin theme switcher | Contradicts the warm editorial paper studio aesthetic (`docs/design/aurialis-redesign.md`) and doubles token maintenance. |
| `D-5` | `wasm-dsp` | Duplicate DSP filter math in TypeScript alongside Go/WASM | Unnecessary maintenance bloat; share one pure-Go DSP core (`internal/audio/dsp`) between native Go (`cmd/aurialis`) and WebAssembly (`wasm/dsp`). |

---

## Iteration Log

### Iteration 1 — Implementation & Verification Wave (`feat/war-room-iter1-vertical-slices`)

- **Seats Convened**: `aurialis-backend`, `aurialis-dsp-plugin-engineer`, `aurialis-designer`, `aurialis-frontend`, `aurialis-qa`, `aurialis-devils-advocate`, `aurialis-tech-writer`, `aurialis-product-engineer`.
- **Commits on Branch**:
  - `8470405`: docs(design): add canonical warm editorial HCL/OKLCH design system and Iter 1 Round D ruling
  - `f565ab3`: feat(dsp): implement Waves-grade Go+WASM DSP engine, Audio CDR, MasteringScript v1, and 2-6 stem splitter
  - `3049756`: feat(backend): add concurrent job manager, COOP/COEP HTTP server, AudioWorklet, and single-binary entrypoint
  - `421acca`: feat(ui): implement Next.js 16 warm editorial workstation, 5-band EQ, real WAV export, and control-isolation tests
  - `41386c8`: fix(backend): accept UI profile ids, add ?wait=1 job polling and loudness render headers
  - `587731f`: test(qa): add Newman TS-001..TS-015 suite with curl 413/DNS-rebinding probes
  - `3875075`: test(qa): add Playwright responsive, axe WCAG 2.2 AA, control-isolation and WAV export specs
  - `5e07560`: ci: remove conditional skip guards so all gates run unconditionally (WASM-10)
- **Consolidated Implementation Slices**:
  1. **Go/WASM DSP & Audio CDR Core**: Pure-Go DSP engine (`internal/audio/dsp`, `wasm/dsp`) with ZDF/TPT filters, optical/FET/VCA compression with 90 Hz sidechain HPF, ADAA saturation, 4× True-Peak limiter, TPDF dither, and Audio CDR rejecting polyglots and sanitizing PCM samples.
  2. **Concurrent Server & Dual API Contract**: `internal/server` and `internal/jobs` providing `/health`, `/separate` (2–6 stems), `/analyze/deep` (5 profiles + UI aliases), `/api/master/render` (`audio/wav` with LUFS/dBTP headers or JSON), `/jobs/{id}` with `?wait=1` long-polling, `/jobs/{id}/stems/{stem}`, and `DELETE /jobs/{id}`.
  3. **Next.js 16 UI Workstation**: 9 App Router routes (`/`, `/library`, `/albums`, `/albums/[albumId]`, `/master/[trackId]`, `/split/[trackId]`, `/reference/[trackId]`, `/release-check/[trackId]`, `/tools`) embedding via `internal/webui` (`//go:embed all:embedded`), store reducer control-isolation, client DSP and WAV export, custom inline SVGs only, mobile-first responsive layouts (`320px–1440px+`), and `>=44×44px` touch targets.
  4. **Adversarial QA Suite**: Go race & audio transformation tests, Vitest control-isolation & Icon tests, Newman `TS-001`–`TS-015` with raw `curl` 413 and DNS-rebinding probes, Playwright responsive (`320px`/`375px`/`768px`/`1024px`/`1440px`), axe WCAG 2.2 AA, and unconditional CI workflow.
- **Open Architectural Follow-Ups & Caveats**:
  1. *Client TS DSP vs. Go/WASM Reference Engine*: Client-side TypeScript DSP is a simplified per-sample chain (1-pole mono-bass crossover, sample-peak limiter) for low-latency slider interaction; the Go/WASM engine is the calibrated reference implementation with ZDF/TPT filters, 4th-order Linkwitz-Riley crossover, and 4× oversampled True-Peak limiting.
  2. *AudioWorklet Live Playback Routing*: Browser interactive preview playback currently runs through `HTMLAudioElement` and client TypeScript DSP; direct live playback routing through the compiled WASM `AudioWorklet` processor (`public/worklets/aurialis-dsp-worklet.js`) is an open integration follow-up.
  3. *Simple-Mode Metrics Estimation*: Simple-mode UI metrics are parameter-estimated approximations rather than measured directly from decoded user audio waveforms.
  4. *Vulnerability Scan Gate (`govulncheck`)*: `govulncheck ./...` reports Go standard library finding `GO-2026-6617` on Go `1.26.2`, which is resolved in Go `1.26.9`.

