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

[The baseline audit](../../docs/reviews/2026-10-21-war-room-audit.md) records 17 recovery findings. The earlier corrective subset on `codex/war-room-product-audit` was **locally verified — open, awaiting merge**: direct Go WASI playback, canonical settings, import/recovery, transport and responsive repairs passed the recorded gates, all 39 local browser cases, bounded five-minute actual-song output and six-job source CI at `e91d2f0`. The owner merged [PR #2](https://github.com/yegamble/aurialis-WASM/pull/2) on 2026-10-22 at 00:31:56 UTC, merge commit `30f576f9d2b7008240f57d62f691e2536c172be5`.

Broader trained separation, source-derived AI analysis, musical automation, spectral matching, hardware/true-peak/platform certification and arbitrary-workload capacity remain open. The chronological entries below retain failures and pending statuses as they stood at each checkpoint; the final acceptance entry supersedes their current-status implications without erasing them. Original “Failed to fetch” causation remains unverified.

## Current expansion — Advanced mastering controls and preset calibration

**Status: locally verified — open, awaiting merge (`codex/advanced-mastering-controls`).** The owner requested audio-engineer and DSP-plugin-engineer implementation informed by public Waves documentation. Prior corrective PR #2 was independently owner-merged; this new scope requires a new PR, remote CI and merge. Earlier accepted runtime evidence remains historical.

DECISION: ACCEPT the bounded local implementation of original processing controls and conservative Simple recipes; remote CI and merge remain pending.

WHY: Makeup/knee/detector and stereo crossover were hidden or fixed; mid/side gain, adaptive release, dynamic de-harsh, three-band dynamics and named coloration now have shared DSP and UI wiring. Simple genres remain starting points, not proprietary Waves recipes or source-adaptive mastering.

AFFECTED LAYER: wasm-dsp, go-backend, nextjs-ui, qa, docs.

USER / AUDIO IMPACT: Canonical state and idempotent shortcuts retain explicit control. Legacy sessions preserve old character choices and new stages default off. Clean is identity; manual Release is inactive during automatic recovery, and retained values return when their modes change.

DISSENT / LIMITS: De-Harsh overshoot and large saturation drive-change transients were reproduced and corrected through Q normalization and antiderivative-history rebasing, with tests of those cases. First-order complementary multiband is not linear-phase or steep band isolation. Named coloration is not a hardware clone or alias-free guarantee. Zero runtime counters and fixture parity do not certify all host scheduling, signals or transitions.

CURRENT EVIDENCE: Stable binary `dce7b7f8513a2fe0d272059727b4a97fb43346e7745021e31efc40b84b6abb69`; 183 units, final TypeScript/lint/knip, 121-file zero-issue spelling, Go vet/race and full native/JS/WASI quality/security gates passed. All 333 native/offline/direct/live fixtures matched exactly. Stable build, empty-directory binary smoke, Newman 17 requests/22 assertions and raw curl probes passed. Final Chromium **42/42 in 2.2 minutes**, including the **62-control export matrix in 31.7 seconds**, passed. Isolated Brave **3/3 actual-output checks in 17.9 seconds** passed. These are unit, wasm-bridge, api-curl, newman-e2e, playwright-a11y-responsive and compiled-binary-smoke evidence at the documented scope.

RETAINED FAILURES: First parity attempt raced a mid/side source change and passed after a stable rebuild. Threshold and Tape/Tape Warmth strict-selector ambiguities were corrected; the preceding full suite was 41/42 (62 exports passed in 43.2 seconds), then exact-selector targeted checks and final 42/42 passed. Earlier simultaneous Brave imports failed 2/3 with server busy/admission responses; isolated rerun passed. None of these observations erases the actual DSP defects corrected above or certifies arbitrary workloads.

The [research contract](../../docs/mastering-controls-research.md) and [task evidence](../../docs/tasks.md) record sources, values and limitations. Documentation sync is complete for this local checkpoint; remote CI and owner-authorized merge remain required.

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
| `WASM-2` | **P0** | `nextjs-ui` / `a11y-hcl` / `mobile-responsive` | Warm editorial HCL/OKLCH design system tokens, custom inline SVG `<Icon />` primitive (zero icon libraries), and mobile-first responsive `AppShell` | `src/app/globals.css` defines HCL/OKLCH-calibrated warm paper/ink/clay/moss/ochre tokens; zero external icon libraries; mobile (`320px–390px`) renders top bar + 4-item bottom nav + sticky mini-transport; desktop renders left rail + canvas + right inspector; all touch targets `>=44×44px`; WCAG 2.2 AA contrast verified. | `pnpm run lint`, `vitest` (Icon test), Playwright `320px`/`375px`/`768px`/`1024px`/`1440px` + axe WCAG 2.2 AA (`playwright-a11y-responsive`) | `docs/architecture.md`, `docs/tasks.md` | `open — awaiting merge (corrective subset locally verified; broad requirements tracked separately)` |
| `WASM-3` | **P0** | `wasm-dsp` / `audio-verify` | Waves-grade Go/WASM DSP core (`wasm/dsp`) + `AudioWorklet` / `SharedArrayBuffer` lock-free bridge + War-Room Audio Transformation Verification Suite | Compiles `public/wasm/aurialis-dsp.wasm` implementing ZDF/TPT 5-band parametric EQ, program-dependent optical/FET/VCA compressor with 90 Hz sidechain HPF, 4× oversampled True-Peak limiter, ADAA tube/tape/transformer saturation, Linkwitz-Riley mono-bass + M/S width, and TPDF dither. Audio verification suite confirms physical accuracy. | `go test -race -v ./wasm/... ./internal/audio/...`, `orthogonality_test.go` (`wasm-bridge`, `unit`) | `docs/architecture.md`, `README.md`, `docs/tasks.md` | `open (acceptance not met; see recovery audit)` |
| `WASM-4` | **P1** | `go-backend` / `security` / `qa-newman` | Concurrent job engine (`internal/jobs`) + Audio Content Disarm & Reconstruction (CDR) & host-machine upload security (`aurialis-security`) | Bounded worker pool with `context.Context` cancellation; Audio CDR strips all non-audio chunks/trailers and rejects polyglots (`MZ`, `ELF`, Mach-O, `PK\x03\x04`, `%PDF`); zero user-filename disk writes (in-memory Float32 PCM buffers); `413` size cap; CRLF/path-traversal sanitization; `Host` & `Origin` DNS-rebinding/CSRF defense; `DELETE /jobs/{id}` idempotency. | `go test -race ./internal/...`, Newman `TS-001`…`TS-015` + raw `curl` 413 & DNS-rebinding probes (`newman-e2e`, `api-curl`) | `docs/api.md`, `docs/architecture.md`, `docs/tasks.md` | `open (acceptance not met; see recovery audit)` |
| `WASM-5` | **P1** | `nextjs-ui` / `mobile-responsive` | Upload/Home (`/`) & persisted IndexedDB Library (`/library`) with reusable primitives | Click, drag/drop, keyboard, and paste upload; media metadata validation; IndexedDB `projects` + `audio` Blob stores with fallback warning; mobile card view + desktop editorial table reusing `Button`, `StatusBadge`, `DropZone`, `Modal`. | Vitest + Playwright upload/library persistence & responsive specs (`playwright-a11y-responsive`) | `README.md`, `docs/tasks.md` | `open (acceptance not met; see recovery audit)` |
| `WASM-6` | **P1** | `wasm-dsp` / `nextjs-ui` / `mobile-responsive` | Mastering Workspace (`/master/[trackId]`): Transport, custom SVG Waveform, Simple mode, Advanced 5-band EQ/DSP mode, and WAV export (16/24/32-bit + TPDF dither) | Draggable 5-band SVG EQ with accessible numeric inputs and text summary; reducer control isolation (`src/lib/store.tsx`); shared Go DSP processing and 16/24-bit dithered PCM or 32-bit float WAV export; mobile accordions vs desktop right inspector; Simple mode mapping; loudness-matched A/B preview. | Vitest `control-isolation.test.ts` + Playwright `control-isolation.spec.ts` & `audio-export-verify.spec.ts` (`playwright-a11y-responsive`, `unit`) | `docs/architecture.md`, `docs/tasks.md` | `open — awaiting merge (corrective subset locally verified; broad requirements tracked separately)` |
| `WASM-7` | **P1** | `ai-mastering` / `nextjs-ui` / `mobile-responsive` | In-house Deep Mastering (`MasteringScript` v1): 5 engineer profiles, section detection, AI-artifact analysis (`AI Repair`), and responsive 5-lane automation timeline | Go backend + WASM engine generates & applies schema-valid v1 `MasteringScript` across 5 profiles (`Warm Analog`, `Punchy Commercial`, `Dynamic & Open`, `Vocal Forward`, `Bass Heavy`) and UI aliases; staged progress; 5 automation lanes; mobile scrollable timeline with sticky lane labels; accessible text summary; `MoveEditor`. | Go `mastering_test.go` + Newman `TS-003` + Playwright Deep mode spec (`newman-e2e`, `unit`, `playwright-a11y-responsive`) | `docs/api.md`, `docs/architecture.md`, `docs/tasks.md` | `open (acceptance not met; see recovery audit)` |
| `WASM-8` | **P1** | `go-backend` / `nextjs-ui` / `mobile-responsive` | Smart Stem Splitter (`/split/[trackId]`) with exact `2–6` stem selector & "Send to mastering" | Exact `2`, `3`, `4`, `5`, `6` stem mappings; validated source separation; per-stem mute/solo/level/pan/rename reusing `SliderField` and `Toggle`; stem audio downloads (`/jobs/{id}/stems/{stem}`); handoff to mastering. | Newman `TS-002`, `TS-013` + Playwright Smart Split spec (`newman-e2e`, `playwright-a11y-responsive`) | `docs/api.md`, `docs/tasks.md` | `open (acceptance not met; see recovery audit)` |
| `WASM-9` | **P2** | `nextjs-ui` / `go-backend` / `mobile-responsive` | Albums (`/albums`, `/albums/[albumId]`), Reference Match (`/reference/[trackId]`), and Release Check (`/release-check/[trackId]`) | Album track ordering (Move Up/Down), batch normalization & consistency SVG chart; Reference Match dual-curve SVG overlay & spectral delta mapping; Release Check across Spotify, Apple Music, YouTube, SoundCloud, CD, and Podcast with compliance audits. | Playwright responsive & navigation journeys across all 9 routes (`playwright-a11y-responsive`) | `docs/api.md`, `docs/tasks.md` | `open (acceptance not met; see recovery audit)` |
| `WASM-10` | **P1** | `git-ci` / `qa-newman` | Unified GitHub Actions CI/CD pipeline (`ci-cd` gate) | Unconditional execution of all quality gates in `.github/workflows/ci.yml`: repo/agent hygiene, Go/WASM quality gate, Next.js/TS frontend quality, Newman PR suite (`TS-001`..`TS-015`) + raw curl probes, and Playwright a11y/responsive checks. | `.github/workflows/ci.yml` unconditional configuration (`compiled-binary-smoke`) | `README.md`, `docs/architecture.md` | `open — awaiting merge (remote source CI passed at e91d2f0; live PR checks show newer commit status)` |

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
| R-10 | P1 | Current transport: A Processed default, B Original, shared clock, no Match level | open — awaiting merge (39-case suite, independent WASI output and pending-init fixes locally verified; owner approval absent) |
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


## Earlier corrective loop — four iterations

The user authorized corrective implementation after the baseline review. This recovery counter is separate from the earlier ten-iteration history. All broad `WASM-1`…`WASM-10` requirements remain open; disabled unsupported features do not satisfy their acceptance criteria.

| Iteration | Ruling and implemented subset | Evidence and remaining gate |
|---|---|---|
| 1 | Reproduce and rule on the 17 baseline findings; compare the corrected archive with canonical design assets | Baseline `ade7736` failures are preserved in the audit. Only `main` existed locally/remotely at review start. |
| 2 | Correct integrated startup/runtime replacement; patch Go; remove demo/simulated results; restore real Advanced/Simple processing, profiles, album WAV artifacts, reference settings blend and native release diagnostics | Atomic source changes integrated on `codex/war-room-product-audit`. AI analysis, real time automation, trained separation and spectral matching remain open. |
| 3 | Reuse Tailwind controls/dialogs/modules; restore Figma structures and responsive hero sizing; add high-pass, source-rate EQ, independent control and finite-capacity regressions | 267 native/WASM fixtures and 42 control pairs are the audio checkpoint scope. Simple mapping starts from neutral defaults; 36 genre/tone regressions prevent repeated Apply from compounding settings. Reference curves share logarithmic axes and retain measurement provenance. Representative 3/5-minute native requests and canonical round-trip passed; observed memory is not a universal or browser budget proof. |
| 4 | Final integrated static/native/browser/packaging/API/documentation review | Initial 12-pass/8-fail browser evidence exposed a real Simple solver defect and metric-strip keyboard-focus failures; deeper probes found 41.25 px targets and an early profile-Apply race. All gained fixes and regressions. Corrected source passed 69 unit tests, full Go race, 267 fresh native/WASM fixtures, static/build/smoke gates, final 27-case browser suite (174.288 s), 31 UI control pairs/62 WAV exports, nine independent workflows, 30 generated axe/overflow views, hero/low-rate output probes and Newman 17-request/22-assertion coverage. Corrective subset locally verified and open — awaiting merge; remote CI passed at `40d2503`; owner approval remains outstanding and live PR checks show newer commit status. Full failure history and precise checkpoint scope are retained in `docs/tasks.md`. |

See [`docs/tasks.md`](../../docs/tasks.md) for the finite capacity, per-control coverage and checkpoint evidence. The earlier failed/blocked attempts remain historical evidence and are not erased by later successful reruns.


### Remote CI hygiene follow-up

The [initial PR #2 CI run](https://github.com/yegamble/aurialis-WASM/actions/runs/39551701995) failed `scripts/sync-agents.py --check` because the generated plugin rule mirror retained Go 1.26.2 instead of canonical Go 1.26.10. Regeneration changes only that mirrored version line; the local synchronization check then exited 0 for all 11 agents. Application code is unchanged. All six jobs in the [corrected remote run](https://github.com/yegamble/aurialis-WASM/actions/runs/39552061335) succeeded at `40d2503668a2379e4677562aed9f46448d53e585`. Remote CI passed at `40d2503`; [live PR checks](https://github.com/yegamble/aurialis-WASM/pull/2/checks) show newer commit status. Owner merge and full-product delivery remain open, so PR #2 stays **open — awaiting merge**.


## Current live playback follow-up

The user’s updated contract supersedes the old A-original/B-processed labels and RMS Match level control. **A Processed** is now the default, **B Original** is the aligned dry path, and automatic gain matching is removed. Shared Go DSP runs in a worker behind a bounded SAB bridge; the worklet stays nonblocking. Approximately 80 ms aligned dry/wet buffering and an 8 ms transition retain one playback clock. Meters and the 4096-point L/R power-mean FFT describe audible output; the warm live spectrum is primary and the compact Advanced EQ remains an editable settings view.

Simple tone changes and static profiles update the live chain; explicit Simple Apply separately prepares measured target settings for export/offline preview. Strict cached canonical loading, contextual request/body errors, source retry and fresh graph ownership address recovery paths. Native export keeps the source rate; live device-rate resampling prevents a cross-rate sample-identity claim.

Runtime `0265eba`, frontend `4562a99` and configured-chain warm-up `602e239` are integrated. At the preceding live checkpoint, Go/static/race gates, TypeScript/lint/knip, 87-file spelling, 91 unit tests, fresh binary/smoke, 267 native/WASM fixtures and Newman 17-request/22-assertion checks all exited 0. The full 30-case Chromium suite passed, including actual live destination output, a fixture-bound under-250 ms parameter assertion, six axe/geometry widths, cached-return recovery, same-file import retry and 31-control/62-export PCM checks. Exact numeric UI latency was not retained by that list reporter; the 31 controls refer to offline exports, not 31 live captures.

Independent integrated Chromium/Brave checks passed all eight groups per browser with zero total observed underruns, preserving 79.979 ms/99.9984% of a final 80 ms tone tail. The separate controller harness passed 24 source/device/chain configurations after warm-up. Earlier CPU-contention failures (3/25) remain in history; passing serial fixtures do not certify arbitrary-host real-time performance. The independent app binary was VCS `602e239` with `modified=true`, SHA256 `8560804c7680682006d9027718043d94391ed544c3bb9cd1d5c8453ee473937f`, not a clean release assertion. Detailed coverage and limits are in `docs/tasks.md`.

### Round D — accepted live corrections

```text
DECISION: ACCEPT — generation reset, cold-start warm-up and source lifecycle repairs
WHY: A delayed duplicate generation reset could rewind active worker state. Idempotent reset guards and a VM regression address that race. Bounded configured-chain warm-up runs before source playback and resets its history; independent destination-output probes retained the delayed tail and observed zero total underruns in the recorded cases. Fresh graph disposal/retry and same-file import recovery now have actual browser coverage.
DISSENTING VIEW: QA limits zero-underrun and latency findings to measured fixtures under serial CPU conditions. Block-boundary parameter changes do not certify continuously smoothed controls or musical automation. The original fetch failure remains undiagnosed.
AFFECTED LAYER: wasm-dsp | nextjs-ui | mobile-responsive | a11y-hcl | qa-newman
USER / AUDIO IMPACT: A Processed is the default, B Original stays aligned, settings reach live shared DSP, and return navigation/retry restores playable output.
BUNDLE / TEST IMPACT: Reuses the Go core and shared controls; adds bounded worker/worklet state and actual destination-output/cancellation regressions rather than a second DSP implementation.
ACCEPTANCE CRITERIA: Current local signal/lifecycle/UI checks pass; no original-source substitution or fabricated meter state; unsupported AI/separation/automation promises remain open. The elapsed-label follow-up and next remote CI checkpoint still need their recorded outcomes before integration closure.
TEST PLAN: Full 30-case Chromium suite; independent eight-group Chromium/Brave output probes; 24 controller rate/chain configurations; native/WASM parity, static/race/API/packaging gates; final focused elapsed-label build and additional Brave durable run.
DOCS TO UPDATE: README.md, docs/api.md, docs/architecture.md, docs/tasks.md, .claude/war-room/ledger.md
```

That 30-case checkpoint predates the elapsed-floor, expanded transport/import and canonical-settings follow-ups. Later proof is recorded below; it does not retroactively change the executing artifact of earlier tests.

The original “Failed to fetch” cause remains **UNVERIFIED** despite successful fresh POST probes. Do not label the contextual error or cache changes as a proven diagnosis. The broader AI/separation/automation/certification backlog remains open. PR #2 is **open — awaiting merge**, with owner approval and the final UI-only/Brave/remote-CI follow-ups still required.


### Expanded follow-up — transport, repeat, import

The user’s spectrum/transport polish scope extends beyond the preceding live checkpoint. Implemented changes include animation-frame transitions between measured 20 Hz FFT traces, a reserved status row, responsive full-width transport, canonical slider/EQ resets, restart-at-zero, queue-aware Next (otherwise a ten-second forward seek), cancellable hold scrubbing, repeat at the audible source boundary, and current-player keyboard/Media Session ownership. Holding is distinct from tapping; playback resumes according to prior intent and stays stopped at the end without repeat. Subsequent independent repeat/hold/media/reset and focus/EQ/Next probes passed in both browsers; the newer canonical-target/full-suite outcome remains pending. Visual interpolation is not a higher FFT measurement rate or fabricated audio data.

Import now performs one bypass/32-bit POST, returning canonical PCM and the shared source measurement schema in an at-most-4096-byte `X-Aurialis-Source-Metrics` header. Exact Content-Length and client header/byte/rate/frame checks guard transfer consistency; native CDR, request/frame caps and timeouts are unchanged. The bypass path reuses one native measurement and decoded PCM. UI phases distinguish validation/reconstruction, waveform preparation and saving, with cancellation guards. Malformed-header response cancellation has focused coverage; actual processing/transfer cancellation and retry outcomes are recorded below.

The earlier five-user-WAV Brave baseline (approximately 35–47 MB each) passed in observed 17–36.5 s with peak native RSS 676 MiB. It predates this import optimization and does not prove improved speed, a universal memory cap or the original fetch failure’s cause. A preceding expanded unit checkpoint passed 113 cases and a later focused import run passed 40; neither is the final whole-scope gate. Build exited 0 for VCS `2612478` with dirty source including `cf99cfb`, binary SHA256 `8215f318bc8ed82f4068cd03516918a58c2680a0899e71a5b2b18fe88714a5d5`. This is an earlier integration artifact, not a clean release; later independent QA is recorded below.

**Ruling:** retain the preceding accepted live corrections and their bounded evidence; require fresh results for the expanded behavior before accepting its integration. Current runtime, full local gates and the next pushed CI are pending. The fetch cause remains **UNVERIFIED**. PR #2 remains draft and **open — awaiting merge**; owner approval and the broader product backlog remain outstanding.


### Current import evidence; shared Simple/Advanced correction pending

The new one-POST import passed five actual approximately 35–47 MB user-WAV Brave probes: 13.027 / 10.309 / 10.952 / 10.274 / 11.123 s, each one 200 response. Headers were 798–805 bytes and exact canonical bodies approximately 76–95 MB; first/last 256 converted frames matched the stored source. Cached reload produced destination PCM without another audio API request. Processing Cancel restored UI/admission in 246 ms; transfer Cancel yielded browser `ERR_ABORTED`, server broken pipe and admission release in 32 ms after an in-flight competitor received 503. The stream observer timed out after three seconds, so a clean stream-close observation is not claimed. Retry completed in 13.203 s with playable output. Observed native RSS was 340,803,584 bytes (about 325 MiB). These runs and the earlier 17–36.5 s/676 MiB baseline are not controlled speed or matched-memory comparisons. The original fetch failure remains **UNVERIFIED**.

Go 1.26.10 toolchain/format/modules/vet/lint/identifier/vulnerability/race/WASM gates all exited 0. A later frontend/build checkpoint passed strict TypeScript, lint, knip, 98-file spelling, 122 unit cases and build (SHA256 prefix `44642d22`, VCS `f70` with dirty source). This predates a later guard and the new shared-settings correction; it cannot verify them.

**Implemented canonical contract; final whole-suite proof pending:** Simple and Advanced edit one canonical chain. View changes preserve audio; genre/tone/intensity updates write that chain; custom Advanced edits mark Simple direction custom and clear misleading selections. Target-only updates retain unrelated settings. **Set target loudness** explicitly normalizes the current chain; exports use it independently of mode. Optional `Track.simpleCustom` records that state. Actual LUFS/ceiling values determine the named/Custom target selection; explicit direction changes preserve those canonical values. Existing Apply/export evidence remains historical for its tested checkpoint. Independent focus/EQ/visual evidence is recorded below; final whole-integration browser count, pushed CI and owner approval remain outstanding; PR #2 is **open — awaiting merge**.


### Latest local verification — canonical chain and startup guard

Canonical settings (`c4ee9fc`/`f101708`) and target truth (`ab111bb`) now preserve one chain across views. Explicit **Set target loudness** measures that current chain and commits input gain only if the snapshot is still current. Target-only changes preserve unrelated controls; named/Custom target selection follows actual limiter LUFS and ceiling. Dense waveform rendering (`c5172f3`) derives from 2048 actual peak buckets. The dormant worklet (`53bc`) remains inactive until reset, retaining active-generation missing-block failures and existing counters.

Current Go gates, 267 native/WASM fixtures, Newman 17 requests/22 assertions and raw security probes exited 0. Strict TS/lint/knip passed; a spelling failure on a new test identifier was corrected in `4ee79ce`. The rerun checked 101 files, passed 134 unit cases and exited 0 for build/standalone smoke. Latest integration binary SHA256 is `f32fe2231f13d9c5e10a11a97f74c3dde533aa00ac7b4e44f732933d1c8d40e9`, VCS `4ee79ce9b4394319a50c1350bc690d1a218584d8`, dirty source. Actual canonical-target normalization passed in Chromium (19.832 s) and Brave (12.666 s): two actual native 200 responses each, −12 LUFS target/−0.7 dBFS ceiling, input 0→4.014246984 dB, measured output −16.014246984→−12.00000000004 LUFS, sample peak −9.965944 dBFS, other settings unchanged. The complete durable suite has unresolved failures.

Independent Chromium/Brave checks passed Next/focus/EQ corrections, transport hold/repeat/media/reset and six-width controls on binary `44642d22c6482096f5124ae04e538be4ab24ab397fd162cbf852c170a0b6eec7` (VCS `f70cd9066e3fbdd7ee8f07be3bb379944ec98cad`, dirty). Later canonical/waveform/startup checks used `c9e8fd35928d2a8cd2cae644c2083f9b385c5b8302f51e845ad1fb4648f5365f` (`53bc`, dirty), preceding final target-dropdown repair. Four mode/output groups per browser passed exact settings/version/graph and 0.12 dB assertions; the fifth preset baseline failed and is retained. A narrow settling diagnostic observed approximately 0.14 dB drift before any mode change, then passed unchanged assertions after settling. Durable setup now waits two seconds; no tolerance was relaxed.

Both browsers passed waveform geometry at all six widths (102/124/130/247/201/299 bars, 1.500–1.516 px wide, 1 px gap, overflow 0). Visual spectrum cadence was approximately 60 Hz, underlying analyzer approximately 17–18 Hz and reduced-motion cadence approximately 17.5 Hz, measured over two 1.2 s windows (about 2.6 s playback total). All sampled total underrun counters were zero. Controlled delayed startup kept pre-reset queue/applied counters at zero and source-start/final underrun counters zero; onset/zero-run checks remain bounded by ScriptProcessor capture timing. Earlier 11-Brave/5-Chromium counter failures remain **unclassified**; the guard proves idle queue inactivity, not the cause of those events or safety under arbitrary CPU starvation. Original fetch cause also remains **UNVERIFIED**.

**Round D/E scope:** retain accepted live corrections; the canonical settings and dormant guard are implemented with bounded independent evidence. Hold final integration acceptance: the 37-case durable run ended **34 passed / 3 failed in 8.2 minutes**, including two axe contrast failures (375/1024 px) and a real shared playback stall with Infinity/stopped source. Contrast was caused by foreground/background color interpolation (intermediate `#a9a4a0` on `#bf988a`, 1.05:1); transition removal `67c1930` awaits fresh validation. The stall is independently reproduced and is not the earlier preset-baseline settling issue. Actual-target normalization passed in both browsers. PR #2 remains draft and **open — awaiting merge**; no owner merge approval or full-product certification is claimed.


### Blocking shared-stall investigation

Independent instrumented throughput reproduction exited 1 in both browsers on `f32fe223…`, at device rate 44.1 kHz (128-frame budget 2.90249 ms). Chromium stalled before manual settings; Brave stalled on entering Simple before any Rock/Clean update. Retained next-read input tags were valid, with no persistent generation/tag mismatch identified. Go-call p95 approached the quantum; occasional recorded calls reached 96 ms. This supports limited margin without establishing the stall’s cause: observer overhead, missing final telemetry batches and unrelated host scheduling remain limitations. No 30-second active Rock/Clean pass was achieved. The original uninstrumented failure remains separate blocking evidence; preset settling, Crisp and the original fetch cause are not proven explanations.

The bulk bridge is integrated as `b0b4250` (agent `4383c43`), diagnostics `048c76e`, preserving finite/type/frame/bounds/offset/input-snapshot/output-alias/shared-buffer/signed-zero semantics with an additional fixed 512 KiB scratch area. All Go/JavaScript-target gates and 267 expanded parity fixtures passed with maximum error 0. Typical benchmark calls improved but a 348.6 ms maximum outlier remains. The current binary is `3c268b6f846a50d0be93d7626255d370762f0a55c671b89864dacac6f91c299a`, VCS `048c76e1ee543584bbbf27bfb8d888856bb02e6e`, dirty. TypeScript/lint/knip, corrected 102-file spelling, 134 units, build and standalone smoke passed.

Actual sustained browser checks still **failed**. Instrumented Chromium stalled at 6.329 s/70 total underruns; Brave continued into the active stage but recorded 123. Unwrapped production-worker probes also exited 1: Chromium stopped at 33.5196 s/162 total, Brave at 35.8474 s/75. Both contexts closed, destination output became zero and the application reported a processing stall. Chromium READ paused approximately 122 ms with valid next-read tags, then remained 52–59 blocks behind after resuming. This rules out a persistent tag mismatch in that observed interval, without distinguishing computation from runtime/scheduler pauses. No production threshold, latency or counters were changed to hide failures.

**Ruling:** bulk transfer is implemented, not accepted as a stall cure. Canonical/contrast/full-suite reruns are deferred for exact coefficient caching and separately accepted lazy evaluation of a discarded Thick/Crisp saturation intermediate (Warm unchanged). Old-output parity, complete quality gates and fresh sustained/browser evidence are required. Causes of the original stall, prior intermittent counters and fetch report remain unproven. PR #2 remains **open — awaiting merge**.


### Direct-export candidate — integrated, acceptance pending

Root `c9929d3` integrates exact cache `6a5b328`, lazy unused Thick/Crisp intermediate `cbebfd5`, direct worker `759392d`, fixed Go exports `38cd394` and embedded-ABI gates. The predecessor cache/lazy binary `220829cd…` still exited 1: Chromium completed 30 seconds active Clean at zero total underruns, while Brave stalled at 4.0187 seconds/70 total with a closed graph and zero output. Valid tags and observer callback gaps did not establish a host-contention cause. Prior full-suite/bulk failures remain retained.

The current Go 1.26.10 interface exposes `aurialis_live_buffer` (four input/output channel addresses), `aurialis_live_process` (128 frames) and `aurialis_live_reset`. Channel buffers plus validated input scratch total 3 KiB. Typed views are bounded, aligned and checked so they do not overlap and refreshed after Go memory growth; shared Go Bridge/Engine, runtime, JSON controls and offline API remain. The approximately 80 ms lead, roughly 200 ms fatal threshold and counters are unchanged.

Native/offline/direct WASM exactly matched all 321 frozen pre-change fixtures (267 plus 54 corners); 48 helper expected-output fixtures passed. Native hot-path allocation was zero; a temporary actual-WASM probe reported zero Go allocations per direct block versus 26 on the callback path across 1000 warmed neutral/active blocks, then was removed. This is not a claim of zero browser/runtime allocations, hard real-time safety or a proven original cause.

Fourteen worker lifecycle cases and full TypeScript/lint/knip, 107-file spelling, 146 frontend units and build passed. Embedded smoke first failed a stale callback-marker assertion; replacing it with actual embedded WASM compilation/three-export/worker-ABI verification passed. Expanded offline/direct parity and Newman 17-request/22-assertion/raw security gates passed. Current independent QA artifact is binary SHA256 prefix `169bdf27`, VCS prefix `38cd394`, dirty source. Original-worker 30-second active playback passed in both browsers at 44.1 kHz with zero total underruns and actual destination RMS −19.315/−19.321 dBFS. The longer user-WAV run failed below; canonical/contrast and complete-suite results remain pending.

**Ruling:** direct worker is implemented, not accepted as a stall cure. Keep live sustained blocker, current full-suite, pushed CI and owner merge open. PR #2 remains draft and **open — awaiting merge**; full product/physical-hardware certification is not claimed.


### Longer direct-worker run — acceptance failed

Actual approximately 47 MB user-WAV Brave command exited 1 at about 180 seconds with 39 total underruns (approximately 113 ms aggregate missing quanta). Output remained finite/audible and no fatal stop occurred. First 171 windows through 179.151 seconds had zero counters; onset showed READ 62094 paused about 73 ms with valid next input tag and WAKE 1. The pre-screenshot state already contained 39, so screenshot capture is not established as the cause. The five-minute zero-underrun target was **not achieved** and the planned 210-second mobile capture was not reached.

**Ruling:** reject sustained acceptance for this artifact; preserve the two-browser 30-second passes as bounded evidence only. Runtime diagnosis/new-candidate proof and the complete 37-case suite remain pending. Buffering, fatal threshold and counters remain unchanged; no original-stall/fetch cause is proven. PR #2 remains **open — awaiting merge**.


### Scheduling candidate ruling — acceptance still blocked

Focused canonical/contrast checks on immutable `169bdf27…` passed in both browsers: strict unchanged 0.12 dB tolerance, exact modes/versions/graph and preview freshness, zero misses in those windows and eight axe checks. Keep that UI proof distinct from the longer 39-underrun user-song failure. The full 37-case suite is ongoing with transient Master overflow at 375 px awaiting designer diagnosis.

**Round D ruling:** implement worklet WRITE notification and a worker `Atomics.wait` wake lease with a cooperative 20 ms budget and 64-block limit, yielding regularly for JSON controls. The time budget is checked between Go calls, so an individual call can exceed it; this is not a hard latency bound. Idle bootstrap uses MessagePort; paused/idle must not retain a perpetual timer. Keep the Go DSP, approximately 80 ms alignment, roughly 200 ms fatal policy and total counters unchanged. This is a focused scheduling candidate, not a proven cause or accepted cure. Fresh sustained and full-suite outcomes are required; PR #2 remains **open — awaiting merge**.


### Full-suite outcome and contained-waveform follow-up

Immutable direct-worker `169bdf27…` full37 exited 1: **35 passed / 2 failed, 5.6 minutes**. The prior contrast/shared-settings failures passed; current failures were transient 375 px Master overflow and global 90-second large-file timeout after reload. This does not prove a separate 30-second readiness failure or a timeout cause.

Source diagnosis traced waveform overflow to its pre-measurement bar row without containment, missing Figma’s decorative `.wave-bars` clipping. `f03ebe9` adds local width containment/clipping while retaining the seek target/keyboard controls. Focused lint/spelling/diff checks passed without assertion/time changes; fresh runtime proof is pending.

A focused large-import rerun passed unchanged 90/60/30-second budgets in 42.237 s (36.625 s body): one 200 POST with 76,800,044-byte response, no second POST/errors/crashes; HTTP 5.99 s, upload/transfer 7.992 s, import navigation 18.551 s, initial ready 83 ms, reload navigation 661 ms, URL wait 3.845 s, reload ready 17 ms, IndexedDB/Blob reads 55/54 ms. Preserve the full-suite timeout as unclassified; the rerun is not evidence of its fix.

Scheduling `b236bf7` and waveform `f03ebe9` are pushed to draft PR #2. Scheduling’s 26 focused cases passed. New full static/unit/build, sustained five-minute, complete browser-suite and remote CI outcomes remain pending; owner approval and merge are absent. PR #2 stays **open — awaiting merge**.


### Worker continuation and exact CI lint follow-up

Current worker continuation `1e8e450` uses MessageChannel with ownership tickets rather than the preceding timer continuation. Queued stale tickets are ignored; disposal closes the ports; paused/idle state has no continuing wake task. The cooperative 20 ms budget and 64-block limit remain, checked between Go calls; a single Go call can overrun the budget. These are scheduling bounds, not a hard audio-latency guarantee. Fresh sustained/browser acceptance remains pending.

Exact CI golangci-lint v2.15.0 initially found two taint-rule failures absent from the older local default. Correction `1a7b1b5` logs interrupted audio responses as fixed event text only (`audio response interrupted`), removing raw transport errors and request-derived fields. An explicit operator-selected local baseline-fixture read has a narrowly justified G703 suppression alongside its existing G304 suppression; this is not an upload/request code path. Published v2.15.0 lint then exited 0 with zero issues; focused vet/race, stored 267+54 fixtures, formatting/spelling checks passed. HTTP/DSP/resource contracts are unchanged. Exact-HEAD remote CI remains pending.


### Current packaging / waveform verification

Binary SHA256 prefix `bb0f8798`: 156 unit cases in 14 files, build and empty-directory smoke passed; spelling checked 109 files including hidden paths with zero issues, and all 11 agents synchronized. No sustained/full-suite acceptance follows from these prerequisites.

Waveform before/after probe exited 0 on the current binary without audio playback: initial 512-bar 375 px document width changed from 563 px to 375 px; rapid 1440→320 resize with 299 preceding bars changed from 350 px to 320 px. Current rows fit at 309/254 px, with decorative overflow hidden and wrapper minimum width zero. This verifies `f03ebe9` against the reproduced geometry defect. Current isolated two-browser short/sustained and five-minute actual-song runs and the complete browser suite remain pending. PR #2 is **open — awaiting merge**.


### Current wake candidate rejected for strict live acceptance; CI green

Current binary `bb0f87989b9c51f3e7591631b1c42023cd5922efc90cfd9aede3da060caae1f1` / Go 1.26.10 / HEAD `1a7b1b5ccecf72137ffeedaf1e9242e87c6ea828` with dirty docs: strict original-worker command exited 1. Neutral/manual/Rock/Clean/views had zero misses, then active playback accumulated 15 Chromium and one Brave total misses at 44.1 kHz. Playback remained finite/audible without fatal stop. Valid next tags/WAKE 1 and later READ catch-up do not establish persistent lost wake or a proven computation/scheduling cause. Five-minute/background probes were not launched. Keep the earlier 39-miss song failure as separate history.

[Remote CI run 39588688393](https://github.com/yegamble/aurialis-WASM/actions/runs/39588688393) passed all six jobs at exact `1a7b1b5ccecf72137ffeedaf1e9242e87c6ea828`, including Playwright **37/37 in 1.9 minutes**, large-file case 9.8 s and overflow checks. Remote/UI pending status at this checkpoint is superseded by those results, not by strict-live acceptance. The live failure remains blocking.

**Ruling:** allow an isolated read-only WASI-reactor Go-DSP AudioWorklet feasibility probe and independent adversarial source review, with fixed numeric controls and no callback/wake crossing in the hot path. Architecture guidance motivates investigating a risk; it does not prove the current missed-block cause. No root application implementation or successful acceptance is claimed. PR #2 stays draft and **open — awaiting merge**; sustained acceptance and owner approval remain outstanding.


### Production WASI integration — implemented, packaged verification pending

Following isolated Chromium/Brave 30-second feasibility passes, production integration is authorized: Go `0645888` fixed 56-control facade, dual-build `d75b2b8`, frontend `3ff464d` and direct AudioWorklet/restricted host. The live kernel runs the same Go Bridge/Engine on the render thread; the former processing worker is removed. The existing legacy JS/WASM module remains for offline preview. Main-thread compilation precedes audible playback; a fresh reactor gets a positive clock seed/256-byte entropy packet. The host provides bounded initialization services only and rejects processing/control imports. Settings use a 464-byte shared packet (16-byte header/56 doubles) with one odd/even payload+version transaction, strict Go validation and no spinning/JSON/callback/wake crossing in the sample path.

Full Go/JS/WASI quality/security/race gates passed; actual frontend encoder→restricted host→compiled WASI matched all 321 frozen native fixtures exactly. Invalid controls preserve prior state/history. Native valid calls and an instrumented private WASI copy measured zero Go allocations across 10,000 control/process/reset/combined calls and zero processing host imports; the stats observer is not a production export. Cold initialization can allocate and these results do not certify all browser/runtime allocations or hard deadlines.

Prototype history: zero initialization clock caused confirmed Go fatal, corrected with positive seed. Brave per-sample `getChannelData` fixture overhead was corrected by caching two views; suspected teardown/privacy explanations were retracted. Final real-browser prototype commands exited 0 with actual gain/EQ/heavy output and normal teardown; coarse max 2/1 ms measurements are not quantum-deadline certification. These feasibility results do not supersede earlier production worker failures.

QA `98281ed` adds two WASI retry/cancellation cases, preserving the prior 37 contracts; 39 cases are enumerated and strict typing/spelling passed. The approximately 80 ms alignment, roughly 200 ms missing-output policy, transport, source resampling, generations/tags/APPLIED and cumulative counters remain. Without a worker boundary, zero queue counts cannot prove every render deadline; output-continuity/timestamps and coarse recording must be assessed separately. **Packaged 39-case and five-minute acceptance are not yet executed/pending**. PR #2 remains draft and **open — awaiting merge**.


### Packaged WASI checkpoint — bounded playback passed, final acceptance pending

Binary prefix `b3d71956` / source `a8267cd`: 162 units in 15 files, dual build, standalone smoke and 114-file hidden-path spelling passed. Actual packaged Chromium/Brave cold/manual/Rock/Clean/view transitions and 30-second active playback exited 0 at 44.1 kHz, finite/audible with zero retained counters. This is bounded signal/state evidence, not full long-output/deadline certification.

Five-minute actual-output recording remains pending. Blob recorder CSP rejection and a same-origin recorder 404 were observation-setup failures. A private localhost proxy adds the recorder module only, retaining original application/DSP bytes and CSP; no production policy weakening or runtime pass is claimed.

[CI 39594749277](https://github.com/yegamble/aurialis-WASM/actions/runs/39594749277) at `a8267cd` passed hygiene/Go-WASM/frontend/Newman, but browser execution was 37/39. The two new test failures came from a broad alert selector matching Next’s empty route announcer; actual retry/cancel contract failure was not established. Scoped selectors and a pending Media Session regression are in progress. Final 39-case/remote and long-output acceptance remain open; PR #2 is **open — awaiting merge**.


### Packaged WASI five-minute actual-song fixture — passed

Binary prefix `b3d71956`, private same-origin recorder proxy 3899→3848 with unchanged application/DSP/CSP bytes: actual approximately 47 MB/247.2-second Stand-In source repeated across its endpoint once. Command exited 0 after **301.06 seconds**, with nine gain/EQ/preset/A-B/mode/resize actions, 1440/375 screenshots, same graph/playing state, zero cumulative counters and 13,278,976 actual rendered frames. Recording retained all startup zeros (maximum 5049 samples/39 zero quanta); after first signal there were zero non-finite samples, raw/post-signal frame gaps or zero quanta.

The new observer’s earlier startup-gap assertion exited 1 and was classified as pre-first-signal graph construction, not silently waived; corrected raw-gap recording passed. Coarse Date.now maximum callback was 8 ms and is not a hard deadline or physical-device guarantee. Separate actual direct-port short runs passed in both Chromium/Brave; the long run is Brave-specific. Screenshots were visually reviewed for warm design/waveform detail.

**Round E scope:** accept this bounded recorded five-minute fixture, preserving all prior worker and observation failures. Current pending Media Session control correction/gates/build, corrected complete 39-case suite and exact-HEAD CI remain required. PR #2 remains **open — awaiting merge** with owner approval absent; no arbitrary-host, physical-hardware or full-product certification is claimed.


Separate Brave pending-init Media Session probe exited 1: pause during held WASI fetch was ignored, context remained running/loading after two seconds, and no source graph had started. Retain this actual control defect while its prepared fix proceeds through gates/build/actual-browser confirmation. The five-minute pass does not cover it. Two observed Brave 404 console messages have unclassified URLs; page errors were zero and output/source/reactor worked, which is not proof of zero resource failures. Corrected full39/exact-HEAD CI and owner merge remain open.


## Final corrective acceptance — source e91d2f0

Final artifact SHA256 `fa45eaa59a0c294b47d8794ba40280136ae207d5f74fc5220df8e78f47aace9e`, VCS `e91d2f0f9c1b40dadb416fbff69714daeeb31aef`, docs dirty. The latest pending-init correction `599098b` and alert-selector correction `e91d2f0` passed TypeScript/lint/knip and 164 units in 15 files, build and empty-directory dual-module smoke. Earlier unchanged-Go full quality/security/race/target gates, 321 frozen compiled fixtures and Newman 17-request/22-assertion/raw probes remain applicable at their recorded scope.

Fresh actual Brave Media Session/Space held-fetch pause/resume checks both exited 0: pause suspended and cleared loading, trusted replay resumed before fetch release, then one finite audible graph/error0/misses0. The original failed artifact remains in history. Local direct-port full suite **exited 0, 39/39 in 3.3 minutes**, including six-width axe/overflow/touch, 21-second >35 MB import/reopen, actual A/B/gain/EQ/FFT/meters, canonical modes, transport/handoff, cache/navigation, WASI 503 retry/cancellation and 31 independent GUI→native-export PCM effects. Those 31 exports are not 31 independent live captures.

The actual five-minute Brave song fixture passed 301.060 s/13,278,976 finite frames with repeat/actions/screenshots and all raw startup data retained. Its hot-path DSP/host/worklet source is unchanged in the final control-repair artifact; VCS metadata changes the compiled hash. Destination/render continuity does not certify physical speakers, arbitrary host scheduling or hard deadlines. Earlier observer failures and two URL-unclassified Brave 404s remain retained; the fresh short pending-init run had no page errors or captured HTTP errors.

All six source jobs in [remote CI 39597252997](https://github.com/yegamble/aurialis-WASM/actions/runs/39597252997) passed at exact `e91d2f0f9c1b40dadb416fbff69714daeeb31aef`. This is the recorded green source checkpoint; [live PR checks](https://github.com/yegamble/aurialis-WASM/pull/2/checks) show newer documentation-commit status.

Technical Writer final checks exited 0: repository spelling including hidden ledger/repo-map checked 114 files with zero issues, 48 local links resolve, and six-file diff whitespace checks are clean.

**Round E ruling:** the bounded corrective subset is locally verified and **open — awaiting merge**. Documentation is synchronized; owner approval and merge are absent. Keep broader AI/trained stems/automation/reference matching/album capacity/hardware and platform certification requirements open. Original fetch causation remains **UNVERIFIED**. No whole-product completion or merge is claimed.


## Starting-point activation feedback — 2026-10-22

DECISION: Derive Add Air, Cut Mud, Tape Warmth and Glue Comp highlights and accessible pressed states from their relevant canonical settings. Keep the existing idempotent apply behavior; do not add hidden toggle state or undo other module edits.
WHY: The controls applied settings but gave no persistent activation feedback. Independent matches may coexist, and relevant edits or bypass must clear a match. Source-rate-clamped EQ values must still match their starting point.
EVIDENCE: 186 unit tests; TypeScript, ESLint, knip and spelling; production build and standalone smoke passed. Five focused browser cases verified actual PCM changes, repeat idempotence, visible/accessible selection, keyboard, bypass/edit clearing, coexistence and persistence. Full Chromium suite passed 47/47 in 2.1 minutes. Devil’s Advocate review found no blocker. The first build inside the sandbox stalled; the permitted build rerun passed.
STATUS: open — awaiting merge.


## Reversible starting points and transport alignment — 2026-10-21

DECISION: Replace apply-only clicks with reversible per-shortcut toggles. Preserve unrelated controls and independent shortcuts, validate persisted restoration records, and clear stale ownership on preset/reset operations. Center the wide transport and simplify the skip icon.
EVIDENCE: 202 unit tests, frontend static gates, spelling, production build and standalone smoke passed; 13 focused browser cases passed. Full suite: 52/53 passed; the remaining 12 kHz fixture vanished at a 24 kHz device Nyquist frequency. Test-only correction to 7 kHz passed three repeated live runs. No full-suite repeat after that correction. Legacy mirror and identity issues found in initial unit checks were fixed.
STATUS: open — awaiting merge.
