# Whole-product completion review — October 22, 2026

Status: **bounded wave verified and merged in PR #6; product incomplete**. Reviewed baseline: `f5ec9ad`, clean `main`. The owner requested all planned features and a comparison with professional Waves workflows. This record distinguishes implemented behavior, required work and executed evidence.

## Evidence and scope

The Chair and three independent councils covered DSP/audio engineering, frontend/design/Devil’s Advocate, and backend/security/QA. They reviewed the same baseline, then challenged the proposed implementation wave. The supplied Gemini conversation describes an older 56-control bridge; current production uses 81 controls. Existing knee, makeup and sidechain controls must not be duplicated.

PR #3 (`97964fc`), PR #4 (`ef18a7f`) and PR #5 (`f5ec9ad`) are ancestors of the reviewed main branch. The earlier MUB-0 sequencing prerequisite is therefore resolved. Earlier failures and acceptance records remain historical evidence.

## Required work at baseline f5ec9ad

This table records the reviewed baseline, before the implementation wave below.

| Area | Baseline behavior | Outstanding acceptance |
| --- | --- | --- |
| DSP compatibility | One immediate legacy engine, 81-number static ABI | Explicit algorithm/capability negotiation, latency/drain contract and retained legacy PCM |
| Compressor | Topology labels share one detector/curve | Distinct Optical, Variable-Mu, VCA and FET algorithms with measured transfer and recovery |
| Saturation | ADAA with midpoint interpolation/averaging | Measured anti-alias filtering and aligned paths; proposed nominal foldback target remains unmet |
| Stereo | Heuristic Side filtering | Matched LR4 Mid/Side phase and crossover validation |
| Limiter | Instantaneous sample clamp/cubic estimate | Time-based lookahead and independent final-output true-peak validation |
| Deep analysis | Disabled product workflow; experimental fixed-fraction labels/profile moves | Source-bound spectral/features analysis, neutral change points and uncertainty |
| Automation | Legacy offline evaluator, no operational script render route | Validated source-bound ScriptV2, common live/export evaluator and editable timeline |
| Smart Split | Honest unavailable UI; API frequency decomposition | Actual instrument-separation model/runtime, quality corpus and 2–6 real playable/downloadable stems |
| Reference | Saved EQ-settings blend | Measured source/reference spectra, regularized fit, protected bass, opt-in width and idempotent Apply |
| Albums | Actual sequential per-track normalization/rendering | Cross-track tonal/dynamic consistency, outlier analysis, selectable target and batch recovery |
| Release guidance | Three generic diagnostic targets | Authoritative platform policies bound to exact rendered audio/settings; no unsupported certification |
| Library/import | Single-file import, search/filter/delete/resume | Multi-import, sorting, quick preview, settings duplication, relink and planned storage guidance |
| Advanced controls | Supported EQ types/enabled and limiter release hidden | Accessible per-band controls, meaningful high-pass interaction and independent live/export audio checks |
| Professional validation | Bounded native/WASM/browser fixtures | Wider acoustic corpus and controlled listening; hardware names/macros do not establish Waves equivalence |

Current Tube/Tape alias fixtures at drive 10 measured about −71.4 dBFS, and at drive 50 about −48.4/−49.4 dBFS. They pass the current −45 dBFS bound but miss the proposed −75 dBFS nominal target. These measurements cover one declared tone, not all signals or an independent hardware comparison.

## Round D decisions

1. **Accept MUB-2A foundation with a narrower claim.** Missing/zero/one algorithm version retains v1; unknown/unimplemented versions are rejected. Advertise implemented algorithm 1 only, actual zero processing latency and no buffered drain. An append-only negotiated 82-value interface may be available while production retains its 81-value packet. Do not expose sonic v2 before its algorithms exist.
2. **Accept MUB-3A measured analysis.** Add cancellable, bounded source identity, normalized spectral bands, feature windows and neutral sections/confidence through the job API. Retain the legacy Deep contract separately. Do not generate musical-role claims or enable automation from these summaries.
3. **Accept MUB-4A supported controls.** Expose band enable/type and limiter release through shared primitives. High-pass gain must be unavailable in the slider, pointer and keyboard paths because that filter does not use gain. Preserve the stored gain for other types.
4. **Reject completion substitutes.** Removing unsupported DSP guards, naming filter bands as instruments, restoring fabricated observations, copying hardware names or merely matching macro labels cannot satisfy the request.

## Verification record

Baseline TypeScript, configured ESLint and knip exited 0. Baseline Vitest exited 0: 18 files, 275 tests. DSP council ran native DSP/WASM package tests; backend council ran jobs/server/mastering race tests successfully after using writable temporary Go caches. No baseline HTTP, fresh browser or all-product completion claim follows from those results.

### Implemented bounded wave and retained failures

MUB-2A now preserves algorithm 1 and the production 81-value packet, exposes negotiated ABI 2 with explicit algorithm 1, rejects unsupported algorithms atomically and reports zero buffered latency/drain. MUB-3A now provides measured features through bounded cancellable jobs and the Deep original-source panel. MUB-4A exposes supported band type/enable and limiter release, with high-pass-specific semantics and a single selected 44 px chart target. Whole-product acceptance remains open.

The loop retained and corrected these failures:

- Initial white-noise low-band integration differed by about +0.88 dB; fractional bin overlap corrected bandwidth integration.
- The 192 kHz/90 Hz fixture missed power by 0.5687 dB with FFT 4096; rate-scaled resolution corrected it. Final FFT sizes are 1024–16384.
- Hann windows without overlap lost boundary impulses: one impulse train reported −113.01 dBFS band power against a −36.12 dBFS raw RMS. Padded 75% overlap, hop-weighted global power and independent exact raw-energy windows corrected the coverage. Independent impulse-shift tests now differ from analytic band power by at most 0.0000404 dB on the declared corpus. Edge impulses, unusual 8001 Hz rate, subnormal/MaxFloat32 samples and DC-offset checks passed.
- The first measured-analysis browser run was 0/2 because the client expected `completed`/`canceled`; the native API uses `done`/`cancelled`. The real API contract and fixtures were corrected.
- Cancel initially waited for held admission. The corrected UI detaches immediately while eventual admission is deleted. An independent actual-browser probe restored controls in 60 ms before release, completed a distinct retry while the old response stayed held, and preserved the new result after deleting the old job. Settings remained unchanged.
- Mobile EQ targets overlapped at 320 px; only the selected marker is now interactive, with equivalent band buttons and fields. An incorrect high-shelf test oracle and a circular-target corner probe were corrected separately without changing production audio.
- The first integrated 61-case browser suite passed 60; a stale disclosure-text assertion was updated. The next run passed 60 but exposed a phase-dependent Tape Warmth measurement. On the declared 44.1 kHz probe, 1024-frame neutral RMS spans about 0.0586 dB; full-period live Tape delta was −0.0946734 dB and native delta −0.0953524 dB. Test-only full-period observation retained the >0.08 dB requirement. Two predetermined complete shortcut sets passed 8/8 in 87.578 seconds without retries; the final complete suite passed 61/61 in 3.1 minutes.
- An initial target-lint command attempted to execute a cross-compiled linter. The native linter reran both WASM-target checks with zero issues. No production defect is inferred from that tool invocation.

### Current observed integrated evidence

Runtime source: `fd782c9`, with subsequent test/comment/documentation commits. Tested binary SHA-256: `8552941fc6e8b3d9b95fe2ecd378c539f3fe24b7fecf2521741fc1582b410171`. The primary checkout remains clean on main; changes are isolated in `codex/product-completion`.

| Tier | Observed result |
| --- | --- |
| unit/static | TypeScript, configured lint, knip, 302 frontend units across 20 files, strict typing for new E2E files and 146-file spelling passed. Go format/modules/vet/exact lint 2.15/identifiers/vulnerability/full race passed after the overlap correction; both WASM target lint checks passed. |
| wasm-bridge | All 333 frozen native fixtures matched exactly through legacy JSON, direct and restricted WASI paths; ABI 2/algorithm 1 also matched, with malformed-packet atomicity, nine history transitions and zero buffered drain. |
| independent metering | 15 FFmpeg comparisons passed: maximum 0.0542 LU loudness and 0.0312 dB peak error on the declared corpus. This does not certify the limiter. |
| newman-e2e / api-curl | Final 22 requests / 27 assertions and raw Host/Origin/oversize probes passed, including new measured-analysis lifecycle cases. Frequency decomposition in legacy tests is not trained separation. |
| compiled-binary-smoke | Dual-module production build and empty-directory embedded smoke passed. |
| playwright-a11y-responsive | New measured-analysis and supported EQ/limiter cases passed, including six generated-result widths and twelve populated EQ states. Final complete suite exited 0: 61/61 in 3.1 minutes after the full-period observer correction, on the same tested binary. Prior 60/61 failures remain above. |

Independent QA/Devil’s Advocate accepted the corrected measured-feature mathematics, source identity, bounded retention/cancellation and supported controls at their scoped checkpoints. Technical Writer/Product Engineer identified documentation corrections now applied. Final local browser acceptance passed. Technical Writer accepted contract accuracy and Product Engineer accepted the atomic commit structure; the final synchronized evidence received their review. Remote checks must pass before owner merge and are tracked in the pull request. Status remains open — awaiting merge. Four loop iterations cover review/implementation, UI/calibration correction, integrated adversarial tests and Hann/observer correction; no all-product completion is claimed.

Remote checkpoint: [PR run 39836685651](https://github.com/yegamble/aurialis-WASM/actions/runs/39836685651) passed every verification job except the browser job, which finished 60/61. Its measured-analysis case passed all diagnostics and six-width accessibility assertions, then failed writing a screenshot to macOS-only `/private/tmp` on Linux. The test now uses Playwright’s per-test output directory; no application code, assertion or threshold changed. Strict typing/spelling and the corrected two-case browser run passed (2/2 in 6.1 seconds). Corrected remote acceptance remains pending in PR checks; the earlier local 61/61 checkpoint is retained separately.

## Merge and delegated continuation — October 23, 2026

Corrected [CI run 39838476152](https://github.com/yegamble/aurialis-WASM/actions/runs/39838476152) passed all jobs at exact head `8fd8877268308ba079416142e8ebf1ba109bbf9a`: 61 Linux browser cases in 5.0 minutes, 22 Newman requests/27 assertions plus raw probes, and the Go/WASM, frontend, hygiene and aggregate gates. PR #6 merged to main as `388653635a4911b66786c672b2551cde235f7b4a`; its feature branch was deleted locally and remotely. Earlier pending statuses in this chronological record describe their checkpoints.

The owner authorized continuing the whole-product loop with delegated merges until all planned features and remaining Waves acceptance work pass. That instruction supersedes the default four-iteration stop and owner merge gate. It does not waive verification or establish whole-product completion.

## Sources and limits

Official [Waves getting-started guidance](https://www.waves.com/support/waves-online-mastering-getting-started) describes style/tone/reference controls and optional volume matching. It does not publish the mastering model or establish equivalent sound in this project. Preserve the previously recorded Aurialis A/B preference unless the owner changes it. The canonical [upgrade specification](../design/waves-parity-and-hardware-emulation-spec.md) supplies proposed measurable tolerances; passing existing tests does not prove those unimplemented targets.
