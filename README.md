# Aurialis-WASM
<!-- cspell:words Embedder buildmode trimpath goroutines scrutinise untimed -->

**Single-Binary Go 1.26 + Next.js 16 + WebAssembly (WASM) Audio Mastering Workstation**

Based on [Aurialis](https://aurialis.yosefgamble.com/) ([`yegamble/Aurialis`](https://github.com/yegamble/Aurialis)) and the warm editorial redesign specification in [`docs/design/aurialis-redesign.md`](docs/design/aurialis-redesign.md).

---

## Current behavior and limits

Aurialis reconstructs local WAV audio, runs shared Go/WASI DSP directly in AudioWorklet and exports native rendered WAVs from one chain shared by Simple and Advanced. The earlier corrective packaged path passed unit/static/build checks, bounded Chromium/Brave playback and a recorded five-minute actual-song run in Brave. The corrected 39-case browser suite and all six remote CI jobs also passed at the recorded source checkpoint; these bounded observations do not certify physical-device or hard real-time behavior. The earlier corrective PR #2 was merged by the owner at `30f576f9` on 2026-10-22 UTC. The owner merged the expanded controls in PR #3 at `97964fc`; their recorded local checkpoint includes 42 Chromium cases, 62 export-control comparisons and three isolated Brave live checks. The earlier WASM DSP JSON-validation follow-up passed its recorded local gates and two remote CI runs. The owner merged the stage-history, paused-initialization and live-control-packet follow-up in PR #4 at `ef18a7f`, after its recorded local gates and two remote CI runs passed. The owner merged the offline-bridge, EQ-prediction and bounded CI-provisioning follow-up in PR #5 at `f5ec9ad`; broader AI/separation/automation requirements remain outstanding; [tasks](docs/tasks.md) and [the audit](docs/reviews/2026-10-21-war-room-audit.md) retain the evidence and failure history.

- The production library starts empty. Import your own PCM WAV; legacy example projects and fabricated analysis/stem results are discarded during migration. One Go import request validates and reconstructs audio, returning canonical stereo-float WAV and source measurements before storage in IndexedDB. Import shows validation, waveform preparation and storage phases with Cancel. Project metadata/settings use localStorage, with an in-memory audio fallback and warning when persistent storage fails.
- Advanced mode offers independent input, five-band EQ, compressor, saturation, stereo and sample-limiter controls. The current expansion exposes compressor knee/makeup/sidechain HPF and automatic release, bass-mono frequency and mid/side gains, optional De-Harsh and three-band compression, plus Clean/Tube/Tape/Transformer coloration. Existing projects retain their legacy saturation character. New DSP stages are disabled when restoring older settings. Fresh expanded-control evidence is recorded in tasks; prior playback results remain tied to their earlier artifacts. Live audio calls the shared Go WASI reactor directly in 128-frame AudioWorklet blocks, with a fixed numeric control packet and no processing worker or JSON/callback crossing in the sample path. Module compilation precedes playback; its restricted host permits initialization services and rejects host calls during processing. Export still renders the current settings through native Go at the source rate in 16/24-bit PCM or 32-bit float WAV.
- Deep now offers **Analyze original audio**: measured spectral-band energy and neutral, source-bound change points through a cancellable background job. Cancel immediately releases the UI while the client deletes the admitted job; successful summaries are also released after receipt. These are original-source diagnostics, independent of current processing, not musical-role detection, generated mastering moves or AI repair. Per-band EQ enable/type and limiter release are now visible in Advanced. High-pass gain is inactive and retained for other types; select a band with the band buttons, then drag its single chart target or use labeled controls.
- DSP settings optionally accept `algorithmVersion: 1`; omitted/zero preserves legacy v1, and unimplemented versions are rejected. Explicit capability negotiation distinguishes 81/82-value control interfaces from the sonic algorithm. Production retains its 81-value shared packet, algorithm 1, zero buffered DSP latency and no buffered tail. This foundation adds no new hardware model or lookahead guarantee.
- Native rendering and the legacy WASM JSON bridge validate supplied EQ and multiband arrays before applying settings: five complete EQ bands and three complete dynamics bands. Case variants of the containing field names follow the same checks. The legacy offline bridge validates actual typed-array metadata before processing, so shadowed JavaScript properties cannot enlarge its memory views. See [the current bridge follow-up](docs/tasks.md#wasm-dsp-bridge-safety-and-eq-prediction) for verification status. Live control encoding also checks the three-band shape and exact packet length before publishing, preserving the previous shared packet when it rejects malformed settings.
- Simple presets now use conservative genre and tone starting points informed by public professional mastering workflows; see the [parameter tables and research](docs/mastering-controls-research.md). They are original Aurialis recipes, not Waves presets or adaptive song analysis. Zero intensity disables preset compression, saturation and stereo shaping while leaving the selected limiter target in place. Add Air, Cut Mud, Tape Warmth and Glue Comp apply explicit, noncumulative settings visible in Advanced. Their buttons highlight while those settings match; editing or bypassing the relevant processing clears the highlight. Independent starting points can stay highlighted together.
- Simple and Advanced edit one canonical chain; changing views preserves its settings and sound. Genre/tone/intensity write that chain, while custom Advanced edits clear selected Simple directions. Output target reflects the actual chain’s LUFS and ceiling, with Custom for unmatched values. **Set target loudness** explicitly measures and adjusts only input gain on the current chain, producing an offline preview or an unreachable-target error. Export uses the current chain from either view. **Apply profile** selects one of five static live presets; musical-role recognition, timeline automation and AI repair remain unavailable.
- **A Processed** is the default listening state; **B Original** selects the aligned dry source. Both share one playback clock, with an approximately 80 ms aligned processing buffer and an 8 ms transition. There is no Match level option or automatic A/B gain matching. Live parameter changes apply at block boundaries; the A/B transition does not certify smooth automation of every DSP control. Sample peak, RMS, crest factor, correlation and the 4096-point live spectrum describe the actual audible output; played waveform sections use the clay accent with a dense, width-aware envelope derived from 2048 actual sample-peak buckets. The spectrum interpolates between measured frames for visual motion; its underlying FFT still updates at up to 20 Hz. The separate approximate EQ response prediction follows the shared Go TPT filter equations; it is a settings view rather than a measured device response.
- The responsive transport reserves space for status updates. Tap Restart to return to zero; tap Next to open the next Library track, or skip forward 10 seconds at the end of the queue. Hold either control to scrub; release resumes only if playback was active, and reaching the end without repeat stays stopped. Repeat loops the current track. Keyboard and supported browser media controls operate the current player; mastering sliders and EQ points reset to canonical defaults with double-click or Backspace.
- Albums render actual per-track 24-bit WAV artifacts for download while preserving the original uploads. The browser output cache is bounded; broader album consistency and batch recovery requirements remain open. Reference direction blends another project's EQ settings with effective low-band/width options; it does not analyze or match recorded reference spectra.
- Release diagnostics measure actual rendered output with native loudness, reconstructed-peak, sample-peak, crest and correlation meters. Streaming, Dynamic and Spoken word are working targets, not platform delivery certification. Smart Split identifies validated instrument separation as unavailable; its old timer-driven success path is removed.

Imports are bounded to **128 MiB plus the 44-byte canonical WAV header** and **16,777,216 decoded frames** (about 5 min 50 s at 48 kHz or 2 min 55 s at 96 kHz; byte limits can be stricter). The multipart request ceiling is 129 MiB, including canonical float WAV and form overhead. One expensive audio request runs at a time; busy requests return a retryable response. Album output cache is limited to 128 MiB total and lasts only while its page remains open; changing the sequence or processing settings invalidates the downloads. These are finite workstation limits, not unlimited batch capacity.

The worklet remains silent until its explicit playback reset. Retained queue/state counters do not measure every missed render deadline; the recorded five-minute actual-song output-continuity fixture passed in Brave, without certifying render deadlines or physical-device output. The live graph resamples to the device AudioContext rate when it differs from the source; live and native exports are not claimed sample-identical across rates. Validated hardware fidelity, trained separation, source-adaptive AI mastering, timeline automation and certified true-peak limiting remain open. The native binary embeds the frontend, live WASI reactor and legacy browser WASM with its matching Go runtime for offline previews. Fonts are self-hosted.

Cached canonical stereo-float WAV audio is loaded locally after strict size, structure and finite-sample checks; legacy sources with another WAV layout fall back to Go reconstruction. Missing or failed sources disable playback/A/B and expose retry controls. A WASI initialization failure after Pause releases that attempt’s graph and promise so the next Play can retry. Each mounted track gets a fresh audio context, reactor instance and graph, and navigation disposes the old graph. Connection and interrupted-response errors identify the local server and preserve cancellation. Five actual approximately 35–47 MB user WAVs imported in Brave through one POST each in observed 10.274–13.027 s; cancellation released the processing slot and retry succeeded. These are fixture observations, not a controlled performance or memory benchmark. The cause of the user-reported “Failed to fetch” remains unverified; fresh successful requests do not identify the earlier failure.

## Quickstart & Single-Binary Build

Use Node `26.12.0`, `pnpm@10.33.0`, Go `1.26.10`, Next.js 16 and React 19, as pinned by this repository. Dependency installation uses pnpm only.

```bash
export PATH="$HOME/.nvm/versions/node/v26.12.0/bin:$PATH"
pnpm install --frozen-lockfile
pnpm run build:binary
pnpm run test:binary
./aurialis -addr 127.0.0.1:8080 -workers 4
```

Open [http://127.0.0.1:8080](http://127.0.0.1:8080). `build:binary` compiles both live WASI and offline browser WASM modules, copies Go's matching `wasm_exec.js` for the latter, builds and synchronizes the static frontend, then builds the host. `pnpm start` runs the built `./aurialis` executable. `test:binary` starts that executable from an empty temporary directory and checks embedded assets and API behavior. A plain `go build` does not rebuild frontend assets.

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
GOOS=wasip1 GOARCH=wasm go build -buildmode=c-shared -trimpath -o public/wasm/aurialis-realtime.wasm ./wasm/dsp

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

The Go/WASM job reuses FFmpeg when it is already available. Otherwise, a separate five-minute provisioning step installs it without recommended packages, with two acquisition retries and 30-second HTTP/HTTPS timeouts. When installation is needed, an existing APT mirror file switches the observed slow Azure archive URL to Ubuntu’s official HTTPS archive; package signature checks remain enabled. The independent meter comparison has its own three-minute limit and still runs when provisioning succeeds. FFmpeg is a verification tool, not a production runtime dependency.

---

## Private DSP research checkpoint

The private exact-extrema graph has passed a bounded GoJS/WASM comparison: 135 cases per side produced identical PCM, encoded WAV and numeric-state digest records within that target. This does not select the candidate or enable algorithm 2. The later fixed-count screen passed its two module builds and untimed 192 kHz recorder/verification gates; its first paired timing screen retained a steady-source 192 kHz deadline failure, and the candidate remains unselected. The 192 kHz processing deadline, browser continuity and cross-target state differences remain open. See the [private qualification record](docs/tasks.md#private-gojs-graph-checkpoint--october-23-2026) for source, evidence and retained failures.

The separate envelope node-visit experiment is prepared in `internal/audio/dsp/testdata/envelope_node_visit/` with production Go unchanged. Its independent original control passed four native tests under each baseline/candidate overlay with race instrumentation; six synthetic source contracts passed. These envelope units do not qualify full graph audio or performance. Fresh native and actual GoJS full-chain comparison remains pending, the steady 192 kHz deadline remains RED, and the candidate stays unselected. A separate two-child diagnostic sampled the same existing candidate module; it provides coarse stack counts only, with no new deadline inference. See the [sampling record](docs/tasks.md#same-module-sampling-follow-up).

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
- [`docs/mastering-controls-research.md`](docs/mastering-controls-research.md) — Sources, Simple preset values and expanded-control verification contract.
- [`docs/tasks.md`](docs/tasks.md) — Developer task tracker synchronized by `aurialis-tech-writer`.
- [`docs/design/aurialis-redesign.md`](docs/design/aurialis-redesign.md) — Warm editorial UI/UX & HCL/OKLCH design specification.

