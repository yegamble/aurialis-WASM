# Aurialis-WASM War-Room Ledger
<!-- cspell:words Embedder untimed -->

Source of truth for the **Aurialis-WASM** backlog across `/war-room` and `/war-room-loop` iterations. The Chair updates this file after every Round D ruling and every Round E verification pass. One row per item; never delete a row — move completed items to **Verified & Merged** with commit/PR and test evidence, or to **Declined** with the reason.

**Statuses**:
`open` · `in-progress (<branch>)` · `awaiting-tech-writer (<branch>)` · `open — awaiting merge (<branch/PR>)` · `implemented — open, awaiting merge (<branch/PR>)` · `verified (<commit/PR>, <evidence-tier>)` · `blocked (<prerequisite>)` · `declined (<reason>)`

**Evidence Tiers** (from `.claude/war-room/repo-map.md`):
`unit` · `wasm-bridge` · `api-curl` · `newman-e2e` · `playwright-a11y-responsive` · `compiled-binary-smoke`

---

## Whole-product loop — 2026-10-22, current session

**Status: bounded wave locally verified; open — awaiting merge. Product incomplete.** Baseline `f5ec9ad` is clean main, including merged PRs #3/#4/#5. MUB-0 is resolved; its earlier blocking ruling below is historical. The [whole-product review](../../docs/reviews/2026-10-22-war-room-completion.md) records surviving requirements and the supplied Gemini conversation’s stale claims.

Round A councils: DSP/audio/target audience; frontend/design/Devil’s Advocate; backend/security/QA. Round B challenges narrowed the compatibility claim to implemented algorithm 1 and required high-pass-specific control semantics and refined change-point localization. Round C accepted those revisions. Round D accepts isolated MUB-2A compatibility/capability foundation, MUB-3A measured features/neutral sections and MUB-4A supported EQ/limiter controls. Sonic v2, automation, trained stems, measured reference/album consistency and platform acceptance remain open. Existing passing gates cannot close them.

| Item | Decision | Current status |
| --- | --- | --- |
| MUB-0 | Prerequisite resolved by merged PR #3 | verified merge ancestor `97964fc` |
| MUB-2A | Implement version/capability foundation; advertise algorithm 1 only, latency 0/drain 0 | locally verified; open — awaiting merge (`codex/product-completion`) |
| MUB-3A | Implement bounded measured source features and neutral sections; no invented moves | locally verified; open — awaiting merge (`codex/product-completion`) |
| MUB-4A | Expose supported band enable/type and limiter release; prove live/export effects | locally verified; open — awaiting merge (`codex/product-completion`) |
| Whole product | Original full planned scope retained | open — acoustic and product requirements remain |

Final local acceptance: TypeScript/configured lint/knip, 302 units across 20 files, full Go format/module/vet/exact lint 2.15/identifier/vulnerability/race, both WASM target lints, 333 exact compiled fixtures (legacy and negotiated ABI 2), 15 FFmpeg meter comparisons, production build/empty-directory smoke, Newman 22 requests/27 assertions and raw probes passed. Final full Chromium suite exited 0: **61/61 in 3.1 minutes** on binary `8552941fc6e8b3d9b95fe2ecd378c539f3fe24b7fecf2521741fc1582b410171`, runtime source `fd782c9`; subsequent changes are tests/comments/docs. Final spelling checked 146 files, zero issues.

Retained failed checkpoints: noise bandwidth bias, 192 kHz low-band resolution, Hann impulse loss from windows without overlap, initial measured UI status mismatch (0/2), delayed held-admission cancellation, overlapping mobile targets, stale-copy full suite (60/61), and phase-sensitive Tape snapshot full suite (60/61). The coverage fix passed independent impulse/edge/extreme/DC probes; full-period live observations retained the >0.08 dB activation threshold and passed two predetermined shortcut sets (8/8), followed by the final 61/61 suite. Independent Cancel/retry/late-response cleanup completed with controls restored in 60 ms and the new result preserved. The review records exact scope and failures.

QA/Devil’s Advocate accepted the bounded corrections with no remaining in-scope must-fix; Technical Writer/Product Engineer accepted synchronized contracts and atomic commits, subject to recording final evidence. Four loop iterations are recorded; the default owner merge gate remains. Remote checks are tracked in the PR and must pass before owner merge. The whole product, sonic v2 and Waves equivalence remain open; no merge or all-product completion is claimed.

Remote checkpoint: [Remote PR run 39836685651](https://github.com/yegamble/aurialis-WASM/actions/runs/39836685651) passed every verification job except the browser job, which finished 60/61. Its measured-analysis case passed all diagnostics and six-width accessibility assertions, then failed writing a screenshot to macOS-only `/private/tmp` on Linux. The test now uses Playwright’s per-test output directory; no application code, assertion or threshold changed. Strict typing/spelling and the corrected two-case browser run passed (2/2 in 6.1 seconds). Corrected remote acceptance remains pending in PR checks; the earlier local 61/61 checkpoint is retained separately.

## Current ruling — 2026-10-21 product recovery

The latest whole-product review audited local and remote `main` at `ade7736` (the only live branch). The blanket verification claims in the historical activation record are withdrawn. The corrected design archive matches the canonical checked-in Figma source exactly.

[The baseline audit](../../docs/reviews/2026-10-21-war-room-audit.md) records 17 recovery findings. The earlier corrective subset on `codex/war-room-product-audit` was locally verified; **open — awaiting merge**: direct Go WASI playback, canonical settings, import/recovery, transport and responsive repairs passed the recorded gates, all 39 local browser cases, bounded five-minute actual-song output and six-job source CI at `e91d2f0`. The owner merged [PR #2](https://github.com/yegamble/aurialis-WASM/pull/2) on 2026-10-22 at 00:31:56 UTC, merge commit `30f576f9d2b7008240f57d62f691e2536c172be5`.

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

## War-room ruling — 2026-10-22 Mastering Upgrade Blueprint (`/war-room`, review only)

**Seats:** `aurialis-dsp-plugin-engineer`, `aurialis-backend`, `aurialis-frontend`, `aurialis-devils-advocate`, `aurialis-grammy-veteran` (read-only, lighter models per owner budget request). Rounds B/C were skipped under usage-budget rule 5 because no seat disputed another seat's BLOCKER or REQUIRED item. No application code was modified.

The Chair confirmed these blueprint claims are stale: the live ABI has 81 values (not 56), `compSlowDB` and `ironHP` are in use, and `AdvancedDynamics.tsx` already exposes knee, makeup, sidechain HPF, auto release, M/S, mono-bass frequency, De-Harsh and multiband. Prompt 1 is already fulfilled by [the upgrade spec](../../docs/design/waves-parity-and-hardware-emulation-spec.md) (`1539b6a`). That spec stays canonical, and the blueprint's equations and genre numbers are inputs to calibrate, not acceptance evidence.

```text
DECISION:            BLOCK (sequencing) — no new implementation branch until codex/advanced-mastering-controls is merged to main.
WHY:                 Finished-means-merged; new DSP/UI slices touch the same engine.go / AurialisWorkstation.tsx files (devils-advocate-1).
DISSENTING VIEW:     None.
```

| ID | Pri | Blueprint item | Decision | Acceptance / gate |
|---|---|---|---|---|
| `MUB-0` | P0 | Merge `codex/advanced-mastering-controls` | BLOCK prerequisite | Owner PR merge plus green remote CI; then branch per slice off `main`. |
| `MUB-1` | P1 | Prompt 1: spec | REJECT (duplicate) | Already committed. Tau unit clarified in §4 (seconds = ms × 1e-3). |
| `MUB-2A` | P1 | DSP foundation | ACCEPT (spec §7 step 1) | `AlgorithmVersion` (v1 default, v2 opt-in), versioned 82-value ABI handshake, `LatencyFrames()` plus drain, fixed delay buffers. v1 PCM bit-exact (max abs err 0) on all 333 fixtures; 0 allocs/op at block sizes 1/127/128/129/4096 and 8–192 kHz. |
| `MUB-2B` | P1 | Compressor topologies | MODIFY | v2 only; one topology per commit, Optical first (separate fast/slow states; long-burst recovery ≥2× slower than a 50 ms burst; steady-state error ≤0.1 dB). Generic labels only (Optical/Vari-Mu/VCA/FET), no hardware product names. |
| `MUB-2C` | P2 | Saturation oversampling and LR4 | MODIFY | Polyphase FIR with measured stop-band rejection ≥60 dB; separate tape/transformer state; LR4 all-pass applied to Mid *and* Side; branches −6.02 dB ±0.1 at crossover; phase ≤1°; width=0 null ≤1e-6. |
| `MUB-2D` | P1 | Lookahead limiter | MODIFY | 2 ms time-based lookahead (`ceil(fs*0.002)`, ≤384 frames), not 64 fixed samples. ≤ ceiling+0.05 dBTP verified against an independent oversampled oracle on final output. |
| `MUB-3A` | P1 | Analysis and segmentation | MODIFY (spec §7 step 5) | Standalone `AnalyzeFeatures`/neutral `Section 1..N` with confidence; aggregated Hann FFT frames (a 4096-point FFT ≠ a 1 s window); silence gives 1 section; step change localized ≤250 ms; band power ±0.5 dB on tones/noise. |
| `MUB-3B` | P1 | ScriptV2 render route and data-driven moves | ACCEPT (step 6) | Closed target allowlist; `script` mutually exclusive with `params`/`profile` (400); EQ proposals ±3 dB regularized fit; Newman cases added. |
| `MUB-3C` | P2 | Reference endpoint | DEFER (step 7) | Both WAV parts through CDR; joint memory reservation `(src+ref) frames` in `admitLocked`; amount=0 identity; protect-low within 0.25 dB. |
| `MUB-4A` | P1 | EQ band type, band enable, limiter release UI | ACCEPT (first UI slice after MUB-0) | DSP and live-control indices already carry them (`live-controls.ts:30,37`). Shared primitives, ≥44 px, six widths plus axe; each control must change exported *and* live PCM. |
| `MUB-4B` | P2 | Topology / true-peak / repair UI | DEFER | Exposed only after MUB-2B/2D and repair DSP pass, and after `browser-engine.ts:28-31,60` guards are removed with real behavior. |
| `MUB-4C` | P2 | Deep wiring, timeline, Reference view | DEFER | Gated on MUB-3A/3B/3C. |
| `MUB-4D` | P2 | Simple Precise/Organic/Elevated + Depth/Presence | MODIFY (calibration step 7) | Aurialis design, not Waves coefficients; zero intensity neutral; order-commutative; bounded per spec §6. |
| `MUB-4E` | — | Loudness-matched A/B toggle | DECLINED | Conflicts with recorded owner decision (spec §2). The owner may reopen this explicitly. |
| `MUB-5` | P2 | Genre matrix (blueprint §4) | MODIFY | Keep the conservative recipes in `docs/mastering-controls-research.md`. Blueprint values are candidates only. Section-move caps: ≤+0.8 dB EQ, ≤+8% width, ≤+0.5 dB drive delta; all profiles ≤ −1.0 dBTP (grammy-veteran-1). |

Recommended next command after MUB-0 merges: `/war-room-loop feature=wasm-dsp` (MUB-2A), with MUB-4A as a parallel non-overlapping frontend slice.

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


## CI live-audio baseline correction — 2026-10-21

Run 39711192709 passed every gate except the Add Air live test (52/53 browser cases). Its fixed theoretical RMS assertion expected -9.49 dBFS but the Linux speaker feed measured -10.098 dBFS. The test now measures B Original on the same device, verifies neutral A Processed matches within 0.1 dB, then retains independent activation changes and restoration within 0.1 dB. A bounded original level check still rejects silence or excessive gain. Application processing is unchanged.

Verification: full local Chromium suite **53/53 passed (2.3 minutes)**; TypeScript, repository lint and changed-test spelling passed. Direct ESLint invocation on the E2E file reported that E2E files are excluded; the configured repository lint passed afterward. Remote CI rerun pending. Status: **open — awaiting merge**.


## WASM DSP validation and transition follow-up — 2026-10-21

Scope: `/war-room-loop feature=wasm-dsp`, owner-gated merge. Work continues in isolated integration branch `codex/wasm-dsp-verification` based on current `main` merge `97964fc`; the shared checkout changed during review and was left untouched.

### Round D — DSP JSON array shape

DECISION: ACCEPT — P1 required correction.
WHY: QA reproduced an oversized `Bands` array bypassing the exact-key check while Go's case-insensitive struct decoder accepted it and truncated the extra band. Apply the existing shape checks to every accepted case variant, including multiband and nested band keys.
DISSENTING VIEW: Broad canonical-casing enforcement and duplicate-key parser changes were declined; they would change unrelated API behavior. Identical duplicate keys retain existing last-value semantics.
AFFECTED LAYER: wasm-dsp, go-backend.
USER / AUDIO IMPACT: Reject malformed settings instead of silently interpreting a truncated array; preserve active settings and bridge history after rejection.
BUNDLE / TEST IMPACT: No production dependency or browser bundle change; targeted Go boundary tests.
ACCEPTANCE CRITERIA: Every supplied EQ alias has five complete bands, every multiband alias has three complete dynamics bands, and malformed array shapes cannot be hidden by correctly shaped aliases. Numeric ranges are checked after final decoded alias resolution.
TEST PLAN: Focused count/completeness, alias and rejection-state tests; fresh Go/WASM, frontend, packaging, API and browser gates.
DOCS TO UPDATE: README, API, architecture, tasks and this ledger.

### Round D — saturation transition evidence

DECISION: MODIFY — retain the initial defect evidence; verify the existing repair and strengthen regression coverage.
WHY: The initial continuous-ramp probe measured a 90.408226 Thick saturation sample on an amount change from 40 to 41. The current source already contains antiderivative-history rebasing; the replay measured approximately 0.0069. This loop does not claim to implement that existing production correction.
DISSENTING VIEW: A whole-engine reset, new smoothing framework, extra oversampling or limiter masking was declined as unnecessary for the quotient-history defect.
AFFECTED LAYER: wasm-dsp.
USER / AUDIO IMPACT: Guard against reintroducing artificial impulses when a saturation curve changes while preserving unrelated stage history.
BUNDLE / TEST IMPACT: Focused continuous-ramp tests; no production algorithm change from this item.
ACCEPTANCE CRITERIA: Small drive edits, directed character transitions and inactive updates remain finite and bounded around the antiderivative fallback thresholds; unchanged/rejected updates preserve state.
TEST PLAN: Native regression and compiled bridge parity; distinguish these bounded fixtures from hardware, alias or universal smooth-automation certification.
DOCS TO UPDATE: Architecture, tasks and this ledger.

### Round E — fresh integration checkpoint

Source: `1126fa5`, including JSON correction `eb78aab`. The Chair observed full Go race/module/vet/identifier/vulnerability gates and local lint 2.6.2 exiting 0; exact CI lint 2.15.0 also exited 0 with zero issues. Formatting output was empty. Compiled JS-target saturation transition/allocation tests and compiled bridge JSON-rejection history checks passed. Native/legacy/direct/restricted-WASI parity passed all 333 fixtures with exact output, maximum error 0. Production binary build and standalone empty-directory smoke passed. TypeScript, frontend lint, knip and 202 units in 17 files passed; configured spelling checked 125 files with zero issues.

Retained setup failures: the first build used an external dependency symlink and failed; a locked installation inside the isolated checkout resolved it. An extra all-hidden-files spelling scan found 183 preexisting dictionary issues across 41 files, outside the configured passing gate. The first API run used the skill's 200 MB override and failed startup validation against the supported maximum of 135266304 bytes; the default-limit rerun passed with 17 requests, 22 assertions and raw DNS-rebinding 403/upload-limit 413 probes.

Direct binary curl probes returned 200 for valid uppercase EQ/multiband arrays and 400 for oversized, undersized and differently cased masked arrays. The first multiband probe omitted required crossover values and failed its expected-200 assertion; adding 200/4000 Hz crossovers made all four multiband probes pass. The complete Chromium suite exited 0: 53/53 in 3.9 minutes, including six-width axe checks, live effects, 62 control/export comparisons and a 30.9-second large import. Agent synchronization passed for all 11 definitions.

**Round E ruling:** QA and Devil’s Advocate accepted the focused JSON validation correction and saturation regression coverage with no new in-scope P0/P1 defect. Technical Writer confirmed the five documentation surfaces match the integrated diff. The bounded follow-up is locally verified; **open — awaiting merge**. Owner merge and remote CI remain pending; broad hardware, alias, true-peak and all-settings automation certification remain open. Prior gate results elsewhere in this ledger remain historical.


## WASM DSP stage history, recovery and packet follow-up — 2026-10-21

Scope: `/war-room-loop feature=wasm-dsp`, current PR #4 integration branch after `main` at `1dcbed7` was merged as `2ee7b1e`. The prior JSON/saturation-test wave and its historical gates remain intact. Both remote runs at its documentation checkpoint passed: [39715091775](https://github.com/yegamble/aurialis-WASM/actions/runs/39715091775), [39715070466](https://github.com/yegamble/aurialis-WASM/actions/runs/39715070466). These are prior-wave results, not acceptance of the changes below.

### Round D — discard inactive stage history

DECISION: ACCEPT — P1 required correction.
WHY: Native probes found frozen history replaying old audio after more than one second of disabled silence: EQ peak 2.758, saturation 0.078, mono-bass 0.207, De-Harsh 0.048 and multiband 0.181.
DISSENTING VIEW: A whole-engine reset on every edit or a new smoothing framework would discard unrelated state and expand the repair unnecessarily.
AFFECTED LAYER: wasm-dsp.
USER / AUDIO IMPACT: Clear state owned by the deactivated or neutralized module/band/subpath so later activation cannot resurrect that frozen audio; preserve unrelated processing history.
BUNDLE / TEST IMPACT: Stage-local state handling and targeted native/compiled transition regressions; no new dependency or constant-setting algorithm replacement.
ACCEPTANCE CRITERIA: After active input, disabled silence and reactivation, affected paths do not replay the old signal; unrelated state and steady-setting outputs remain covered independently.
TEST PLAN: Module, EQ-band and subpath deactivation/neutralization tests; native/JS/WASI fixtures, allocation checks and integrated browser output.
DOCS TO UPDATE: README, API, architecture, tasks and this ledger as behavior warrants.

### Round D — failed initialization after Pause

DECISION: ACCEPT — P1 required correction.
WHY: Pause invalidated the original Play ticket, so its failure guard skipped cleanup and the next Play reused a rejected initialization promise.
DISSENTING VIEW: Replacing the audio controller or changing navigation ownership is unnecessary; retain promise ownership for cleanup separately from current audible intent.
AFFECTED LAYER: nextjs-ui, wasm-dsp.
USER / AUDIO IMPACT: A failed paused initialization releases its graph and promise; the next trusted Play can retry, and stale failures cannot tear down a newer attempt.
BUNDLE / TEST IMPACT: Existing controller ownership logic and focused unit/browser failure-retry tests.
ACCEPTANCE CRITERIA: Hold WASI initialization, Pause, fail it, then Play once; a fresh successful attempt becomes audible without stale cleanup disposing it.
TEST PLAN: Deferred initialization rejection unit cases and actual held-fetch/503 browser regression.
DOCS TO UPDATE: README, architecture, tasks and this ledger.

### Round D — validate numeric packet shape before publication

DECISION: ACCEPT — P1 required correction.
WHY: Two multiband entries encoded 76 values and retained stale trailing controls. Four encoded 86 values and could throw after publication began, leaving an odd sequence that subsequent updates could not recover.
DISSENTING VIEW: Current hydration/UI preserve three bands; this is a reproduced runtime boundary defect, not a demonstrated ordinary GUI failure.
AFFECTED LAYER: wasm-dsp, nextjs-ui.
USER / AUDIO IMPACT: Require exactly three multiband bands and 81 finite values before opening the transaction; rejection preserves payload/version/sequence and later valid updates remain usable.
BUNDLE / TEST IMPACT: Two shape guards and focused packet/state tests; numeric ABI and dependency count unchanged.
ACCEPTANCE CRITERIA: Two/four-band packets reject before mutation, and a subsequent valid packet publishes normally.
TEST PLAN: Encoder and shared-buffer transaction regressions, frontend static/unit gates and compiled numeric-ABI parity.
DOCS TO UPDATE: README, API, architecture, tasks and this ledger.

DEFER — P2: Native cross-output aliasing has no demonstrated application caller. No generic overlap abstraction is added in this wave. Version 2/hardware-parity blueprints remain specifications only.

### Iteration 2 — stage acceptance reopened

VERDICT: INCOMPLETE — SEND BACK TO WAR ROOM LOOP.

QA and Devil’s Advocate independently found that `d7146a2` still retained model-local shaping histories while another saturation model was active. Crisp→Thick, more than one second of zeros, then Crisp produced an approximately 0.0838 peak at 48 kHz; Tape/Transformer group transitions produced approximately 0.00027/0.00057. These native probes are a failed acceptance checkpoint, not a reason to relax the silence criterion.

Round D follow-up: clear only `ironLP` when leaving Crisp and the shared `colorLP` when leaving the Tube/Tape/Transformer group. Preserve shared saturation interpolation, antiderivative and DC histories during active-model changes. The first stage checkpoint was insufficient and required this follow-up plus fresh post-change gates. Frontend static/unit evidence for unchanged source and any Go/build results at `d7146a2` remain tied to that earlier scope. The new paused-failure browser regression (`0fc952b`) first exited 1 against earlier packaged assets: Retry playback was not visible within five seconds. Its corrected packaged rerun exited 0 (one case, 3.4-second body / 9.6-second command). That bounded lifecycle pass did not close the model-history correction at that checkpoint.

### Iteration 2 — corrected integration checkpoint, 2026-10-22

Source `79a6b49` includes model-local history correction `2f7eab6`, stage-lifecycle correction `d7146a2`, paused-init cleanup `2883b5d`, packet guards `3740f84` and browser regression `0fc952b`. The Chair observed full Go module verification, vet, exact CI lint 2.15.0, identifier, vulnerability and race gates exiting 0 and empty formatting output. Nine compiled JS-target lifecycle/model tests passed, including 84 model-return cases. Rebuilt dual WASM modules, production binary and standalone empty-directory smoke passed. Constant-setting parity retained exact agreement across all 333 native/legacy/direct/restricted-WASI fixtures, maximum error 0. Nine dynamic actual-WASI model-history transitions at 8/48/192 kHz passed through numeric controls without reset between edits. A separate baseline/corrected native comparison generated 279+54 fixtures from the unchanged main-era engine and corrected integration; direct byte comparison matched the generated JSON contents for all 333 fixtures, establishing unchanged PCM for those constant-setting inputs.

Retained compiled failure: the added WASI regression first failed against the earlier reactor, Crisp at 8 kHz producing −0.0958729535. The rebuilt follow-up passed rather than relaxing the silence assertion. Independent QA and Devil’s Advocate reran their original probes successfully and found no new in-scope P0/P1 after `2f7eab6`.

Frontend TypeScript/lint/knip and 211 units in 17 files passed for the unchanged frontend correction. Configured spelling checked 126 files with zero issues, and all 11 agent definitions synchronized. Direct script spelling initially found six existing WASI import identifier terms; an explicit file directive and one-file rerun passed.

The current Newman rerun exited 0: 17 requests, 22 assertions and raw DNS-rebinding 403/upload-limit 413 probes passed. The complete Chromium suite exited 0: 54/54 in 3.0 minutes, including the new paused-init regression (1.8 seconds within this run), six-width axe checks, a 10.5-second large import and the 62-control PCM matrix in 30.5 seconds.

**Round E ruling:** QA and Devil’s Advocate independently accepted the stage/model-history, paused-initialization and packet-publication corrections with no new in-scope P0/P1 after the follow-up. Technical Writer confirmed all five documentation surfaces match the source and evidence. The bounded follow-up is locally verified; **open — awaiting merge**. New remote CI and owner merge remain pending. Constant-setting identity and these scoped lifecycle tests do not certify hardware fidelity, alias suppression, true-peak limiting or universally click-free automation.


## WASM DSP offline bridge safety and EQ prediction — 2026-10-22

Prior PR #4 was owner-merged at `ef18a7f`. Its documentation checkpoint `e237876` passed both recorded remote runs: [39720716299](https://github.com/yegamble/aurialis-WASM/actions/runs/39720716299), [39720713174](https://github.com/yegamble/aurialis-WASM/actions/runs/39720713174). Current work uses isolated branch `codex/wasm-dsp-bridge-safety`; previous wave records remain chronological evidence, not fresh acceptance.

### Round D — align the approximate EQ response prediction

DECISION: ACCEPT — P1 required correction.
WHY: The TypeScript prediction used RBJ math while the native engine uses TPT filters with shelf corner scaling and gain-dependent bell Q. Low shelf +6 dB at 250 Hz measured 5.898 versus displayed 3 dB, and at 500 Hz measured 2.413 versus displayed 0.376 dB; high shelf at 12 kHz measured 5.824 versus displayed 3 dB; a 1 kHz bell probed at 500 Hz measured 0.784 versus displayed 2.826 dB.
DISSENTING VIEW: Retain the existing approximate label. A prediction aligned with the native filter equations is not a certified hardware curve or a measured live device response.
AFFECTED LAYER: nextjs-ui, wasm-dsp.
USER / AUDIO IMPACT: Make the settings prediction describe the implemented filter response without changing the Go audio algorithm, styling or dependencies.
BUNDLE / TEST IMPACT: Existing TypeScript response math plus a compact independent native sine-response fixture; no added production dependency.
ACCEPTANCE CRITERIA: Prediction agrees with native response at fixture rates/frequencies, disabled/neutral bands remain correct, and requested/source-rate limits remain explicit.
TEST PLAN: Native sine oracle, frontend prediction cases, static/unit gates and browser response/editor regression coverage.
DOCS TO UPDATE: README, API, architecture, tasks and this ledger as behavior warrants.

### Round D — preflight intrinsic typed-array metadata

DECISION: ACCEPT — P1 required correction.
WHY: A genuine one-element Float32Array with a spoofed own length of eight caused an oversized Uint8Array construction panic and Go runtime termination at the offline JS/WASM boundary.
DISSENTING VIEW: No ordinary GUI trigger or host-machine compromise was established. This is a malformed browser-library caller, not evidence of an upload or localhost-security bypass.
AFFECTED LAYER: wasm-dsp.
USER / AUDIO IMPACT: Use intrinsic branding and metadata for all input/destination checks before DSP state advances; reject unusable views while retaining a usable bridge.
BUNDLE / TEST IMPACT: Boundary preflight and actual compiled-WASM adversarial tests; preserve shared storage, nonzero offsets, output alias ordering and numeric zeros.
ACCEPTANCE CRITERIA: Shadowed properties cannot enlarge memory views, malformed inputs/destinations do not advance engine history, and subsequent valid blocks process normally.
TEST PLAN: Actual legacy WASM tests with genuine shadowed Float32Arrays, fake/detached/invalid views as applicable, shared/offset/alias/zero regressions and native/WASM parity.
DOCS TO UPDATE: README, API, architecture, tasks and this ledger.

DEFER — P2: Native cross-output aliasing still has no demonstrated application caller. Do not add a generic alias framework or a broad exception catch after processing. Version 2/hardware-parity blueprints remain specifications only.

### EQ response failure and corrected prediction

EQ correction `39339d9` introduces 61 actual native sine configurations and 183 frequency probes across 8/44.1/48/96/192 kHz. The frontend fixture comparison allows less than 0.01 dB error for those cases. The engineer reported 64 EQ tests and 275 frontend units passing. The new browser regression failed against the earlier packaged response at 320 px: plotted 3.25 dB versus independent native 5.89847 dB, with a ±0.25 dB allowance for chart sampling and SVG rounding. The corrected packaged regression then passed at 320 and 1440 px in 551 ms within the fresh browser run; the original failed checkpoint remains retained. Independent Devil’s Advocate stress checks passed 24 configurations / 72 probes using ten-second native Float32 sine renders, Q 20 and gain ±24 dB at 8/48/192 kHz; maximum prediction error was 0.00000668 dB. An initial two-second high-Q probe differed by 0.06498 dB; extending settling resolved it without code or tolerance changes. The current Newman rerun passed 17 requests / 22 assertions plus raw curl probes.

### Round E — fresh integrated checkpoint

Source `3888681` includes EQ prediction `39339d9` and browser regression `554b6c7`. Native formatting, module verification, vet, exact CI lint 2.15.0, identifier, vulnerability and race gates passed; the identifier check used its `go run` fallback. Frontend TypeScript/lint/knip, configured spelling over 129 files and 275 units in 18 files passed. Bridge JS-target vet and exact CI lint passed; direct spelling checked the changed Go/MJS bridge files with zero issues. The fresh integrated binary build rebuilt both WASM modules, the frontend and Go executable; empty-directory smoke passed.

Fresh compiled verification passed 279+54 legacy/native fixtures with maximum error 0 plus shadowed-metadata, malformed-view rejection/history and subsequent-valid-processing checks. Direct and restricted-WASI parity each matched all 333 fixtures exactly, and nine retained model-history transitions passed. The rebuilt-assets native API rerun passed 17 requests / 22 assertions plus raw curl probes. QA independently passed 48 fresh compiled-module boundary cases, including eight invalid-view families across all four channel positions, throwing own metadata and a resized ArrayBuffer. Rejected calls preserved destinations and active Crisp/compressor history; the next valid block exactly matched its control. The original own-length-eight probe processed its actual one stored frame and the runtime remained usable. QA and Devil’s Advocate found no new in-scope P0/P1 in the corrected source. The complete Chromium suite exited 0: 55/55 in 3.4 minutes, including the new EQ plot regression at 320/1440 px in 551 ms, all six-width axe checks, the 62-control export PCM matrix in 32.7 seconds and a 13.1-second large import.

**Round E ruling:** QA and Devil’s Advocate independently accepted the corrected prediction and offline bridge with no new in-scope P0/P1. Product Engineer accepted the bounded scope and atomic commit history; Technical Writer confirmed the five documentation surfaces match the implementation and evidence. The follow-up is locally verified; **open — awaiting merge**. New remote CI and owner merge remain pending. The approximate prediction is not a certified device/hardware response, and malformed library-call resilience is not evidence of an ordinary GUI failure or host-machine compromise.


## CI FFmpeg provisioning repair — 2026-10-22

The user authorized repairing the failed PR #5 CI gate. Both [run 39790348108](https://github.com/yegamble/aurialis-WASM/actions/runs/39790348108) and [run 39790323228](https://github.com/yegamble/aurialis-WASM/actions/runs/39790323228) timed out during FFmpeg installation after more than 18 minutes. Logs listed 100 new packages, including a 27.4 MB recommended speech-language package and graphics drivers. Go/static, race and parity steps and the frontend job passed; the independent meter comparison did not execute.

Workflow correction `72839a1` reuses an installed FFmpeg or provisions it with `--no-install-recommends`, two acquisition retries and 30-second HTTP/HTTPS timeouts. Logs also showed slow core-package downloads from the Azure archive; only when installation is needed and `/etc/apt/apt-mirrors.txt` exists, the workflow replaces that URL with Ubuntu’s official HTTPS archive. Package signature validation remains enabled. Separate five-minute provisioning and three-minute comparison step limits retain the independent meter assertions and existing job timeout. No production code or API contract changes.

Local actionlint 1.7.7 passed. All 15 actual FFmpeg comparisons passed, with maximum reported differences of 0.0542 LU and 0.0312 dB; the whitespace check was clean. New remote evidence remains pending. Status: **open — awaiting merge**, with CI verification still required. Preserve the failed provisioning checkpoints; successful local application gates do not replace the missing remote meter comparison.


## Private exact-extrema GoJS graph qualification — 2026-10-23

**Round E scope: accepted private semantics; graph unselected, product work open.** Harness commits `d0dd195` and `cb83d68` preserve all tracked Go and `go.mod` bytes from qualified `e492156`. They do not change public capabilities or activate algorithm 2. The reference performance baseline remains `b7297de`.

The actual GoJS/WASM original/candidate comparison passed 135 cases per side across 8/44.1/48/96/192 kHz. All 11,327,376 bytes per side matched; all ten Go and Node exits were zero. The Chair independently rehashed the same modules, raw streams and receipts. Tier: `wasm-bridge`, finite fixture semantics only. The immutable private directory `artifacts/private-dsp/recovery-20261023/exact-extrema-wasm-graph-runner/` contains 104 indexed files, 40,574,173 bytes; `SHA256.json` has SHA-256 `6a6e7a4bf9f7d8d042674ab58b97778d98f3adc5568c4c16b40d98ac0dd4e717`.

Native/WASM diagnostic parsing found equal raw PCM, exact 16/24-bit WAV and other fields in this finite corpus, with 270 unequal numeric-state digest payloads. Their cause is unproven. The first Node-exit-1 invocation remains RED; its successful host-lifecycle retry used the same modules without relabeling the earlier failure. The native recorder race timeout, earlier Nyquist and 33.2 kHz transparency failures, Newton peak-search limitation and unqualified repair work remain retained and open.

**Round D follow-up:** permit source preparation of the simpler fixed-count paired-module performance screen, with the same test source, exact original/candidate overlays and separate baseline-before/candidate/baseline-after Node children. Do not copy 13 graph functions. Compilation and performance execution require subsequent source review and a coordinated quiet window. The source-only screen now has ten passing synthetic parser/admission checks, but no compiled or timed result. Both source modes stop before wrap or EOF. No new headroom threshold is adopted. The reference baseline's 192 kHz cost remains 0.8013–0.8219 ms per 128 frames against 0.666667 ms; candidate performance, browser continuity and public activation remain open. README, API, architecture, tasks and this ledger are synchronized for this private checkpoint; historical records are preserved.


### Untimed paired-module follow-up — 2026-10-23

At source `b562e50`, both bounded GoJS modules compiled successfully. Each new module's 27-case 192 kHz recorder reproduced its archived 2,389,200-byte stream exactly. Four separate steady/peaky baseline/candidate verification children passed paired PCM and numeric-state digest equality, both finite/repeat configurations, after 64 warm and 32 verification blocks. All six Go/Node exits were zero, with no IO/supervisor/cleanup failure. The recorder ran once per new module. No timed child ran; no throughput, zero-allocation, deadline or browser continuity result is claimed.

The immutable private snapshot `extrema-paired-screen/screen-b562-v1/UNTIMED-SHA256.json` indexes 55 files, 20,360,661 bytes; SHA-256 `2890fbfcc05608876eeb0cab5278e9e92e0ab3da9af1f99d767c0e3fdcd3fa30`. `BUILD.json` has SHA-256 `f38115c13c792c0280084342affa6e5fab732ba66a16a2c9acc3b96d8c5b02ec`. It binds exact source, modules, compiler flags, overlays and runtime. Prior evidence indices and historical REDs remain intact. The source clock stops before EOF/wrap; timings require a separate coordinated quiet release. Candidate selection, the 192 kHz deadline and public algorithm-2 activation remain open.


### First paired 192 kHz timing — deadline remains RED

The Chair released exactly six fresh fixed-count children, using the same two modules and source. All Go/Node exits were zero, with no IO/supervisor/cleanup failure. Actual paired verification/timed PCM and state digests matched, including each child's reset verification. All twelve mode batches observed zero changes in Go allocation counts and allocated bytes. No additional tranche ran.

Steady finite/repeat ms per 128 frames: baseline before **0.841256/0.862528**, candidate **0.800752/0.748520**, baseline after **0.838176/0.806768**. Peaky: before **0.716648/0.689784**, candidate **0.623640/0.611544**, after **0.667272/0.668776**. The two steady candidate means still exceed **0.666667 ms**. Lower peaky means and before/after drift are retained as observed. There is no overhead subtraction, filtering, repeat, new threshold or worst-callback claim.

Immutable `FIRST-TIMED-SHA256.json` under the same private evidence directory indexes 91 files, 21,245,213 bytes; SHA-256 `1b93d8de3abea0fe1cdfd359c9f22735b311a49e31b9fe6ac4750ba6d888620f`. It retains all raw bytes/receipts and prior untimed proof. Candidate selection, the 192 kHz deadline and public activation remain open. A bounded current-graph gain-planner/envelope/saturation profile is proposed only; no x-bit/ADAA/rate-policy fusion or new measurement is authorized. The next chair must review and dispatch that scope separately.


### Envelope node-visit source and native unit checkpoint — 2026-10-23

**Round D ruling: accept source preparation and independent unit controls only; open — awaiting merge.** The one-line source-only candidate moves full-coverage initialization to the existing `insertLine` entry; partial initialization, arithmetic, traversal and production Go bytes remain unchanged. Frozen producer/inventory assumptions, historical native/WASM evidence, old exact 14/6 overlays and all six untracked AR files stay untouched. Public ABI/selection remain unchanged.

The separate `envelope_node_visit` runner prepares current e492 baseline/exact single-file candidate overlays and admits a copied original control body by byte comparison after receiver renaming. Four native envelope tests per overlay passed with race instrumentation (1.973/1.942 seconds reported), with exact started/passed-test admission and on-disk overlay/source-set reconstruction. Full 8,192-node epoch/IEEE checks follow each of 512 random insertions, 128 dirty epoch operations and 512 event/rebuild operations; query bits and native envelope allocation counts are checked. Six synthetic source contracts passed. Original Chair 1.817-second two-test evidence and v1 results remain separate. Tier: `unit`; no full graph/audio/WASM/performance acceptance.

The v2 private evidence indices are `SOURCE-SHA256.json` SHA-256 `86a4ba9ed16d67ce70352076c2be591d134cf735b5b131dadfca1041e9fb9c33` and `EVIDENCE-SHA256.json` SHA-256 `a1158cad01ef2e7897f486ad6d086ad3e03797004916bc92ad88ef3f9bdd259c`. The fallback Node 24/pnpm 11 bootstrap failure and initial configured spelling RED remain retained; nine explicit Go symbol/domain/path terms address the source-suffix diagnostics without editing Go payloads. The pinned source/document spelling result is recorded separately.

Next ruling permits preparation of a separate full-chain native/actual GoJS semantic runner only. Module compilation, graph/audio execution and timing need later source review and release. Original capacity/alias/partition/tail/repeat/reset/allocation gates and fresh 135-case comparisons against current e492 archives must precede any timing. Existing steady 192 kHz means remain above 0.666666667 ms per 128 frames; the 270 cross-target numeric-state differences remain unproven. Every historical failure remains retained. Candidate unselected; whole product open.


### Same-module host sampling follow-up — 2026-10-23

The separate host-only diagnostic sampled exactly two existing candidate-module verification children. Their raw verification outputs exactly reproduced the accepted steady/peaky outputs. Steady observed 217 total/100 graph-root samples (gain 24, saturation 24, guard 10, other 42); peaky observed 156 total/83 graph-root samples (gain 5, saturation 30, guard 15, other 33). These are coarse stack samples only, with no quiet-window, benchmark, throughput or deadline inference. The earlier profile proposal remains historical; this is its separately executed diagnostic follow-up.

Immutable `extrema-paired-screen/profile-b562-v1/SAMPLING-SHA256.json` SHA-256 `2441f56d707d5ec1e6beeef71c40ae068d567576310665740ca0a43d84efbc1d` indexes 23 files, 15,650,216 bytes, including 175,583 profile bytes. The same modules and their prior timing results remain unchanged. Steady 192 kHz remains RED; candidate unselected and whole product open.


<!-- cspell:ignore GOARM -->

### Node-visit full-chain runner source checkpoint — 2026-10-23

**Round D ruling: accept source and release exactly four sequential module builds; open — awaiting merge.** The five-file `envelope_node_visit_graph` extension passed seven synthetic contracts, Node child syntax, unchanged source/inventory admission and five-file configured spelling. The initial five-name Go-environment spelling failure and exact source are retained separately. Production Go and candidate payload `eb8f5058d09d7d9d8c8b19b2946bc6ff5bbb1bc02d939b526a35434f46a61494` remain unchanged; old producers, inventories, exact 14/6 proofs and six AR files stay intact.

Source v2 `SOURCE-SHA256.json` SHA-256 is `c15f2e59f6eb42555b45800d78631a64f9a8dfcc77d9be465b69969cb178f9d3`; source provenance SHA-256 is `0cdb915ecc432ca542a3ac062be221f652730b32b7fb6d16445cccf9ce6212fb`. Both exact source-time compiler environments observed `GOARM64=v8.0`. The producer records every new runner source and actual compiler/runtime inputs. The released build-only tranche consists of native baseline/candidate plus two GoJS modules, each capped at 16 MiB and a 25-second compiler watchdog, with one compiler at a time. Graph execution and timing remain unreleased at this source checkpoint.

Future native and actual GoJS semantic pairs must match one another and the accepted e492 candidate archives at all five rates, with all original recorder/resource/output/cleanup caps and raw proof retained. Original alias/partition/tail/wrap/repeat/reset/capacity/allocation gates remain separately required. Steady 192 kHz remains RED; cross-target numeric-state differences stay unproven and selection stays unchanged.


### Node-visit native/actual GoJS finite semantics — 2026-10-23

**Round E scope: accept finite same-backend semantics; original invariants/timing still pending; open — awaiting merge.** At source `c3010d88279c47e945ec89b30f9ff9646393df72`, all four fresh module compiles exited zero under their 25-second/16 MiB limits. BUILD SHA-256 is `16aacd5935e4bee8c9e253d926f9fe2d5dfbc2179f68b62b5b7e3d1195fde6f8`. The later released exactly 20 sequential semantic children passed native and actual GoJS 135-case/11,327,376-byte outputs per side. Each pair and each side exactly reproduced its same-backend accepted e492 candidate archive. All supervised/Go exits were zero; there were no supervisor/cleanup failures, and all ten GoJS sinks closed without IO error. The final seal re-read actual streams, counters and post-exit receipts. Tier: `unit`/`wasm-bridge`, finite fixtures only.

Immutable `SEMANTIC-SHA256.json` SHA-256 `07ccfacdf5247933321e823044660461ea2fb7667a545018851e7a0642a1b2f4` indexes 145 files, 74,114,185 bytes. Qualification SHA-256 is `3cbcf15b51d58c42b7da9568b3c5cde50ffe3e28f2e48c1e7a8b9b8a86bcaf63`. All prior indices, source/module proofs, six AR exclusions and historical failures remain intact. The 270 cross-target numeric-state digest differences remain unproven; no cross-target full-state identity or performance result follows.

The next checkpoint is source/command planning only for 18 named original invariant tests. Read-only source/module byte-name evidence finds every selected test and old screen opt-in in the same four modules; no Go/WASM/Next rebuild is needed for those selections. Alias/partition/tail/wrap/reset/capacity/allocation groups and larger whole-test work are explicit. The Chair separately reviewed spectral alias 374,604 base/1,498,416 high upper, tiny EOF 213,882 base/855,528 high, gain-naive 1,000,000 high-rate calls and scalar envelope 350,000 steps. Keep all original assertions/counts and recorder caps unchanged. Unit execution still requires exact graph/scratch source verification and a reviewed log-only adapter monitoring actual native/GoJS-parent RSS at 1 GiB, with 192 MiB Node heap. The proposed limits retain the old 25-second Go timeout, 28-second supervisor and 256 KiB log cap. No invariant, listing, benchmark or timing child ran. Steady 192 kHz remains RED; candidate unselected and whole product open.


### Node-visit original-unit host source — 2026-10-23

**Round E scope: source/synthetic host controls only; open — awaiting merge.** Six new host-source files reuse the existing four modules and immutable 18-test plan, with one anchored whole test per child, permanent module/test claims, exact start/PASS admission and an exclusive active lock. The GoJS host denies file opens/PCM and keeps the unchanged closed filesystem/post-exit helpers. Original invariant children and timing remain unreleased.

Exact source/hash array arithmetic preserves the largest 196,608-byte envelope member, 131,072-byte guard peak array and 98,304-byte partition response array. The spectral helper has 65,536 sample bytes plus 131,072 FFT scratch bytes. Existing native/GoJS evidence agrees on 1,073,080 fixed graph bytes; no total-process memory claim follows. Separate whole-unit literals/work bounds and recorder caps stay unchanged. A proposed observed resident monitor applies 1 GiB to the native process or Node GoJS parent including WASM at 25 ms intervals, retaining the 25-second Go/28-second parent/256 KiB log/192 MiB Node-heap limits. Sampling is not an instantaneous ceiling.

Chair review found an owned-child setup gap. Three pre-fix mocked controls retained RED registration/setup/spawn failures, index `e2d05457b8af0353966cd6e42727ac032330d2870faf6fafdb1e97bf4c054c47`. The fix guards every operation after spawn, kills/reaps owned children after registration/setup error, records no child for spawn failure and retains primary plus cleanup errors. All 13 synthetic host contracts passed in 2.995 seconds; both Node syntax checks and pinned configured six-file spelling passed. No original Go test or WASM instance ran in these controls.

Frozen `envelope-node-visit-units/source-v5/SOURCE-SHA256.json` is `92b7bec913fa1882d08448ddca2ee5b9e692c172c396a09ce4d82c6618d9d648` (11 files/96,325 bytes); source-check index is `9b0ab4b558612374d4747bd16618a7f7dd8dae17bf0bf5da2eb0c587198e2354`. Old module/source inventories, six AR exclusions, previous freezes and failed checks remain unchanged. Await separate Chair release for original gates. Cross-target state identity UNPROVEN, 192 kHz steady deadline RED, candidate unselected and whole product open.


### Node-visit original-unit preflight RED and exit-observation source — 2026-10-23

<!-- cspell:ignore ESRCH -->

**Round E scope: retain actual infrastructure RED; source-only fix; open — awaiting merge.** The first released original-unit tranche stopped after exactly one native-baseline extrema-bit child. Go exit was zero; the raw log records the test PASS, but source-v5 supervisor admission is RED after an RSS `ESRCH`/process-exit observation race. Two sampled resident values peaked at 5,324,800 bytes. Group signaling was denied during cleanup, leaving cleanup uncertainty rather than proof of surviving descendants. The log did not drain to terminal PASS/EOF. Zero original-unit results are accepted; the other 71 combinations, retries, rebuilds and timing did not run. Actual eight-file/7,255-byte RED index: `94440d692e5e1740d4637e83b4f29d53416ee3f6dc58af80c60fb9c982de1c46`.

The Chair authorized only a narrow source revision: after prior valid RSS, exactly `errno.ESRCH` may use one direct owned-process wait bounded by 25 ms and remaining deadline to confirm/reap exit, record that observation separately, then drain to EOF. A live wait timeout, unrelated error, zero observations or memory overage stays RED. Original time/log/RSS caps, whole-test literals, four modules, effective sources and selection remain unchanged. Any future actual launch must retain authorized owned-process cleanup context and exclusive receipts.

All 18 synthetic host contracts passed in 1.476 seconds; both Node syntax checks and pinned configured six-file spelling passed. Synthetic pre-fix race RED index: `1f819983f56c5f8414325127d65df6a2db47ca1537dacf0d7b8691c969dffbf7`. No original Go unit or WASM instance was launched for this source revision. Frozen source-v6 index is `7005fb5616e8ffa0f3dee593cc8159dd65898ff2420499d8f9a7c62bfaf59204` (11 files/104,071 bytes); checks index is `f13597f45288381b384f1fb7fe779b966d4f995403c870bca281218b3f221257` (21 files/4,476 bytes). Await Chair review and explicit failed-test retry/remaining-unit release under new provenance. Cross-target state identity UNPROVEN, 192 kHz steady deadline RED, candidate unselected and whole product open.


### Node-visit original-unit gate admitted; screen plan only — 2026-10-23

**Round E scope: narrow original-unit gate admitted; timing RED open; open — awaiting merge.** Explicit source-v6 release reran the first four extrema-bit combinations under new provenance, then all remaining 68 original units sequentially. All 18 selected tests passed on native/actual GoJS baseline/candidate: 72 children, 100 started/PASS events including 28 nested FIR cases. Actual logs, claims, parent receipts and all 36 GoJS receipts were re-read; exits zero, EOF/terminal PASS complete, failure/cleanup/signals null and GoJS file opens/data zero. The v5 infrastructure RED remains unchanged and excluded from accepted results. The Chair independently admitted the narrow original-unit gate.

`source-v6/UNITS-SHA256.json` is `9d6e75edbc100155ff3e7d9f037054a7ee60bb7b199db6a4888cb83b06497c51` (556 files/747,712 bytes); qualification is `0309c47abc63ea5126bbab1f84a205526d950989fa7a387ba224f0006adb5521`. Observed RSS maxima: native23,166,976 bytes/GoJS153,616,384 bytes; 35 confirmed/reaped native exit observations. Original test literals, all caps and four modules remain unchanged. Tier: `unit`/`wasm-bridge`; no instantaneous RSS or performance guarantee.

The three-file `envelope_node_visit_screen` plan proposes only same-module provenance bindings for a future paired screen, with original 64/32 warm/verify blocks, reset/warm64/timed32, finite/repeat order, before/candidate/after brackets and caps preserved. The old immutable supervisor setup gap is explicitly a separate source-review prerequisite for a future host-owned launcher. No new adapter, build, screen, profiler or timing was executed. Root review and all-agent quiet acknowledgment precede any timing release while other producers/functional work remain active. Existing steady 192 kHz RED remains open; no mean-based callback/physical deadline/headroom inference. Cross-target state identity UNPROVEN, candidate unselected and whole product open.


### Node-visit same-module screen binding host source — 2026-10-23

**Round E scope: source/synthetic host only; actual verification/timing unreleased; open — awaiting merge.** Four new host files implement explicit `BINDING.json` schema for the same existing WASM pair. They bind the graph BUILD, actual sealed 192 kHz recorder bytes/receipts against the accepted same-backend e492 candidate archive, semantic/72-unit indices and unchanged v5 infrastructure RED. All 37 source inputs are indexed; no modules are copied/built and frozen Go payloads keep `.source` suffixes.

The child is constrained by a literal metadata transformation of the frozen screen child, retaining original Go test/work/argv/environment, closed filesystem and post-exit method while removing the fixture route. The parent closes the process-creation/selector-registration ownership gap with guarded kill/reap, separate primary/cleanup errors, exclusive receipts and EOF admission. Old parser/admission helpers and all original time/log/data/work caps stay unchanged; no unit heap/stack/RSS method is introduced. No actual screen/GoJS instance, verify fixture, timing, profiler, optimization edit or rebuild ran.

All 20 source contracts passed in 3.440 seconds, including ten reused original parser tests; Node syntax and pinned configured four-file spelling passed. Initial index-layout admission/spelling RED remains retained and old proof bytes unchanged. Frozen source index `3d31cf5c1f7d5104dbac30f83cfe68353da56dfd2525624672e2cc9804ef78b6` covers 38 files/328,653 bytes; check index `ed6a74665b7d895d3c938a904ad7e6059661596e04b242bdcad7cc9b490500cb` covers 18 files/4,838 bytes. Await independent review and separate verification/timing releases, with all-agent quiet acknowledgment before timing. The 192 kHz steady RED remains open, cross-target state identity UNPROVEN, candidate unselected and whole product open.


### Node-visit same-module untimed verification — 2026-10-23

**Round E scope: four semantic verification children passed; timing unreleased; open — awaiting merge.** The explicit release ran exactly four sequential source-v1 GoJS verification children, baseline/candidate for steady/peaky on the same two existing modules. Both actual raw-output pairs were byte-equal, with PCM/numeric-state/input/clock agreement. All Go/parent exits zero, failure/cleanup/signals null, EOF complete and GoJS sinks closed. Per child: 24,576 base/98,304 high upper frames, 231,716 numeric words; steady 68,134 bytes and peaky 68,133 bytes. No measure command, fixture rerun, build, profiler, retry or optimization edit ran.

The seal re-read raw streams/counters, all actual parent/child receipts and immutable semantic/72-unit/old recorder/v5-RED prerequisites. Verification index `3c72daf7ccd7c94e4ffaf470aa84899637de34646c3dde9ccad50edcedac1b83` covers 69 files/642,128 bytes; qualification is `5f357d699c70e2b879913607f191960fc5a5cb270a9482cb7b5d73a8e845c0d9`. Await root review and separate timing release with all-agent quiet acknowledgment. The existing 192 kHz steady RED and historical v5 infrastructure RED remain retained. No callback/physical deadline/headroom, source wrap/EOF/drain or physical steady-state certificate follows. Candidate unselected, cross-target state identity UNPROVEN and whole product open.


### First node-visit same-module paired timing — steady RED

**Round E scope: first six-child bracket retained; open — awaiting merge.** Final quiet acknowledgment preceded exactly six sequential measurement children on the existing source-v1 modules: steady then peaky, baseline-before/candidate/baseline-after. All six actual Go/parent exits were zero, failure/cleanup/signals null, full stdout EOF/closed I/O, with zero allocation deltas. Actual verification and timed PCM/state/clock bytes agreed across each bracket. No retry, fixture rerun, profiling, rebuild or optimization edit ran.

Steady finite/repeat means (ms per 128) were before **0.748352/0.749000**, candidate **0.766768/0.764184**, after **0.766632/0.773944**. Both candidate means exceed 0.666666667 ms. Peaky was before **0.618160/0.611480**, candidate **0.608848/0.609888**, after **0.609576/0.609144**. Retain all drift; no consistent improvement is established and the steady RED remains open. These are only 32-block means, frames 8,192–12,288 after reset/warm64, before source wrap/EOF; no callback/physical deadline, browser, headroom, drain or physical steady-state claim follows.

Measurement index `268715bac849025662b7ee0ec1ec16991835cb308ed595d7ec722a92645e11ba` seals 106 files/1,532,155 bytes, including actual six-child receipts and all prior screen proof. Qualification is `63a5a42cbcf5d9acf81e8f9250e9be6f04b9f296fc19594f8a24c157045e6b45`. The initial post-run seal helper's EOF-key error is retained; only the read-only seal was corrected, without child rerun. Per child 49,152 base/196,608 high upper frames and 463,432 numeric words; all owned producers settled. Historical REDs retained, cross-target full-state identity UNPROVEN, candidate unselected and whole product open. Next source-only investigation must identify an exact arithmetic bottleneck through measured attribution before another optimization is admitted.


### Steady function-attribution diagnostic source

**Round E scope: source/static/pure controls only; actual profiles unreleased; open — awaiting merge.** Four new host/parser/contract/readme sources implement the accepted proposal around the exact existing WASM pair. All 45 inputs are indexed without forging the unchanged 37-source child binding. Static names/code inspection maps 4,197 defined functions plus 21 imports per module; only index 3680 has different body bytes, both 1,141 bytes. This gives no instruction-count or cost inference.

A future separate release proposes exactly baseline then candidate steady verification, explicit 100-microsecond CPU-profile argv and diagnostic umask 077. The unchanged child/work/closed-I/O/post-exit method, original caps and fully owned selector/setup/kill/reap guard remain; raw output must equal sealed original bytes. The validator permits only literal expected-argv replacement and never substitutes receipts. Pre-read module regular-file/no-symlink/16 MiB checks, strict schema/tree/clock admission and aggregate 4 MiB profile/16,384-node/65,536-sample/1,048,576-step caps fail closed. Profile size is admitted after exit, not a hard write/V8/RSS ceiling. Self/inclusive/edge/path reports preserve actual function mappings and observed sampling intervals; memberships overlap and timing is incomparable to the original bracket.

All 21 synthetic/static controls passed in 1.867 seconds, including five inherited mocked lifecycle/I/O tests; Python syntax and read-only exact source/module evidence admission passed. No diagnostic prepare/run, WASM/profile child, fixture, build, timing or optimization edit ran. Initial static-inspection compatibility failure and all historical failures retained. Separate source review/execution release remains; existing steady RED open, cross-target full-state identity UNPROVEN, candidate unselected and whole product open.


### Two actual steady function-attribution profiles

**Round E scope: sampled-path diagnostic admitted; open — awaiting merge.** After accepted fresh preparation and final quiet release, exactly baseline then candidate steady verification profiles ran on the same existing WASM pair. Both entire 68,134-byte streams matched sealed source-v1 bytes. Actual Go/parent exits were zero, primary/failure/cleanup/signals null, full stdout EOF and closed GoJS I/O. Each processed 24,576 base/98,304 high upper frames, 231,716 numeric words and 299 log bytes, without timed records. No retry, fixture rerun, build, timing or optimization edit occurred.

Baseline/candidate profiles contained 1,827/1,867 total and 1,046/1,059 graph samples, zero unresolved WASM nodes/graph samples. Requested interval was 100 microseconds; actual median 153/153, mean 160.596/159.022, minimum 35/38, p90 157/158, p99 168/219 and maximum 13,055/7,307. Actual function self samples: `insertRange` 134/118, `bound` 76/78, `insertLine` 47/38. Limiter inclusive membership 292/278 and saturation 252/287 overlap; no function-cost, speedup or comparable-timing inference follows.

Aggregate 528,474 profile bytes/2,462 nodes/3,694 samples/52,733 stack steps passed the unchanged post-exit admission bounds. Original 25-second Go/28-second parent/256 KiB log and module/output/Go-work gates remain; no Node heap/stack flags or RSS monitor were added. No RSS observation or 1 GiB RSS gate passed here, and post-exit 4 MiB profile admission is no hard write/V8/RSS ceiling. Earlier unit resident observations remain separate. Source clock remains before wrap/EOF with no drain; no callback/physical deadline/headroom or physical steady-state claim follows.

Actual profile index `d5ae9935a2a9373ad70c97693aa664b8a107174c7e75aed32aa179e5df2f4677` seals 102 files/4,167,378 bytes; qualification `29cc153cb0321a9af793bbc27e80a64f2b5b25cfd2a33bb6fa367dbc0b6d377c`, sampling summary `7105f2510f55e61f0f547e73a0531511d8c5d4e96f16b5b9d25acf81e54f059d`. All children and attribution postprocessing settled; the Chair ended the quiet window. Historical failures retained, cross-target full-state identity UNPROVEN, candidate unselected and steady 192 kHz RED/whole product open. No further actual execution or new optimization is released.


### Bound-coordinate cache source-only proposal

**Round E scope: one source proposal only; open — awaiting merge.** A review diff proposes caching unchanged signed `x` as float64 before bound traversal, then using that operand without changing node/epoch reads, path branches, multiply/add/max order or state. Negative coordinates remain negative; no bit-path rewrite or insertRange bundling. A stale root would perform one unused conversion where the original performs none. This work-placement change is explicit; no speedup follows.

Static pinned-Go-emitter inspection of both identical 928-byte existing WASM bound bodies finds the conversion at body+384 feeding multiply/add within a constant-dispatch-aware call-free control cycle. Other branch conditions are abstract; neither dynamic counts nor V8 optimized code/cost is observed, and V8 may already hoist it. Proposed source derives from qualified original source bytes with intended SHA `a5ff75b66b649116857effe11fde78749edad3201ed964741cdc137d7967018a`. No current Go/candidate payload, build, unit, WASM or timing execution changed.

Independent frozen-original IEEE/full 8,192-node controls, dirty/stale/negative/extreme-frame and allocation cases are planned only. Qualification should reuse exact sealed original baseline native/WASM modules/results when source/compiler/build/test contracts match, and separately release only the new candidate pair by default; any test-only overlay is explicit. Compiler inspection and actual semantic/original invariants precede any timing proposal. Candidate unselected, existing 192 kHz steady RED/historical failures retained, cross-target full-state identity UNPROVEN and whole product open.

### Bound-coordinate inactive source checkpoint

**Round E source checkpoint; open — awaiting merge.** The reviewed source implementation now lives in `envelope_bound_hoist` as an inactive `.source` payload and an independent complete copied-original control. It keeps all 4,911 paired exact IEEE cases, while complete 8,192-node checks surround 562 setup/mutation batches. Fixed work is 1,686 state scans, 41,435,136 field comparisons and at most 124,776 query node visits, including 576 additional allocation-gate calls. Original 18 whole-unit tests remain unchanged. The exact eight-entry overlay preserves six AR exclusions, replaces only the bound source and adds one virtual control test; original screen/recorder functions remain compiled. The copied v6 owned guard changes only an explicit deadline parameter: compiler 25 seconds, unit parent 28 seconds with Go timeout 25 seconds. Logs/module caps remain 256 KiB/16 MiB; RSS is a sampled 1 GiB workload-leader admission, without an instantaneous or descendant-aggregate ceiling. Source/mock contracts passed; an initial formatting diagnostic was retained and corrected. This source checkpoint precedes the separately authorized single native candidate build/direct unit. No baseline rebuild, WASM, full-chain, profiler or timing execution is included; candidate unselected and steady RED remain open.

### Bound-coordinate first native checkpoint

**Round E native direct gate only; open — awaiting merge.** The first released native bound-coordinate tranche passed: one candidate compile and one direct copied-original oracle/allocation unit. The exact module is 6,630,066 bytes, SHA `3d16714502cfeada97cf88e1c5e0e6d8a7db173eea1807721b369625c47b6328`; native proof index `d671be5fbd0161cad6a3b72bb3d0571d4d8b4580c86f3ca22e38c63011f35652` seals 63 files/6,993,027 bytes. All 4,911 paired output bits, 562 batch-state checks and 576 allocation-gate calls passed, with zero query allocation count/bytes. Compiler and unit exited zero with complete EOF and no primary/cleanup/signal failure. Sampled leader RSS maxima were 29,966,336/11,124,736 bytes; one unit process-exit observation was narrowly confirmed exit zero/reaped before EOF. These are sampled leader observations, not instantaneous or aggregate memory ceilings.

The Homebrew Go1.26.2 bootstrap selected actual Go1.26.10; both sealed baseline and candidate module metadata declare1.26.10 with matching recorded native flags apart from the explicit overlay path. Actual selected compiler/linker hashes are retained, while historical baseline executable hashes remain unrecorded. Read-only exact native bound inspection moves the conversion before the first node read and retains the FMA expression; code/register differences imply no cost or speedup. The initial build-command preflight failed before any compiler/test launch because an evidence freezer copied one `.go` suffix. Its RED is retained; only that identical evidence copy was renamed `.go.source`, with the original index and an explicit relocation index preserved. Unchanged historical inventory/source admission then passed before the separately released fresh native invocation.

The three-file `envelope_bound_hoist_wasm_plan` proposes one new candidate WASM build with the exact final overlay, one identical closed log-only direct unit and normalized exact-name bound inspection against the unchanged qualified baseline. It implements no adapter and releases no WASM child/build. Full-chain and original 18 candidate-unit gates remain pending; no profile/timing, selection or deadline acceptance follows. Existing 192 kHz steady RED remains open.

### Bound-coordinate GoJS source host checkpoint

**Round E source only; open — awaiting merge.** The separate closed five-file `envelope_bound_hoist_wasm_host` now implements the held source plan without changing the reusable native seven-file folder. Its 44-input binding pins the final payload/control, unchanged guard and log-only IO/FS/lifecycle, plus actual native-selected Go1.26.10 driver/compiler/link/runtime bytes. The future direct driver uses explicit local toolchain selection; historical baseline compiler hashes remain unrecorded. An exact single-test whitelist and actual Node/Go argv receipts preserve the original unit limits and work. The bounded inspector resolves only the production bound name and retains raw bodies, locals, all decoded control/math operations and conversion-cycle comparisons. Local renaming is descriptive and unknown/ineffective shape stops further admission; no V8/cost claim follows. All 17 source/synthetic/mocked controls and Node syntax/admission passed. A retained source-control failure for legitimate empty evidence logs was corrected with a no-follow, one-byte bounded probe; positive-size module admission is unchanged. Source freezing repeats the historical inventory check after suffix-safe copies. No compiler or GoJS instance, full-chain test, profile or timing ran; actual WASM release and broader gates remain pending, candidate unselected and 192 kHz steady RED open.

### Bound-coordinate first GoJS checkpoint

**Round E direct GoJS/code gate only; open — awaiting merge.** The separately released GoJS tranche passed one selected-Go1.26.10 candidate WASM compile and one identical direct oracle/allocation unit. Module SHA `e9b1ebc5dd66ee0ce6c8179549286691792b7f97b6f21cc71d9362835732096e` is 7,597,448 bytes. Actual proof index `8819cd587b2098759cb37b48d67b9bb19795fe8eab5333f1a8e64467d9f1e9c0` seals 62 files/8,288,680 bytes in place, without a module copy. All 4,911 paired IEEE results, 562 state batches and 576 allocation-gate calls passed, including zero query allocation count/bytes. Compiler/Go/parent exits were zero, stdout reached EOF, primary/cleanup/signal failures were null and closed log-only IO recorded zero open attempts/data bytes. Sampled leader RSS maxima were 29,392,896 compiler bytes and 111,525,888 Node bytes; these are neither instantaneous nor descendant-aggregate ceilings. Original compiler25/Go25/parent28-second, Node192 MiB heap/8192 KiB stack,256 KiB log and16 MiB module limits remained.

Read-only exact-name inspection retained both raw bodies and complete decoded control/math/local/call reports. The baseline bound body is928 bytes; candidate942. The baseline conversion is in a reachable bounded static cycle at dispatch2/4; the candidate conversion at dispatch0 has no such cycle. Decoded floating-operation sequence and named-call order match. Other branch conditions remain abstract and calls are treated as returning; local renaming is descriptive, not proof of equivalent control. No V8 behavior, cost, speedup or deadline claim follows. Selected compiler/link/runtime bytes match the actual native observation; historical baseline executable hashes remain unrecorded. No baseline build, extra GoJS instance, full-chain test, profile or timing occurred. New-candidate full-chain and original18 whole-unit gates remain pending; cross-target full-state identity remains UNPROVEN, candidate unselected and192k steady RED open.

### Bound-coordinate full candidate qualification plan

**Round E next source plan only; open — awaiting merge.** A separate three-file `envelope_bound_hoist_qualification_plan` proposes36 unchanged original-unit children and10 original recorder children on the same two candidate modules, with same-backend frozen comparisons, unchanged work/caps and no baseline rebuild or automatic timing. It implements no adapter and remains held for review.


### Bound-coordinate qualification adapter source

**Open — source/mock checkpoint only; all46 actual children unreleased.** The closed seven-file adapter binds56 source inputs and reuses the same two admitted modules, original18 whole-unit assertions/work and original27-case recorder at five rates. Literal GoJS execution/post-exit blocks, whitelist, owned RSS/lifecycle guard, IO and counters remain unchanged. The fixed276-file ledger reserves128,073,728 bytes, covering output/log caps plus receipts, claims, results, source, indices, journal, allocation rounding and overhead. A fresh physical check before each child transaction and subsequent host publication requires6,576,668,672 bytes plus complete remaining DSP demand, explicit other demand and at least64 MiB for concurrent source writes. Internal raw writes use their pre-admitted transaction. Only observed available blocks count; no OS reservation is claimed.

All11 source/static/pure/mocked controls passed, including exact execution-block identity, closed job order, disk boundaries, wrong provenance/argv/IO, and primary/secondary publication/cleanup preservation on Python3.9. Node26.12/pnpm10.33 syntax and scoped spelling checks passed; initial spelling diagnostics remain retained. No actual compiler, original-unit/recorder child, module copy, profile or timing occurred. Historical baseline compiler hashes remain unrecorded, cross-target full-state identity UNPROVEN, candidate unselected, existing192k steady RED and earlier failures retained. Later main integration/fresh final-head gates and protected merge remain open.


### Bound-coordinate qualification binding RED and source correction

**Open — actual tranche stopped; correction is source only.** Exactly two child processes ran: the native original `ExactExtremaBitContract` passed, while the GoJS child exited1 before Go/WASM instantiation because the new binding rejected one legitimate pinned artifact path. All56 current hashes matched. The artifact was7143 bytes with SHA `d08bb53eaa21e60ede7afd953df277597bb20897d06c2acc0d8b4e14937011fb`; no GoJS IO receipt was produced. Both raw parent receipts reached EOF with null guard/primary/cleanup/signal failures. Sampled leader maxima were5,406,720 native and62,128,128 Node bytes; the native exit race was confirmed/reaped at exit0. There was no third child or retry, and44 jobs were never launched.

Pre-repair RED index `81da3cf7763cc27de00015b281d317e92fc5a7358ca1d1745b9558e979e9f7c1` seals78 files/14,741,587 bytes, including existing module bytes in place and the exact frozen source resolution. Original source-v1/claims/raw receipts/logs/journal remain, with no reset or qualification seal. The minimal source correction permits only that literal artifact path, exact SHA and exact7143-byte size. Its independent source control admits all56 inputs and rejects five path/hash/traversal/size negatives with zero Go/WebAssembly entry attempts; all12 controls passed. Math, original tests, modules, work and caps are unchanged. Revised actual execution awaits explicit review/release. Historical compiler executable hashes remain unrecorded, cross-target full-state identity UNPROVEN, candidate unselected and192k steady RED open.


### Bound-coordinate recorder admission and minimal continuation

**Open — second actual tranche stopped at child 38; no continuation runtime release.** All 36 original whole-unit children passed on the existing native/GoJS modules, including all seven nested convolution cases. The native 8 kHz recorder passed. The actual GoJS 8 kHz recorder exited zero with closed output, exact 27-case counters and a complete 2,354,640-byte stream matching both own-backend archives. Its host gate rejected the one expected missing-file query before exclusive creation. This is another receipt-admission defect; the old REJECTED is preserved. Eight remaining recorder children were never launched, and no completed unit or recorder has been rerun.

All 38 parents exited zero with full EOF and null guard/primary/cleanup/signal failures; 20 exit races were confirmed/reaped. Sampled leader maxima were 18,333,696 native and 139,018,240 Node bytes, without an instantaneous or descendant-aggregate ceiling claim. Immutable RED-V2 index `a973b6f5fef9c14afd0c64eb4f2d49a22522789453206e1dc43df1ae8ea01eb3` seals 355 files/19,861,307 bytes; source-v1 and source-v2 remain unchanged and have no qualification seal.

A separate four-file recorder policy/plan permits only one exact virtual rate-file absence query before the sole exact exclusive open and close. Wrong paths/errors, post-open absence, duplicates and all other non-success results fail. The copied provenance validator changes only that request-policy condition; raw receipts are never rewritten. All six source/read-only/pure controls passed, including the actual retained trace and all 56 unchanged old inputs. A separately labeled read-only analysis admitted the existing GoJS 8 kHz raw evidence under policy SHA `adf39a911e85f374a11227b760bc1c6f1b7fbb9bb83fb6687a5a5f82e4c20d51`, while retaining the old RED. Analysis SHA `f1e9b52054611df26fe15e1c903cca9b159930cca2b886ff8648cd6fdc5531cd` records the original raw/module/runtime/parent hashes and both complete same-backend byte comparisons; no runtime child was repeated.

The plan proposes only native then GoJS recorders at 44.1, 48, 96 and 192 kHz. A small future driver must bind its actual host/policy separately from the unchanged legacy child sources. This is combined scoped qualification with distinct provenance, not a uniform 46-child pass. No continuation driver, runtime child, build, module copy, profile or timing has been released or executed here. Original work/assertions/caps and physical reserves remain; candidate unselected, cross-target full-state identity UNPROVEN, historical baseline compiler hashes unrecorded and existing 192 kHz steady RED remain open.


### Fixed eight-recorder driver source

**Open — source/mock checkpoint only; no preparation or continuation child.** The new three-file driver implements the accepted eight-job plan without changing the old seven-file host, 56-input source, four-file policy or modules. It reuses the completed 36 units and both old 8 kHz processes, including the separate read-only GoJS admission; both historical gate REDs remain immutable. Only native then GoJS at 44.1, 48, 96 and 192 kHz are selectable.

Seven additional host/policy files are separately pinned and checked before each child and after admission. The copied recording block changes only its explicit policy call. Fresh exclusive claims, exact START/clean SETTLED provenance, prior raw-result revalidation and final exact-eight scope checks prevent advancing after uncertain settlement, mutation or an extra job. The fully owned guard and all work/counters/IO/caps remain unchanged. Extra metadata has a finite 3,063,808-byte allocation reserve charged as4 MiB within the existing64 MiB source allowance; raw disk demand/floor/explicit other demand remain unchanged. Python script argv and interpreter identity/flags are observed honestly; an external launch receipt must capture the complete Python command.

All11 source/static/read-only/mock controls and scoped spelling passed. No actual source preparation, runtime child, build, module copy, profile or timing ran. A later seal must label combined scoped qualification rather than a uniform46-child pass, retain final journal bytes and preserve the old REDs. Candidate unselected, existing192k steady RED, cross-target full-state identity UNPROVEN and final main integration/gates remain open.


#### Preparation-error source correction

Independent source review found that complete prepared bytes could coexist with a retained close-failure receipt yet grant authority. The original failed peer probe and prior checkpoint remain retained. The driver now refuses any `PREPARE-ERROR.json` entry before reading bindings, including a dangling symlink; read, run and seal share this refusal.

All12 current source/static/read-only/mock controls and the unchanged one-test peer probe passed. The added control proves refusal before source/dependency reads, budget/frontier admission or the child guard. No actual preparation or runtime was released or executed; the original mixed evidence, module/source pins, work/caps and open performance/integration status remain unchanged.
