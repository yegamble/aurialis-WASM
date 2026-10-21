# Aurialis-WASM task tracker

The full product vision remains open. Current work targets `war-room/iter2-validation`, based on user branch `feat/war-room-iter1-vertical-slices` at `9880481`. No item below is verified and merged to main. Honest unavailable states prevent simulated processing claims but do not satisfy the original requirements.

| ID | Priority | Required capability | Current behavior | Status |
|---|---|---|---|---|
| WASM-1 | P0 | Self-contained Go/Next.js/WASM binary with isolation headers | Fresh asset build and empty-directory binary smoke available; security and final CI gates still apply | open — awaiting merge |
| WASM-2 | P0 | Warm editorial design; shared SVG primitives; mobile/desktop layout; accessible interactions and color | Existing shell and expanded responsive/axe coverage; full design fidelity, all touch targets and interactive keyboard journeys still require review | open |
| WASM-3 | P0 | Physically verified hardware-inspired DSP; continuous AudioWorklet/SharedArrayBuffer bridge; true-peak limiter; anti-aliasing and audio verification | Native/shared Go WASM processing, strict params, safety and parity tests; offline preview only. No hardware or true-peak certification | open |
| WASM-4 | P1 | Bounded concurrent jobs, secure audio reconstruction, cancellation, cleanup and resource admission | Hard upload/frame limits, concurrent request and job memory bounds, expiration and strict local authority checks; full security gate still required | open — awaiting merge |
| WASM-5 | P1 | Real upload/library persistence, error/relink/quota states, mobile/desktop interaction | WAV import canonicalized by Go; IndexedDB source and localStorage metadata; storage warning and missing-source handling. Other browser codecs and full metadata persistence requirements remain open | open — awaiting merge |
| WASM-6 | P1 | Mastering workspace: transport, waveform, Simple and Advanced, real source WAV export, honest A/B | Advanced source render/preview/export path; Simple unavailable; explicit preview render and no loudness-matched A/B. Full original workspace requirements remain open | open |
| WASM-7 | P1 | Five-profile Deep MasteringScript v1; musical sections; five editable automation lanes; effective AI repair; backend/WASM/UI integration | UI unavailable; experimental deterministic energy heuristics and script types remain backend-only. No AI/LLM inference or validated repair | open |
| WASM-8 | P1 | Exact 2–6 trained/validated stem separation, controls, downloads, count change confirmation and mastering handoff | UI unavailable; backend frequency decomposition uses instrument labels without trained source isolation | open |
| WASM-9 | P2 | Album ordering/consistency processing; Reference Match; six-platform measured Release Check | Routes show unavailable states; original album/reference/release workflows remain unimplemented | open |
| WASM-10 | P1 | All required CI, Go/WASM/frontend/static/API/browser/packaging gates green | Build packaging improved and mandatory checks retained; no current green remote CI assertion; vulnerability database access blocked | open |

## Current-session evidence

The Chair executed the integrated Go/static gates at `24137c4` and final browser/build/frontend checks at `c3c15c9`, reporting the following results. Evidence is scoped to these commands and selected fixtures, not a certification of every product requirement. These changes remain unmerged.

| Evidence tier / gate | Observed result |
|---|---|
| Go static / `unit` | `go mod verify`, `go vet ./...`, `identypo ./...`, `golangci-lint run ./...` (0 issues), corrected gofmt check and `go test -race -count=1 ./...` passed. |
| Frontend static / `unit` | Strict TypeScript, typed ESLint, knip and Vitest passed (13 tests in 3 files). |
| `wasm-bridge` | `pnpm run test:wasm` passed 15 real compiled WASM/native parity fixtures, bit-identical output, plus adversarial bridge boundary cases. |
| External meter comparison | `pnpm run test:meters` / FFmpeg comparison passed 15 selected fixtures at 44.1/48/96 kHz: maximum 0.0542 LU loudness difference and 0.0312 dB peak difference. Abrupt 8 kHz boundaries can differ by 0.58 dB; formal certification remains open. |
| `compiled-binary-smoke` | `pnpm run build:binary` passed (24 static routes), then `pnpm run test:binary` served the application, WASM and API from an empty temporary directory. |
| Repository checks | Agent sync (11 agents), actionlint and cspell (77 files, zero issues) passed before this final documentation commit. |
| `newman-e2e` / `api-curl` | Final run passed 17 requests / 22 assertions and raw 413/foreign-Host probes after replacing an obsolete worklet request with the actual Go browser runtime asset. |
| `playwright-a11y-responsive` | Final run passed 14/14 tests at `c3c15c9`, covering six viewport sizes (320/375/390/768/1024/1440), eight routes with axe checks, audio parity/headroom, persistence, control isolation and second-track behavior. Prior runs passed 6/14, 7/14 and 11/14; failures drove sizing, focus, contrast, CSP and navigation-name fixes. |
| Vulnerability gate | `govulncheck ./...` remains blocked by forbidden network access to `https://vuln.go.dev`; no current clean vulnerability scan is claimed. |

The original uploaded-export regression reproduced a synthetic two-second export (expected 48,000 frames, got 96,000). Further adversarial checks exposed float headroom clamping and PCM signature false positives; fixes preserve finite float headroom and inspect signatures only outside PCM payloads. Regression failures are part of the session evidence rather than passing feature claims. See [the ledger](../.claude/war-room/ledger.md) for session iterations and remaining requirements.

## Final review

The pending-preview track-switch concern was ruled out by code inspection: MasterView is keyed by the resolved track ID, so changing tracks remounts the view and its unmount cleanup aborts pending rendering.

QA approved the signed-zero expectation normalization in the float headroom regression; nonzero samples remain exact and non-finite decoder rejection is checked separately. Devil's Advocate reported no demonstrated blocker to this corrective PR, while the full product scope remains incomplete.

## Completion rule

Keep commits small and synchronize README/API/architecture/tasks/ledger with implementation. A slice remains open until applicable mandatory gates in [`AGENTS.md`](../AGENTS.md) pass, QA and Devil's Advocate review the actual behavior, and Product Engineer confirms merge readiness. Finished means merged to main; `open — awaiting merge` is not complete. Do not infer green CI or release status from local tests.
