# Aurialis-WASM War-Room Ledger
<!-- cspell:words Embedder -->

Source of truth for the **Aurialis-WASM** backlog across `/war-room` and `/war-room-loop` iterations. The Chair updates this file after every Round D ruling and every Round E verification pass. One row per item; never delete a row — move completed items to **Verified & Merged** with commit/PR and test evidence, or to **Declined** with the reason.

**Statuses**:
`open` · `in-progress (<branch>)` · `awaiting-tech-writer (<branch>)` · `open — awaiting merge (<branch/PR>)` · `implemented — open, awaiting merge (<branch/PR>)` · `verified (<commit/PR>, <evidence-tier>)` · `blocked (<prerequisite>)` · `declined (<reason>)`

**Evidence Tiers** (from `.claude/war-room/repo-map.md`):
`unit` · `wasm-bridge` · `api-curl` · `newman-e2e` · `playwright-a11y-responsive` · `compiled-binary-smoke`

---

## Current ruling — 2026-10-21 product recovery

The latest whole-product review audited local and remote `main` at `ade7736` (the only live branch). The blanket verification claims in the historical activation record are withdrawn. The corrected design archive matches the canonical checked-in Figma source exactly.

[The baseline audit](../../docs/reviews/2026-10-21-war-room-audit.md) records 17 evidence-backed recovery items, reproduction steps, acceptance criteria, dissent and retractions. The user subsequently requested implementation, Figma fidelity, removal of prototype examples, and independent verification of every audio setting. Corrective work is on `codex/war-room-product-audit`, using isolated design, audio and workflow checkouts. The bounded corrective subset passed local verification and is **open — awaiting merge (`codex/war-room-product-audit`)**. The corrective change is [draft PR #2](https://github.com/yegamble/aurialis-WASM/pull/2). Default owner merge gate applies; full-product completion and a merge are not claimed.

The current recovery retains real shared Go/WASM processing and replaces misleading success paths. Trained separation, source-derived musical/AI analysis, time automation and continuous worklet streaming remain requirements. Finite 3/5-minute native processing now has representative execution evidence; longer/high-rate/browser-scale capacity remains open; honest unavailable states do not deliver them.

## Iteration Log

| Iteration | Date | Scope | Active Seats | Outcome |
|---|---|---|---|---|
| 0 | 2026-10-20 | Initial War Room & Multi-Model Agent Architecture Setup (Gemini Argon, Claude Code, OpenAI Codex) | `aurialis-backend`, `aurialis-frontend`, `aurialis-designer`, `aurialis-qa`, `aurialis-devils-advocate`, `aurialis-tech-writer`, `aurialis-product-engineer` | Seeded multi-model War Room roster, `/war-room` & `/war-room-loop` skills/commands, HCL/OKLCH & mobile-first rules, Postman/Newman + cURL QA protocol, and initial `WASM-1`…`WASM-10` product backlog. |
| 1 | 2026-10-21 | Vertical Slices Implementation & Verification Wave (`feat/war-room-iter1-vertical-slices`) | `aurialis-backend`, `aurialis-dsp-plugin-engineer`, `aurialis-frontend`, `aurialis-designer`, `aurialis-qa`, `aurialis-devils-advocate`, `aurialis-tech-writer`, `aurialis-product-engineer` | Initial vertical slice scaffold: single Go binary embedding (`cmd/aurialis`), Audio CDR, 5-profile mastering engine, 2–6 stem separation, Next.js 16 warm editorial workstation (9 routes), client DSP & WAV export, control-isolation tests, Newman TS-001..TS-015 + curl probes, Playwright a11y/responsive suites, and unconditional CI pipeline. |
| 2 | 2026-10-21 | Historical activation claim — withdrawn: 100% Vertical Slice Activation & Honest Verification (`war-room/iter2-validation`) | `aurialis-backend`, `aurialis-dsp-plugin-engineer`, `aurialis-frontend`, `aurialis-designer`, `aurialis-qa`, `aurialis-devils-advocate`, `aurialis-tech-writer`, `aurialis-product-engineer` | Slices S1..S7 fully activated without placeholder wrappers: Simple mode (`mapSimpleToDSP`), Deep mode (`mapProfileToDSP`, `DeepTimeline`, `MoveEditor`), Loudness-Matched A/B (`RealTransport` RMS auto-trim), Smart Split (`SplitView` 2-6 stems), Albums (`AlbumView` sequence reordering & batch normalization), Reference Match (real EQ contour overlay & delta mapping), Release Check (objective platform targets for Spotify/Apple/YouTube/SoundCloud/CD/Podcast). All 14 Playwright tests, Newman TS-001..TS-015, Go race tests, and frontend linters pass. Status: `implemented — open, awaiting merge`. |

---

## Active Backlog (`P0` / `P1` / `P2` / `P3`)

Acceptance criteria below retain the intended product scope. Test-plan columns name required evidence.

| ID | Priority | Area | Title | Acceptance Criteria | Test Plan & Evidence Tier | Docs Impact | Status |
|---|---|---|---|---|---|---|---|
| `WASM-1` | **P0** | `go-backend` / `git-ci` | Single Go 1.26 + Next.js 16 (`pnpm`, Node 26) scaffold & `//go:embed` server (`cmd/aurialis`) with COOP/COEP headers | `pnpm run build:binary` produces a single binary serving Next.js 16 static export (`internal/webui`), `/health`, and `Cross-Origin-Opener-Policy: same-origin` + `Cross-Origin-Embedder-Policy: require-corp` headers; flags `-addr`, `-workers`, `-max-upload-bytes`. | `go test -race ./...`, `curl -i http://127.0.0.1:<port>/health`, `TS-001` (`compiled-binary-smoke`) | `README.md`, `docs/architecture.md`, `docs/api.md` | `open (acceptance not met; see recovery audit)` |
| `WASM-2` | **P0** | `nextjs-ui` / `a11y-hcl` / `mobile-responsive` | Warm editorial HCL/OKLCH design system tokens, custom inline SVG `<Icon />` primitive (zero icon libraries), and mobile-first responsive `AppShell` | `src/app/globals.css` defines HCL/OKLCH-calibrated warm paper/ink/clay/moss/ochre tokens; zero external icon libraries; mobile (`320px–390px`) renders top bar + 4-item bottom nav + sticky mini-transport; desktop renders left rail + canvas + right inspector; all touch targets `>=44×44px`; WCAG 2.2 AA contrast verified. | `pnpm run lint`, `vitest` (Icon test), Playwright `320px`/`375px`/`768px`/`1024px`/`1440px` + axe WCAG 2.2 AA (`playwright-a11y-responsive`) | `docs/architecture.md`, `docs/tasks.md` | `open (acceptance not met; see recovery audit)` |
| `WASM-3` | **P0** | `wasm-dsp` / `audio-verify` | Waves-grade Go/WASM DSP core (`wasm/dsp`) + `AudioWorklet` / `SharedArrayBuffer` lock-free bridge + War-Room Audio Transformation Verification Suite | Compiles `public/wasm/aurialis-dsp.wasm` implementing ZDF/TPT 5-band parametric EQ, program-dependent optical/FET/VCA compressor with 90 Hz sidechain HPF, 4× oversampled True-Peak limiter, ADAA tube/tape/transformer saturation, Linkwitz-Riley mono-bass + M/S width, and TPDF dither. Audio verification suite confirms physical accuracy. | `go test -race -v ./wasm/... ./internal/audio/...`, `orthogonality_test.go` (`wasm-bridge`, `unit`) | `docs/architecture.md`, `README.md`, `docs/tasks.md` | `open (acceptance not met; see recovery audit)` |
| `WASM-4` | **P1** | `go-backend` / `security` / `qa-newman` | Concurrent job engine (`internal/jobs`) + Audio Content Disarm & Reconstruction (CDR) & host-machine upload security (`aurialis-security`) | Bounded worker pool with `context.Context` cancellation; Audio CDR strips all non-audio chunks/trailers and rejects polyglots (`MZ`, `ELF`, Mach-O, `PK\x03\x04`, `%PDF`); zero user-filename disk writes (in-memory Float32 PCM buffers); `413` size cap; CRLF/path-traversal sanitization; `Host` & `Origin` DNS-rebinding/CSRF defense; `DELETE /jobs/{id}` idempotency. | `go test -race ./internal/...`, Newman `TS-001`…`TS-015` + raw `curl` 413 & DNS-rebinding probes (`newman-e2e`, `api-curl`) | `docs/api.md`, `docs/architecture.md`, `docs/tasks.md` | `open (acceptance not met; see recovery audit)` |
| `WASM-5` | **P1** | `nextjs-ui` / `mobile-responsive` | Upload/Home (`/`) & persisted IndexedDB Library (`/library`) with reusable primitives | Click, drag/drop, keyboard, and paste upload; media metadata validation; IndexedDB `projects` + `audio` Blob stores with fallback warning; mobile card view + desktop editorial table reusing `Button`, `StatusBadge`, `DropZone`, `Modal`. | Vitest + Playwright upload/library persistence & responsive specs (`playwright-a11y-responsive`) | `README.md`, `docs/tasks.md` | `open (acceptance not met; see recovery audit)` |
| `WASM-6` | **P1** | `wasm-dsp` / `nextjs-ui` / `mobile-responsive` | Mastering Workspace (`/master/[trackId]`): Transport, custom SVG Waveform, Simple mode, Advanced 5-band EQ/DSP mode, and WAV export (16/24/32-bit + TPDF dither) | Draggable 5-band SVG EQ with accessible numeric inputs and text summary; reducer control isolation (`src/lib/store.tsx`); shared Go DSP processing and 16/24-bit dithered PCM or 32-bit float WAV export; mobile accordions vs desktop right inspector; Simple mode mapping; loudness-matched A/B preview. | Vitest `control-isolation.test.ts` + Playwright `control-isolation.spec.ts` & `audio-export-verify.spec.ts` (`playwright-a11y-responsive`, `unit`) | `docs/architecture.md`, `docs/tasks.md` | `open (acceptance not met; see recovery audit)` |
| `WASM-7` | **P1** | `ai-mastering` / `nextjs-ui` / `mobile-responsive` | In-house Deep Mastering (`MasteringScript` v1): 5 engineer profiles, section detection, AI-artifact analysis (`AI Repair`), and responsive 5-lane automation timeline | Go backend + WASM engine generates & applies schema-valid v1 `MasteringScript` across 5 profiles (`Warm Analog`, `Punchy Commercial`, `Dynamic & Open`, `Vocal Forward`, `Bass Heavy`) and UI aliases; staged progress; 5 automation lanes; mobile scrollable timeline with sticky lane labels; accessible text summary; `MoveEditor`. | Go `mastering_test.go` + Newman `TS-003` + Playwright Deep mode spec (`newman-e2e`, `unit`, `playwright-a11y-responsive`) | `docs/api.md`, `docs/architecture.md`, `docs/tasks.md` | `open (acceptance not met; see recovery audit)` |
| `WASM-8` | **P1** | `go-backend` / `nextjs-ui` / `mobile-responsive` | Smart Stem Splitter (`/split/[trackId]`) with exact `2–6` stem selector & "Send to mastering" | Exact `2`, `3`, `4`, `5`, `6` stem mappings; validated source separation; per-stem mute/solo/level/pan/rename reusing `SliderField` and `Toggle`; stem audio downloads (`/jobs/{id}/stems/{stem}`); handoff to mastering. | Newman `TS-002`, `TS-013` + Playwright Smart Split spec (`newman-e2e`, `playwright-a11y-responsive`) | `docs/api.md`, `docs/tasks.md` | `open (acceptance not met; see recovery audit)` |
| `WASM-9` | **P2** | `nextjs-ui` / `go-backend` / `mobile-responsive` | Albums (`/albums`, `/albums/[albumId]`), Reference Match (`/reference/[trackId]`), and Release Check (`/release-check/[trackId]`) | Album track ordering (Move Up/Down), batch normalization & consistency SVG chart; Reference Match dual-curve SVG overlay & spectral delta mapping; Release Check across Spotify, Apple Music, YouTube, SoundCloud, CD, and Podcast with compliance audits. | Playwright responsive & navigation journeys across all 9 routes (`playwright-a11y-responsive`) | `docs/api.md`, `docs/tasks.md` | `open (acceptance not met; see recovery audit)` |
| `WASM-10` | **P1** | `git-ci` / `qa-newman` | Unified GitHub Actions CI/CD pipeline (`ci-cd` gate) | Unconditional execution of all quality gates in `.github/workflows/ci.yml`: repo/agent hygiene, Go/WASM quality gate, Next.js/TS frontend quality, Newman PR suite (`TS-001`..`TS-015`) + raw curl probes, and Playwright a11y/responsive checks. | `.github/workflows/ci.yml` unconditional configuration (`compiled-binary-smoke`) | `README.md`, `docs/architecture.md` | `open (acceptance not met; see recovery audit)` |

---

## Recovery backlog — current session

The corrective subset passed current-session QA and Devil’s Advocate review and is open — awaiting merge. Rows distinguish repaired behavior from full feature requirements that remain open; removal of simulated outcomes is not delivery of analysis, automation or separation.

| ID | Priority | Required recovery | Status |
|---|---|---|---|
| R-01 | P1 | Integrated local startup with Go APIs and isolation headers | open — awaiting merge (integrated local startup locally verified) |
| R-02 | P1 | Repeatable binary build with a read-only previous runtime | open — awaiting merge (repeat builds/runtime replacement and empty-directory smoke passed) |
| R-03 | P1 | First apply uses current settings, preview/export agree | open — awaiting merge (immutable apply, source readiness and preview/export PCM passed) |
| R-04 | P1 | Source-derived Deep analysis; remove invented findings meanwhile | open — invented findings removed; static profiles locally verified, source-derived analysis not delivered |
| R-05 | P1 | Shared sample-timed automation and effective repair | open — misleading timeline removed; shared operational automation and repair not delivered |
| R-06 | P1 | Validated stem audio, controls, downloads and handoff | open — fabricated stem completion removed; validated separation and handoff not delivered |
| R-07 | P1 | Measured album processing and actual output | open — awaiting merge (bounded actual album WAV subset verified; wider consistency/batch scope open) |
| R-08 | P1 | Measured reference matching and effective protection controls | open — EQ-settings blend and protection controls verified; measured spectral matching not delivered |
| R-09 | P1 | Measured, correctly labeled release diagnostics | open — awaiting merge (actual rendered diagnostics and JSON verified; certification not claimed) |
| R-10 | P1 | Stable A/B trim, seek and playback continuity | open — awaiting merge (RMS trim, playhead and playback continuity verified) |
| R-11 | P1 | Independent move edits when real automation is delivered | open — stale simulated editor removed; real automation editing not delivered |
| R-12 | P1 | Every enabled audio setting maps independently to sample output | open — awaiting merge (42 native control pairs, 267 parity fixtures, 31 real UI/export pairs verified) |
| R-13 | P1 | Bounded full-song input capacity and visible current limits | open — finite 3/5-minute native capacity verified; general high-rate/browser memory and longer capacity open |
| R-14 | P1 | Complete canonical component/CSS migration | open — awaiting merge (active route styles and responsive generated states verified) |
| R-15 | P1 | Honest synchronized docs; no demo production state; output-based tests | open — awaiting merge (honest docs, empty production state and output-based tests synchronized) |
| R-16 | P2 | Figma identity, metric hierarchy and responsive controls | open — awaiting merge (identity, metric hierarchy, target geometry and hero sizing verified) |
| R-17 | P0 | Patched Go native/WASM/CI toolchain; green vulnerability gate | open — awaiting merge (Go 1.26.10 and vulnerability gate verified) |

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

## Historical iteration 1 record

The original implementation commit history is retained in git (`8470405`, `f565ab3`, `3049756`, `421acca`, `41386c8`, `587731f`, `3875075`, `5e07560`). Earlier prose claiming complete vertical slices and calibrated processing was inaccurate and is superseded above. No historical test result is promoted to current-session evidence.

## Historical corrective loop — 2026-10-21

This earlier corrective session used its own iteration counter (maximum 10), separate from the historical iteration 1 above. Rulings are sequential review/implementation waves; specialist work can overlap. Go/static integration evidence is at `24137c4`; the final browser/frontend/build checkpoint is `c3c15c9`. The session stopped at its maximum 10 iterations with corrective changes verified locally and the full product scope still open.

| Session iteration | Ruling / work | Current evidence and remaining action |
|---|---|---|
| 1 | Establish pessimistic baseline and inspect checkout | Local main lacked the implementation; no scaffold was mistaken for the user's feature branch. |
| 2 | Discover/fetch the user branch and audit actual behavior | Continued from `9880481`; identified synthetic export, raw playback and unsupported workflows. |
| 3 | Establish DSP boundaries and shared WASM behavior | Strict parameter/safety and real compiled WASM/native parity fixtures; hardware/true-peak promises withdrawn. |
| 4 | Restore uploaded source preview and export | Advanced workflow uses actual canonical source, offline WASM preview and native export; unsupported workflows show unavailable states. |
| 5 | Harden parser, server and resource admission | Strict WAV/AIFF parsing, frame/request/concurrency/job limits, local authority checks and artifact cleanup. |
| 6 | Verify packaging and toolchain | Fresh binary build and empty-directory embedded-asset smoke passed before final integration; Go patch and local font packaging updated. |
| 7 | Strengthen QA and execute strict gates | 11 Vitest tests passed. First 14-case browser run: 6 passed, 8 failed (six axe search-input size cases, modal focus, uploaded-audio timeout); failures drive follow-up fixes. |
| 8 | Correct metering and automation | Gated loudness and finite-FIR peak measurement passed 15 independent FFmpeg comparisons; native automation gained validated envelopes and cancellation without hidden target gain. Limiter/AI/hardware boundaries remain explicit. |
| 9 | Browser/accessibility fixes and revalidation | Second 14-case browser run: 7 passed, 7 failed (six active A/B contrast cases and blob CSP). Fixes landed, alongside keyboard focus and float headroom regressions; final 14/14 browser rerun passed at `c3c15c9`. |
| 10 | Final integrated gates and blockers | Integrated `24137c4`: Go static/race gates, TypeScript/lint/knip, 13 Vitest tests, 15 compiled WASM parity fixtures, fresh binary build/smoke, agent sync, actionlint and cspell passed. Final API run passed 17 requests / 22 assertions plus raw 413/Host probes. A further browser run passed 11/14, revealing tablet navigation names; labels were fixed and the final run passed 14/14 at `c3c15c9` across six viewport sizes and eight routes. Final lint, fresh binary build and empty-directory smoke passed again. Vulnerability database access blocked. No verified completion, merge, release or green remote CI assertion. |

Preliminary evidence is also listed in [`docs/tasks.md`](../../docs/tasks.md). Final command outcomes and checkpoint SHAs are recorded in tasks above; the five owned documentation files passed cspell, local-link validation and diff whitespace checks before commit. QA accepted signed-zero normalization without weakening finite-sample checks; Devil's Advocate found no demonstrated corrective-PR blocker. No historical or preliminary result is promoted to a final passing gate.

The pending-preview track-switch concern was ruled out by code inspection: MasterView is keyed by resolved track ID, so changing tracks remounts it and unmount cleanup aborts pending rendering. This historical checkpoint retained unsupported processing workflows and a blocked vulnerability gate. The recovery record below supersedes its current-state claims; history is not final recovery evidence.


## Current recovery loop — four iterations

The user authorized corrective implementation after the baseline review. This recovery counter is separate from the earlier ten-iteration history. All broad `WASM-1`…`WASM-10` requirements remain open; disabled unsupported features do not satisfy their acceptance criteria.

| Iteration | Ruling and implemented subset | Evidence and remaining gate |
|---|---|---|
| 1 | Reproduce and rule on the 17 baseline findings; compare the corrected archive with canonical design assets | Baseline `ade7736` failures are preserved in the audit. Only `main` existed locally/remotely at review start. |
| 2 | Correct integrated startup/runtime replacement; patch Go; remove demo/simulated results; restore real Advanced/Simple processing, profiles, album WAV artifacts, reference settings blend and native release diagnostics | Atomic source changes integrated on `codex/war-room-product-audit`. AI analysis, real time automation, trained separation and spectral matching remain open. |
| 3 | Reuse Tailwind controls/dialogs/modules; restore Figma structures and responsive hero sizing; add high-pass, source-rate EQ, independent control and finite-capacity regressions | 267 native/WASM fixtures and 42 control pairs are the audio checkpoint scope. Simple mapping starts from neutral defaults; 36 genre/tone regressions prevent repeated Apply from compounding settings. Reference curves share logarithmic axes and retain measurement provenance. Representative 3/5-minute native requests and canonical round-trip passed; observed memory is not a universal or browser budget proof. |
| 4 | Final integrated static/native/browser/packaging/API/documentation review | Initial 12-pass/8-fail browser evidence exposed a real Simple solver defect and metric-strip keyboard-focus failures; deeper probes found 41.25 px targets and an early profile-Apply race. All gained fixes and regressions. Corrected source passed 69 unit tests, full Go race, 267 fresh native/WASM fixtures, static/build/smoke gates, final 27-case browser suite (174.288 s), 31 UI control pairs/62 WAV exports, nine independent workflows, 30 generated axe/overflow views, hero/low-rate output probes and Newman 17-request/22-assertion coverage. Corrective subset locally verified and open — awaiting merge; owner approval and remote PR checks remain outstanding. Full failure history and precise checkpoint scope are retained in `docs/tasks.md`. |

See [`docs/tasks.md`](../../docs/tasks.md) for the finite capacity, per-control coverage and checkpoint evidence. The earlier failed/blocked attempts remain historical evidence and are not erased by later successful reruns.


### Remote CI hygiene follow-up

The [initial PR #2 CI run](https://github.com/yegamble/aurialis-WASM/actions/runs/39551701995) failed `scripts/sync-agents.py --check` because the generated plugin rule mirror retained Go 1.26.2 instead of canonical Go 1.26.10. Regeneration changes only that mirrored version line; the local synchronization check then exited 0 for all 11 agents. Application code is unchanged. The corrected remote rerun and owner merge remain pending, so PR #2 stays **open — awaiting merge**.
