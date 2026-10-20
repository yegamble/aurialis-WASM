# War-Room Finding Format — Every Seat Uses Exactly This

One structured block per finding. No loose prose essays. This shared schema lets the **Backend Engineer**, **Senior Frontend Engineer**, **UI/UX Designer**, **QA Tester**, **Devil's Advocate**, **Technical Writer**, and **Product Engineer** debate the exact same object across **Gemini Argon**, **Claude Code**, and **OpenAI Codex**.

```text
FINDING <seat>-<n>: <concise one-line title>
Severity:    BLOCKER | REQUIRED | SHOULD | EXPERIMENT | NIT
Confidence:  high | medium | low
Area:        go-backend | wasm-dsp | ai-mastering | nextjs-ui | mobile-responsive | a11y-hcl | qa-newman | docs | git-ci

Affected:
  files:     path:line, path:line — real files you opened and inspected

Observed:
  Concrete evidence from the codebase, binary, DOM, or HTTP response. Quote the line,
  symbol, curl output, or contrast ratio. Anything you did not verify directly in this
  session MUST be written as "UNVERIFIED: <what and why>", never asserted as fact.

Failure:
  What is broken, missing, unoptimized, non-responsive, inaccessible, bloated, or
  undocumented — and the concrete consequence for the user, audio signal, bundle, or CI.

Perspective:
  audio-creator | mobile-user | keyboard-screenreader-user | developer | operator | qa-breaker | devils-advocate

Recommendation:
  The smallest coherent change that closes the failure while reusing existing components
  and packages. Not a speculative rewrite.

Acceptance criteria:
  Observable, falsifiable conditions that QA and Devil's Advocate can verify without
  reading your prose report.

Tests:
  Named test file and case in the repo's idiom:
  - Go unit/race test (`internal/.../*_test.go`, `go test -race`)
  - WASM bridge test (`wasm/dsp/*_test.go` or `src/lib/audio/__tests__/*.test.ts`)
  - Postman/Newman case (`tests/postman/aurialis-backend.postman_collection.json` TS-XXX)
  - Reproducible `curl` command against `127.0.0.1:<port>`
  - Vitest component test (`src/components/**/__tests__/*.test.tsx`)
  - Playwright E2E / responsive (`320px–1440px`) / axe a11y spec (`e2e/*.spec.ts`)

Docs impact:
  Which files `aurialis-tech-writer` must update (`README.md`, `docs/api.md`,
  `docs/architecture.md`, `docs/tasks.md`, `.claude/war-room/ledger.md`) — or "none".

Evidence tier:
  The strongest tier that currently proves or repros this area:
  unit | wasm-bridge | api-curl | newman-e2e | playwright-a11y-responsive | compiled-binary-smoke

Challenge:
  The strongest counterargument to your own finding — the exact point you expect
  another War Room seat or Devil's Advocate to attack in Round B.
```

---

## Severity Definitions (Shared, Non-Negotiable)

- **BLOCKER** — Do not merge or release:
  - Audio corruption, clipping/NaN in DSP/WASM output, goroutine race/deadlock, or OOM under concurrent jobs.
  - External icon library (`lucide-react`, etc.) or `npm`/`yarn` lockfile introduced.
  - Missing COOP/COEP headers breaking `SharedArrayBuffer` / `AudioWorklet`.
  - Unusable mobile layout (`320px–390px` horizontal overflow, unreachable transport/controls) or critical WCAG 2.2 AA / keyboard trap failure.
  - Security bypass (unbounded upload size, path traversal `../`, CRLF injection, command injection).
  - Broken build or red CI gate.
- **REQUIRED** — The feature or vertical slice is incomplete without it:
  - A UI control that looks interactive but is disconnected from state/DSP/API.
  - A backend endpoint with no reachable UI, or a UI workflow with no working Go/WASM handler.
  - Duplicated UI component where a shared primitive (`Button`, `SliderField`, `Modal`, etc.) should be reused.
  - Missing mobile bottom-sheet / touch alternative for a desktop drag interaction (`WCAG 2.5.7`), or touch targets `< 44×44px`.
  - Code or API change with out-of-date `README.md`, `docs/api.md`, `docs/architecture.md`, or `docs/tasks.md`.
  - Uncommitted or unmerged finished work sitting on a stale branch, or a giant unreviewable mega-commit.
- **SHOULD** — A measurable engineering, UX, latency, or bundle-size improvement worth scheduling in the ledger.
- **EXPERIMENT** — A plausible DSP, AI-mastering prompt/heuristic, or WASM optimization hypothesis; must name the benchmark or test that will settle it.
- **NIT** — Correct but minor. Maximum **3 NITs per seat** per session.

---

## Rules of Evidence

1. **Cite files you actually opened**: A finding without `path:line` is an opinion, not a finding — mark it `Confidence: low`.
2. **Distinguish simulation from real DSP/WASM**: Never claim a feature performs real audio processing if it only mutates UI numbers over an unchanged source `Blob`.
3. **Distinguish lifecycle states**: `implemented (branch)` ≠ `merged (main)` ≠ `verified (QA + Devil's Advocate)` ≠ `released (binary)`.
4. **Never fabricate test execution**: If you did not run a command in this session, mark its result `UNVERIFIED`.
