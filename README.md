# Aurialis-WASM
<!-- cspell:words Embedder trimpath goroutines scrutinise -->

**Single-Binary Go 1.26 + Next.js 16 + WebAssembly (WASM) Audio Mastering Workstation**

Based on [Aurialis](https://aurialis.yosefgamble.com/) ([`yegamble/Aurialis`](https://github.com/yegamble/Aurialis)) and the warm editorial redesign specification in [`docs/design/aurialis-redesign.md`](docs/design/aurialis-redesign.md).

---

## Current behavior and limits

This is an unfinished workstation undergoing corrective recovery. [The audit](docs/reviews/2026-10-21-war-room-audit.md) records the reproduced failures; [the task tracker](docs/tasks.md) separates implemented behavior from outstanding product requirements. The earlier corrective checkpoint is locally verified and **open — awaiting merge**. The live-playback follow-up below is being integrated; fresh application-level audio capture, binary and gate results are pending. Full-product delivery and owner merge remain open.

- The production library starts empty. Import your own PCM WAV; legacy example projects and fabricated analysis/stem results are discarded during migration. The Go server validates and reconstructs audio before it is stored in IndexedDB. Project metadata/settings use localStorage, with an in-memory audio fallback and warning when persistent storage fails.
- Advanced mode offers independent input, five-band EQ, compressor, saturation, stereo and sample-limiter controls. The live path runs shared Go WASM DSP in a worker and sends bounded audio blocks through SharedArrayBuffer to a nonblocking AudioWorklet. Export still renders the current settings through native Go at the source rate in 16/24-bit PCM or 32-bit float WAV.
- Simple genre, tone and intensity changes update live processing while you listen. **Apply master direction** explicitly measures the output target for export and a downloadable offline preview; it reports an unreachable target. Advanced processing adds no hidden normalization. **Apply profile** updates the live chain with one of five static presets; musical analysis, timeline automation and AI repair remain unavailable.
- **A Processed** is the default listening state; **B Original** selects the aligned dry source. Both share one playback clock, with an approximately 80 ms aligned processing buffer and an 8 ms transition. There is no Match level option or automatic A/B gain matching. Sample peak, RMS, crest factor, correlation and the 4096-point live spectrum describe the actual audible output; played waveform sections use the clay accent.
- Albums render actual per-track 24-bit WAV artifacts for download while preserving the original uploads. The browser output cache is bounded; broader album consistency and batch recovery requirements remain open. Reference direction blends another project's EQ settings with effective low-band/width options; it does not analyze or match recorded reference spectra.
- Release diagnostics measure actual rendered output with native loudness, reconstructed-peak, sample-peak, crest and correlation meters. Streaming, Dynamic and Spoken word are working targets, not platform delivery certification. Smart Split identifies validated instrument separation as unavailable; its old timer-driven success path is removed.

Imports are bounded to **128 MiB plus the 44-byte canonical WAV header** and **16,777,216 decoded frames** (about 5 min 50 s at 48 kHz or 2 min 55 s at 96 kHz; byte limits can be stricter). The multipart request ceiling is 129 MiB, including canonical float WAV and form overhead. One expensive audio request runs at a time; busy requests return a retryable response. Album output cache is limited to 128 MiB total and lasts only while its page remains open; changing the sequence or processing settings invalidates the downloads. These are finite workstation limits, not unlimited batch capacity.

The live graph resamples to the device AudioContext rate when it differs from the source; live and native exports are not claimed sample-identical across rates. Validated hardware fidelity, trained separation, source-derived AI analysis, timeline automation and certified true-peak limiting remain open. The native binary embeds the frontend, WASM and matching Go browser runtime. Fonts are self-hosted.

Cached canonical stereo-float WAV audio is loaded locally after strict size, structure and finite-sample checks; legacy sources with another WAV layout fall back to Go reconstruction. Missing or failed sources disable playback/A/B and expose retry controls. Each mounted track gets a fresh audio context and worker, and navigation disposes the old graph. Connection and interrupted-response errors identify the local server and preserve cancellation. The cause of the user-reported “Failed to fetch” remains unverified; fresh successful requests do not identify the earlier failure.

## Quickstart & Single-Binary Build

Use Node `26.12.0`, `pnpm@10.33.0`, Go `1.26.10`, Next.js 16 and React 19, as pinned by this repository. Dependency installation uses pnpm only.

```bash
export PATH="$HOME/.nvm/versions/node/v26.12.0/bin:$PATH"
pnpm install --frozen-lockfile
pnpm run build:binary
pnpm run test:binary
./aurialis -addr 127.0.0.1:8080 -workers 4
```

Open [http://127.0.0.1:8080](http://127.0.0.1:8080). `build:binary` compiles the browser WASM module, copies Go's matching `wasm_exec.js`, builds and synchronizes the static frontend, then builds the host. `pnpm start` runs the built `./aurialis` executable. `test:binary` starts that executable from an empty temporary directory and checks embedded assets and API behavior. A plain `go build` does not rebuild frontend assets.

For integrated local development, run `pnpm dev` and open [http://127.0.0.1:3000](http://127.0.0.1:3000). This command rebuilds and serves the same Go application, including its APIs and isolation headers. Restart it after source changes; it does not provide hot reload. Running Next.js by itself does not provide the Go processing API.

| Flag | Default | Environment override | Meaning |
|---|---|---|---|
| `-addr` | `127.0.0.1:8080` | `AURIALIS_ADDR`, then `PORT` | HTTP listen address; environment takes precedence over flag. A numeric `PORT` uses loopback; non-loopback addresses are rejected. |
| `-workers` | `0` (auto) | — | Worker count; see current bounds in [`docs/architecture.md`](docs/architecture.md). |
| `-max-upload-bytes` | 129 MiB | `MAX_UPLOAD_BYTES_OVERRIDE` | Multipart request body ceiling, including fields and boundaries; overrides can lower the hard 129 MiB cap. This does not increase the browser's 128 MiB plus 44-byte file limit. |

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

Always ensure Node `26.12.0` (`$HOME/.nvm/versions/node/v26.12.0/bin`) and Go `1.26.10` are on `PATH`:

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
pnpm run test:wasm
pnpm run test:meters

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

## Verification status

Gate commands above are requirements, not claims of passing CI. See [`docs/tasks.md`](docs/tasks.md) and [the ledger](.claude/war-room/ledger.md) for current-session execution evidence and open blockers. The earlier blocked vulnerability lookup was superseded by a successful Go 1.26.10 `govulncheck ./...` run reporting no vulnerabilities. Final local results and failed attempts are recorded in the task tracker; remote PR checks and owner merge remain outstanding. A passing browser smoke test does not certify analog hardware fidelity, codec support, platform release compliance or all accessibility interactions.

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

