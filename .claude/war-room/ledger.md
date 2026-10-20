# Aurialis-WASM War-Room Ledger

Source of truth for the **Aurialis-WASM** backlog across `/war-room` and `/war-room-loop` iterations. The Chair updates this file after every Round D ruling and every Round E verification pass. One row per item; never delete a row — move completed items to **Verified & Merged** with commit/PR and test evidence, or to **Declined** with the reason.

**Statuses**:
`open` · `in-progress (<branch>)` · `awaiting-tech-writer (<branch>)` · `open — awaiting merge (<branch/PR>)` · `verified (<commit/PR>, <evidence-tier>)` · `blocked (<prerequisite>)` · `declined (<reason>)`

**Evidence Tiers** (from `.claude/war-room/repo-map.md`):
`unit` · `wasm-bridge` · `api-curl` · `newman-e2e` · `playwright-a11y-responsive` · `compiled-binary-smoke`

---

## Iteration Log

| Iteration | Date | Scope | Active Seats | Outcome |
|---|---|---|---|---|
| 0 | 2026-10-20 | Initial War Room & Multi-Model Agent Architecture Setup (Gemini Argon, Claude Code, OpenAI Codex) | `aurialis-backend`, `aurialis-frontend`, `aurialis-designer`, `aurialis-qa`, `aurialis-devils-advocate`, `aurialis-tech-writer`, `aurialis-product-engineer` | Seeded multi-model War Room roster, `/war-room` & `/war-room-loop` skills/commands, HCL/OKLCH & mobile-first rules, Postman/Newman + cURL QA protocol, and initial `WASM-1`…`WASM-10` product backlog. |

---

## Active Backlog (`P0` / `P1` / `P2` / `P3`)

| ID | Priority | Area | Title | Acceptance Criteria | Test Plan & Evidence Tier | Docs Impact | Status |
|---|---|---|---|---|---|---|---|
| `WASM-1` | **P0** | `go-backend` / `git-ci` | Single Go 1.26 + Next.js 16 (`pnpm`, Node 26) scaffold & `//go:embed` server (`cmd/aurialis`) with COOP/COEP headers | `go build ./cmd/aurialis` produces a single binary serving Next.js 16 static/standalone output, `/health`, and `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp` headers. Zero `npm`/`yarn` lockfiles. | `go test -race ./...`, `curl -i http://127.0.0.1:<port>/health`, `TS-001` (`compiled-binary-smoke`) | `README.md`, `docs/architecture.md`, `docs/api.md` | `open` |
| `WASM-2` | **P0** | `nextjs-ui` / `a11y-hcl` / `mobile-responsive` | Warm editorial HCL/OKLCH design system tokens, custom inline SVG `<Icon />` primitive (zero icon libraries), and mobile-first responsive `AppShell` | `src/app/globals.css` defines HCL/OKLCH-verified warm paper/ink/clay/moss/ochre tokens (`Newsreader` + `Instrument Sans` + `tabular-nums`); zero `lucide-react` imports; mobile (`320px–390px`) renders top bar + 4-item bottom nav + sticky mini-transport; desktop (`1024px–1440px`) renders left rail + canvas + right inspector; all targets `>=44×44px`; WCAG 2.2 AA contrast verified. | `pnpm run lint`, `vitest`, Playwright `320px`/`375px`/`768px`/`1024px`/`1440px` + axe (`playwright-a11y-responsive`) | `docs/architecture.md`, `docs/tasks.md` | `open` |
| `WASM-3` | **P0** | `wasm-dsp` / `audio-verify` | Waves-grade Go/WASM DSP core (`wasm/dsp`) + `AudioWorklet` / `SharedArrayBuffer` lock-free bridge + War-Room Audio Transformation Verification Suite (`aurialis-audio-engineer`, `aurialis-dsp-plugin-engineer`, `aurialis-grammy-veteran`, `aurialis-qa`) | Compiles `public/wasm/aurialis-dsp.wasm` implementing ZDF/TPT 5-band parametric EQ (zero Nyquist cramping, proportional-Q), program-dependent optical/FET/VCA compressor with sidechain HPF, 4× oversampled ITU-R BS.1770-4 True-Peak lookahead limiter, ADAA/oversampled tube (`Warm` $H_2$), tape (`Thick` $H_3$), and transformer (`Crisp` low-end iron) saturation, Linkwitz-Riley 24dB/oct mono-bass + M/S width, loudness-matched A/B, and TPDF dither with zero per-block heap allocations. Includes automated Audio Verification tests proving via FFT, LUFS/dBTP, THD, correlation, and envelope deltas that audio is changed in the exact physically expected way. | `go test -race -v ./wasm/... ./internal/audio/...`, Vitest WASM bridge + Playwright WAV export verification (`audio-verify`, `wasm-bridge`) | `docs/architecture.md`, `README.md`, `docs/tasks.md` | `open` |
| `WASM-4` | **P1** | `go-backend` / `security` / `qa-newman` | Concurrent job engine (`internal/jobs`) + Audio Content Disarm & Reconstruction (CDR) & host-machine upload security (`aurialis-security`) | Bounded worker pool with `context.Context` cancellation; Audio CDR strips all non-audio chunks/trailers and rejects polyglots (`MZ`, `ELF`, Mach-O, `PK\x03\x04` ZIP/JAR, `%PDF`, scripts) so malicious files can never be hidden or executed on the host machine; zero user-filename disk writes (in-memory PCM or ephemeral `0700`/`0600` `O_NOFOLLOW` CSPRNG `.pcm.tmp` spill unlinked via `defer`); `413` size cap; CRLF/path-traversal/RTLO sanitization; `Host` & `Origin` DNS-rebinding/CSRF defense; `DELETE /jobs/{id}` idempotency; zero goroutine leaks under 20 concurrent requests. | `go test -race ./internal/...`, Postman/Newman `TS-001`…`TS-011` + `curl` polyglot/CSRF/race probes (`newman-e2e`) | `docs/api.md`, `docs/architecture.md`, `docs/tasks.md` | `open` |
| `WASM-5` | **P1** | `nextjs-ui` / `mobile-responsive` | Upload/Home (`/`) & persisted IndexedDB Library (`/library`) with reusable primitives | Click, drag/drop, keyboard, and clipboard-paste upload; media metadata validation; multi-file drop handling; IndexedDB `projects` + `audio` Blob stores with quota/fallback warning and missing-Blob relink; mobile card view + desktop editorial table reusing `Button`, `StatusBadge`, `DropZone`, `Modal`. | Vitest + Playwright upload/library persistence & mobile/desktop specs (`playwright-a11y-responsive`) | `README.md`, `docs/tasks.md` | `open` |
| `WASM-6` | **P1** | `wasm-dsp` / `nextjs-ui` / `mobile-responsive` | Mastering Workspace (`/master/[trackId]`): Transport, custom SVG Waveform, Simple mode, Advanced 5-band EQ/DSP mode, and WAV export (16/24/32-bit + TPDF dither) | Shared `HTMLAudioElement` + WASM `AudioWorklet` chain, A/B comparison, responsive SVG waveform & draggable 5-band EQ with accessible numeric input equivalents and text summary, mobile accordions vs desktop right inspector, real WAV export with dither. | Vitest + Playwright keyboard/touch/a11y + WAV export verification (`playwright-a11y-responsive`) | `docs/architecture.md`, `docs/tasks.md` | `open` |
| `WASM-7` | **P1** | `ai-mastering` / `nextjs-ui` / `mobile-responsive` | In-house Deep Mastering (`MasteringScript` v1): 5 engineer profiles, section detection, AI-artifact analysis (`AI Repair`), and responsive 5-lane automation timeline | Go backend + WASM engine generates & applies schema-valid v1 `MasteringScript` across `modern_pop_polish`, `hip_hop_low_end`, `indie_warmth`, `metal_wall`, `pop_punk_air`; cancellable staged progress; 5 automation lanes (`Volume`, `EQ`, `Comp/Sat`, `Width`, `AI Repair`); mobile horizontally scrollable timeline with sticky lane labels + bottom-sheet move editor; dirty profile-switch confirmation; accessible text summary. | Go schema/script tests + Newman `TS-003` + Playwright Deep mode mobile/desktop spec (`newman-e2e`, `playwright-a11y-responsive`) | `docs/api.md`, `docs/architecture.md`, `docs/tasks.md` | `open` |
| `WASM-8` | **P1** | `go-backend` / `nextjs-ui` / `mobile-responsive` | Smart Stem Splitter (`/split/[trackId]`) with exact `2–6` stem selector & "Send to mastering" | Exact `2`, `3`, `4`, `5`, `6` stem mappings; post-processing count-change confirmation; per-stem mute/solo/level/pan/rename reusing `SliderField` and `Toggle`; shared transport playhead; handoff to mastering project. | Newman `TS-002` + Playwright Smart Split 2–6 stem spec (`newman-e2e`, `playwright-a11y-responsive`) | `docs/api.md`, `docs/tasks.md` | `open` |
| `WASM-9` | **P2** | `nextjs-ui` / `go-backend` / `mobile-responsive` | Albums (`/albums`, `/albums/[albumId]`), Reference Match (`/reference/[trackId]`), and Release Check (`/release-check/[trackId]`) | Album track ordering (desktop drag + mobile/keyboard up/down buttons), Loudness/Tone/Dynamics consistency SVG chart with outlier flags & batch mastering; Reference Match dual-curve SVG overlay & undoable apply; Release Check across Spotify/Apple Music/YouTube/SoundCloud/CD/Podcast with JSON report export. | Vitest + Playwright end-to-end journeys (`playwright-a11y-responsive`) | `docs/api.md`, `docs/tasks.md` | `open` |
| `WASM-10` | **P1** | `git-ci` / `qa-newman` | Unified GitHub Actions CI/CD pipeline (`ci-cd` gate) | Runs Go fmt/vet/race tests, WASM build, `pnpm` lint/typecheck/zero-icon-lib check, Vitest, Next.js 16 build, single Go binary build, Newman `PR Suite` (`TS-001`…`TS-013`), and Playwright mobile/desktop + axe WCAG 2.2 AA suite. | `.github/workflows/ci.yml` green on PR and `main` (`compiled-binary-smoke`) | `README.md`, `docs/architecture.md` | `open` |

---

## Verified & Merged

| ID | Priority | Area | Title | Merged Commit / PR | Verification Evidence |
|---|---|---|---|---|---|
| *(None yet — War Room Loop starts with pessimistic baseline: 0 features verified)* | | | | | |

---

## Declined (Bloat / Out of Scope)

| ID | Area | Proposal | Why Declined |
|---|---|---|---|
| `D-1` | `nextjs-ui` | Import `lucide-react` or `@heroicons/react` for rapid prototyping | Violates the Low-Bundle, Zero-Icon-Library invariant; all icons must use custom inline SVGs in `src/components/shared/Icon.tsx`. |
| `D-2` | `go-backend` | Keep a separate Python FastAPI container alongside the Go binary in production | Violates the Single Self-Contained Go Binary invariant; all web serving, job orchestration, DSP, and smart AI/LLM mastering run in-house from the Go + WASM binary. |
| `D-3` | `nextjs-ui` | Desktop-only DAW layout that scales down via CSS `zoom` or horizontal scroll on phones | Violates the Mobile-First & Responsive Design invariant enforced by `aurialis-frontend` and `aurialis-designer`. |
