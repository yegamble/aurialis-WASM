# Aurialis-WASM
<!-- cspell:words Embedder trimpath goroutines scrutinise -->

**Single-Binary Go 1.26 + Next.js 16 + WebAssembly (WASM) Audio Mastering Workstation**

Based on [Aurialis](https://aurialis.yosefgamble.com/) ([`yegamble/Aurialis`](https://github.com/yegamble/Aurialis)) and the warm editorial redesign specification in [`docs/design/aurialis-redesign.md`](docs/design/aurialis-redesign.md).

---

## Architecture & Stack

Aurialis-WASM consolidates the entire audio mastering stack into a **single compiled Go executable** (`aurialis`) with an ultra-low-bundle, mobile-first Next.js 16 frontend:

- **Single Binary Host (`cmd/aurialis`, `internal/`)**:
  - Go `1.26.2` HTTP/API server embedding compiled Next.js 16 static assets and `.wasm` binaries via `//go:embed all:embedded` in `internal/webui`.
  - Serves `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` headers so browser `SharedArrayBuffer` and `AudioWorklet` run with hardware-level isolation.
  - High-concurrency job manager (`internal/jobs`) using bounded worker pools, `context.Context` cancellation, zero-copy `sync.Pool` Float32 buffers, and 5 lifecycle states (`queued`, `running`, `done`, `cancelled`, `failed`) with `?wait=1` long-polling.
  - In-house AI/LLM & deterministic `MasteringScript` v1 generator across 5 engineer profiles (`Warm Analog`, `Punchy Commercial`, `Dynamic & Open`, `Vocal Forward`, `Bass Heavy` plus UI aliases), Smart Stem Splitter (`2–6` stems), Reference Match, Album Consistency batch mastering, and Platform Release Check.
- **WebAssembly DSP Core (`wasm/dsp`, `public/worklets/`)**:
  - Compiled from Go (`GOOS=js GOARCH=wasm` / `GOOS=wasip1 GOARCH=wasm`) with zero per-block heap allocations: 5-band ZDF/TPT SVF parametric EQ, program-dependent optical/FET/VCA compressor with 90 Hz sidechain HPF, 4× oversampled ITU-R BS.1770-4 True-Peak lookahead limiter, ADAA + oversampled `Warm`/`Thick`/`Crisp` saturation, Linkwitz-Riley mono-bass + M/S width, and TPDF dither.
- **Low-Bundle, Mobile-First Frontend (`src/`)**:
  - **Next.js 16** (`^16.4.2`, App Router, 9 dedicated routes) + **React 19** + **TypeScript 5.8+** (`strict: true`), managed strictly with **`pnpm` (`10.33.0`)** on **Node.js `26.12.0`**.
  - **Tailwind CSS v4** with HCL/OKLCH-calibrated warm editorial tokens (`--canvas`, `--paper`, `--ink`, `--clay`, `--moss`, `--ochre`, `Newsreader` + `Instrument Sans` + `tabular-nums`).
  - **Custom Inline SVGs Only**: Zero external icon libraries (`lucide-react`, `@heroicons`, `react-icons` are banned) and aggressive reuse of shared primitives (`Button`, `Icon`, `SliderField`, `SegmentedControl`, `Toggle`, `Modal`, `BottomSheet`, `StatusBadge`, `DropZone`, `Waveform`, `SpectrumChart`, `DeepTimeline`, `Transport`, `MetricStrip`).
  - **State Reducer Control Isolation**: `src/lib/store.tsx` enforces per-module action dispatches so changes to one DSP module never mutate adjacent parameters.
  - **Client DSP & WAV Export**: `src/lib/audio-dsp.ts` provides real-time client DSP preview and 16/24/32-bit TPDF-dithered WAV audio export.
  - **Mobile-First & Responsive (`320px–1440px+`)**: Designed for `320px–390px` phones first (top bar, 4-item bottom nav, sticky mini-transport, bottom-sheet editors, `>=44×44px` touch targets) and scaled cleanly to tablet (`768px`) and desktop workstation (`1024px–1440px+`) with full WCAG 2.2 AA & keyboard-only operability.

---

## Quickstart & Single-Binary Build

### 1. Build the Single Self-Contained Binary

Ensure Node `26.12.0` and Go `1.26.2` are on `PATH`:

```bash
export PATH="$HOME/.nvm/versions/node/v26.12.0/bin:$PATH"

# Step A: Compile Go WebAssembly DSP module
GOOS=js GOARCH=wasm go build -trimpath -o public/wasm/aurialis-dsp.wasm ./wasm/dsp

# Step B: Build Next.js 16 static export & sync to internal/webui
pnpm install --frozen-lockfile
pnpm run build
node scripts/sync-webui.mjs

# Step C: Compile native host binary embedding Next.js & WASM assets
go build -o aurialis ./cmd/aurialis

# Step D: Launch single binary on localhost
./aurialis -addr 127.0.0.1:8080 -workers 4 -max-upload-bytes 209715200
```

Open `http://127.0.0.1:8080` in any modern browser.

### 2. CLI Flags & Environment Variables

| Flag | Default | Environment Override | Description |
|---|---|---|---|
| `-addr` | `127.0.0.1:8080` | `AURIALIS_ADDR` or `PORT` | HTTP listen address (bound to loopback by default for security). |
| `-workers` | `0` (auto) | — | Concurrent audio DSP worker goroutines (`0` detects CPU core count). |
| `-max-upload-bytes` | `209715200` (200 MB) | `MAX_UPLOAD_BYTES_OVERRIDE` | Maximum allowable multipart upload payload in bytes. |

---

## Multi-Model War Room (`war-room` & `war-room-loop`)

This repository ships an 11-seat adversarial War Room configured to run across **Gemini Argon (Google Antigravity / Gemini CLI)**, **Claude Code**, and **OpenAI Codex**:

| Agent ID | Role | Focus |
|---|---|---|
| [`aurialis-backend`](.claude/agents/aurialis-backend.md) | **Backend Engineer** | Go 1.26, TypeScript, WASM (`GOOS=js`/`wasip1`), single-binary embedding, concurrent job optimization, in-house audio/AI mastering infrastructure. |
| [`aurialis-frontend`](.claude/agents/aurialis-frontend.md) | **Senior Frontend Engineer** | Next.js 16, strict TypeScript, Tailwind CSS v4, custom inline SVGs (no icon libraries), mobile-first responsive UI, component reuse. |
| [`aurialis-designer`](.claude/agents/aurialis-designer.md) | **UI/UX Designer** | WCAG 2.2 AA & APCA accessibility, interactive state matrices, HCL/OKLCH perceptual color, mobile-first (`320px–1440px+`) & Figma skills. |
| [`aurialis-audio-engineer`](.claude/agents/aurialis-audio-engineer.md) | **Hardware & Physics Audio Engineer** | Vintage & modern audio hardware mechanics & physics (optical LA-2A, Variable-Mu Fairchild/Manley, FET 1176, VCA SSL/API/Shadow Hills, Pultec passive LC/tube EQ, Massive Passive proportional-Q, Ampex ATR-102 tape, iron transformers, True-Peak limiters) and objective acoustic verification specs. |
| [`aurialis-dsp-plugin-engineer`](.claude/agents/aurialis-dsp-plugin-engineer.md) | **Waves-Style DSP Plugin Engineer** | Digitizing analog hardware into ZDF/TPT filters, ADAA + polyphase oversampled tube/tape/transformer waveshaping, program-dependent ballistics, Linkwitz-Riley M/S mono-bass, 4× oversampled True-Peak limiting, TPDF dither, and beating the Waves workflow. |
| [`aurialis-grammy-veteran`](.claude/agents/aurialis-grammy-veteran.md) | **20+ Year Grammy Mastering Engineer (Target Audience)** | Studio veteran across Pop, Jazz, Rock, Metal, and Rap/Hip-Hop; evaluates genre translation, loudness-matched A/B honesty, ear fatigue, album sequencing cohesion, and whether Aurialis beats a Waves/hardware chain. |
| [`aurialis-security`](.claude/agents/aurialis-security.md) | **Cybersecurity Engineer** | Codebase security, host-machine protection for local users, Audio Content Disarm & Reconstruction (CDR), anti-polyglot/payload-stashing, DNS-rebinding & localhost CSRF defense. |
| [`aurialis-qa`](.claude/agents/aurialis-qa.md) | **QA Tester** | Adversarial code breaker using Playwright frontend E2E/responsive/a11y tests (`e2e/`), the War-Room Audio Transformation Verification Suite (`*_verify_test.go`), Postman/Newman (`TS-001`–`TS-015+`), raw `curl` probes, and Vitest. Collaborates with Devil's Advocate, Audio/DSP Engineers, & Cybersecurity Engineer. |
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

# 2. Next.js 16 / TypeScript & Vitest Gate (pnpm only)
pnpm exec tsc --noEmit
pnpm run lint
pnpm exec knip
pnpm exec cspell lint "**/*.{ts,tsx,go,md}"
pnpm test
pnpm run build

# 3. Backend API Gate (Newman TS-001..TS-015 + raw cURL 413 & DNS-rebinding probes)
pnpm run test:backend:postman

# 4. Playwright Responsive (320px–1440px), WCAG 2.2 AA axe, Control-Isolation & WAV Export Gate
pnpm exec playwright test

# 5. Multi-Model War Room Agent Sync Gate
python3 scripts/sync-agents.py --check
```

### GitHub Actions CI/CD (`.github/workflows/ci.yml`)

Every commit pushed to any branch (`branches: ['**']`) and every pull request triggers [`.github/workflows/ci.yml`](.github/workflows/ci.yml) with all skip guards removed so all quality gates run unconditionally:
1. **`repo-and-agent-hygiene`** — Enforces `pnpm`-only lockfiles, bans external icon libraries in `src/`, verifies multi-model agent synchronization (`python3 scripts/sync-agents.py --check`), smoke-tests `.claude/hooks/scrutinise.py`, and validates GitHub Actions YAML with `actionlint`.
2. **`go-wasm`** — Runs `gofmt`, `go mod verify`, `go vet`, `golangci-lint` v2, `identypo`, `govulncheck`, `go test -race`, and `GOOS=js GOARCH=wasm` compilation.
3. **`frontend-quality`** — Runs `pnpm install --frozen-lockfile`, `tsc --noEmit`, `pnpm run lint`, `knip`, `cspell`, `pnpm test`, and `pnpm run build`.
4. **`backend-newman`** — Runs `pnpm run test:backend:postman` executing Newman `TS-001`–`TS-015` and raw `curl` 413 / DNS-rebinding probes against a live single binary.
5. **`playwright-e2e`** — Runs mobile-first responsive (`320px`–`1440px`), axe WCAG 2.2 AA, control-isolation, and WAV export verification.
6. **`ci-passed`** — Unified gate that fails if any upstream job fails or is cancelled.

---

## Honest Implementation Caveats & Known Discrepancies

1. **Client TS DSP vs. Go/WASM Reference Engine**: The browser client includes a per-sample TypeScript DSP chain (`src/lib/audio-dsp.ts`) featuring a 1-pole mono-bass crossover and sample-peak limiter for low-latency interactive UI adjustments, whereas the Go/WASM engine (`internal/audio/dsp`, `wasm/dsp`) is the calibrated reference implementation featuring ZDF/TPT SVF filters, 4th-order Linkwitz-Riley crossover, and 4× oversampled True-Peak limiting.
2. **AudioWorklet Live Playback**: Interactive preview playback currently runs through `HTMLAudioElement` and client TypeScript DSP; routing real-time browser playback directly through the compiled WASM `AudioWorklet` processor (`public/worklets/aurialis-dsp-worklet.js`) is scheduled for a subsequent integration slice.
3. **Simple-Mode Metrics Estimation**: Simple-mode UI metrics are parameter-estimated approximations rather than measured directly from decoded PCM waveforms.
4. **Vulnerability Gate (`govulncheck`)**: `govulncheck ./...` reports Go standard library finding `GO-2026-6617` on Go `1.26.2`, which is remediated in Go `1.26.9`.

---

## Documentation Index

- [`AGENTS.md`](AGENTS.md) — Universal agent rules, stack invariants, and verification gates.
- [`.claude/agents/README.md`](.claude/agents/README.md) — War Room roster and panel selection guide.
- [`.claude/war-room/protocol.md`](.claude/war-room/protocol.md) — Rounds 0–E protocol, QA ↔ Devil's Advocate break-testing, and Technical Writer / Product Engineer gates.
- [`.claude/war-room/cross-model-guide.md`](.claude/war-room/cross-model-guide.md) — Best practices for Gemini Argon, Claude Code, and OpenAI Codex + Go/TypeScript linter mapping.
- [`.claude/war-room/ledger.md`](.claude/war-room/ledger.md) — Persistent War Room backlog and iteration log.
- [`docs/architecture.md`](docs/architecture.md) — Single-binary Go + Next.js 16 + WASM technical architecture.
- [`docs/api.md`](docs/api.md) — HTTP/JSON API contract and Postman/Newman test suite (`TS-001`–`TS-015`).
- [`docs/tasks.md`](docs/tasks.md) — Developer task tracker synchronized by `aurialis-tech-writer`.
- [`docs/design/aurialis-redesign.md`](docs/design/aurialis-redesign.md) — Warm editorial UI/UX & HCL/OKLCH design specification.

