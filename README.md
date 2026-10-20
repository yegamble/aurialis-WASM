# Aurialis-WASM

**Single-Binary Go 1.26 + Next.js 16 + WebAssembly (WASM) Audio Mastering Workstation**

Based on [Aurialis](https://aurialis.yosefgamble.com/) ([`yegamble/Aurialis`](https://github.com/yegamble/Aurialis)) and the warm editorial redesign specification in [`docs/design/aurialis-redesign.md`](docs/design/aurialis-redesign.md).

---

## Architecture & Stack

Aurialis-WASM consolidates the entire audio mastering stack into a **single compiled Go executable** (`aurialis`) with an ultra-low-bundle, mobile-first Next.js 16 frontend:

- **Single Binary Host (`cmd/aurialis`, `internal/`)**:
  - Go `1.26.2` HTTP/API server embedding compiled Next.js 16 static/standalone assets and `.wasm` binaries via `//go:embed`.
  - Serves `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` so browser `SharedArrayBuffer` and `AudioWorklet` pipelines run at full native speed.
  - High-concurrency job manager (`internal/jobs`) using bounded worker pools, weighted semaphores, `context.Context` cancellation, and `sync.Pool` zero-copy Float32 buffers across simultaneous jobs.
  - In-house AI/LLM & deterministic `MasteringScript` v1 generator, Smart Stem Splitter (`2–6` stems), Reference Match, Album Consistency batch mastering, and Platform Release Check.
- **WebAssembly DSP Core (`wasm/dsp`, `public/worklets/`)**:
  - Compiled from Go (`GOOS=js GOARCH=wasm` / `GOOS=wasip1 GOARCH=wasm`) with zero per-block heap allocations: 5-band biquad parametric EQ, compressor, true-peak limiter, harmonic saturation, stereo width/mono-bass, and ITU-R BS.1770-4 LUFS / True-Peak / Dynamic Range / Stereo Correlation metering.
- **Low-Bundle, Mobile-First Frontend (`src/`)**:
  - **Next.js 16** (`^16.4.2`, App Router) + **React 19** + **TypeScript 5.8+** (`strict: true`), managed strictly with **`pnpm` (`10.33.0`)** on **Node.js `26.12.0`**.
  - **Tailwind CSS v4** with HCL/OKLCH-calibrated warm editorial tokens (`--canvas`, `--paper`, `--ink`, `--clay`, `--moss`, `--ochre`, `Newsreader` + `Instrument Sans` + `tabular-nums`).
  - **Custom Inline SVGs Only**: Zero external icon libraries (`lucide-react`, `@heroicons`, `react-icons` are banned) and aggressive reuse of shared primitives (`Button`, `Icon`, `SliderField`, `SegmentedControl`, `Toggle`, `Modal`, `BottomSheet`, `StatusBadge`, `DropZone`, `Waveform`, `SpectrumChart`, `DeepTimeline`, `Transport`, `MetricStrip`).
  - **Mobile-First & Responsive (`320px–1440px+`)**: Designed for `320px–390px` phones first (top bar, 4-item bottom nav, sticky mini-transport, bottom-sheet editors, `>=44×44px` touch targets) and scaled cleanly to tablet (`768px`) and desktop workstation (`1024px–1440px+`) with full WCAG 2.2 AA & keyboard-only operability.

---

## Multi-Model War Room (`war-room` & `war-room-loop`)

This repository ships a 7-seat adversarial War Room configured to run across **Gemini Argon (Google Antigravity / Gemini CLI)**, **Claude Code**, and **OpenAI Codex**:

| Agent ID | Role | Focus |
|---|---|---|
| [`aurialis-backend`](.claude/agents/aurialis-backend.md) | **Backend Engineer** | Go 1.26, TypeScript, WASM (`GOOS=js`/`wasip1`), single-binary embedding, concurrent job optimization, in-house audio/AI mastering infrastructure. |
| [`aurialis-frontend`](.claude/agents/aurialis-frontend.md) | **Senior Frontend Engineer** | Next.js 16, strict TypeScript, Tailwind CSS v4, custom inline SVGs (no icon libraries), mobile-first responsive UI, component reuse. |
| [`aurialis-designer`](.claude/agents/aurialis-designer.md) | **UI/UX Designer** | WCAG 2.2 AA & APCA accessibility, interactive state matrices, HCL/OKLCH perceptual color, mobile-first (`320px–1440px+`) & Figma skills. |
| [`aurialis-qa`](.claude/agents/aurialis-qa.md) | **QA Tester** | Adversarial code breaker using Postman/Newman (`TS-001`–`TS-013+`), raw `curl` probes, Vitest, and Playwright. Collaborates with Devil's Advocate. |
| [`aurialis-devils-advocate`](.claude/agents/aurialis-devils-advocate.md) | **Devil's Advocate** | Challenges whether features work properly, whether they are needed or bloat, and shoots down premature completion claims. |
| [`aurialis-tech-writer`](.claude/agents/aurialis-tech-writer.md) | **Technical Writer** | Keeps `README.md`, [`docs/api.md`](docs/api.md), [`docs/architecture.md`](docs/architecture.md), [`docs/tasks.md`](docs/tasks.md), and [`.claude/war-room/ledger.md`](.claude/war-room/ledger.md) synchronized with code. |
| [`aurialis-product-engineer`](.claude/agents/aurialis-product-engineer.md) | **Product Engineer** | Enforces product requirements, small readable commits, peer-agent review, Technical Writer doc sync, and "finished means merged". |

### Running the War Room

```text
# Review & rule on a specific feature or CI/CD pipeline (no code edits):
/war-room feature=deep-mastering
/war-room feature=smart-split
/war-room ci-cd

# Run the pessimistic implementation & scrutiny loop until 100% verified:
/war-room-loop feature=wasm-dsp max-iterations=4
/war-room-loop ci-cd
/war-room-loop all max-iterations=4 merge=owner
```

After editing any canonical agent in `.claude/agents/aurialis-*.md`, synchronize the Gemini Argon / Antigravity and OpenAI Codex agent definitions via:

```bash
python3 scripts/sync-agents.py
```

---

## Fail-Fast Quality Gates

Always ensure Node `26.12.0` (`$HOME/.nvm/versions/node/v26.12.0/bin`) and Go `1.26.2` are on `PATH`:

```bash
export PATH="$HOME/.nvm/versions/node/v26.12.0/bin:$PATH"

# 1. Go & WASM Gate (.golangci.yml v2: staticcheck all, revive, gosec, nakedret, misspell, dupword)
"$(go env GOROOT)/bin/gofmt" -l cmd internal wasm
go mod verify
go vet ./...
golangci-lint run ./...
identypo ./...
govulncheck ./...
go test -race -count=1 ./...
GOOS=js GOARCH=wasm go build -trimpath -o public/wasm/aurialis-dsp.wasm ./wasm/dsp

# 2. Next.js 16 / TypeScript Gate (pnpm only)
pnpm exec tsc --noEmit
pnpm run lint
pnpm exec knip
pnpm exec cspell lint "**/*.{ts,tsx,go,md}"
pnpm test
pnpm run build

# 3. API (Postman/Newman + cURL) & Playwright Responsive/A11y Gate
MAX_UPLOAD_BYTES_OVERRIDE=209715200 pnpm run test:backend:postman
pnpm exec playwright test
```

---

## Documentation Index

- [`AGENTS.md`](AGENTS.md) — Universal agent rules, stack invariants, and verification gates.
- [`.claude/agents/README.md`](.claude/agents/README.md) — War Room roster and panel selection guide.
- [`.claude/war-room/protocol.md`](.claude/war-room/protocol.md) — Rounds 0–E protocol, QA ↔ Devil's Advocate break-testing, and Technical Writer / Product Engineer gates.
- [`.claude/war-room/cross-model-guide.md`](.claude/war-room/cross-model-guide.md) — Best practices for Gemini Argon, Claude Code, and OpenAI Codex + Go/TypeScript linter mapping.
- [`.claude/war-room/ledger.md`](.claude/war-room/ledger.md) — Persistent War Room backlog and iteration log.
- [`docs/architecture.md`](docs/architecture.md) — Single-binary Go + Next.js 16 + WASM technical architecture.
- [`docs/api.md`](docs/api.md) — HTTP/JSON API contract and Postman/Newman test suite (`TS-001`–`TS-013`).
- [`docs/tasks.md`](docs/tasks.md) — Developer task tracker synchronized by `aurialis-tech-writer`.
- [`docs/design/aurialis-redesign.md`](docs/design/aurialis-redesign.md) — Warm editorial UI/UX & HCL/OKLCH design specification.
