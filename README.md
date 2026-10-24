<!-- cspell:words swiftshader -->
# Aurialis-WASM
<!-- cspell:words Embedder buildmode trimpath goroutines scrutinise -->

**Single-Binary Go 1.26 + Next.js 16 + WebAssembly (WASM) Audio Mastering Workstation**

Based on [Aurialis](https://aurialis.yosefgamble.com/) ([`yegamble/Aurialis`](https://github.com/yegamble/Aurialis)) and the warm editorial redesign specification in [`docs/design/aurialis-redesign.md`](docs/design/aurialis-redesign.md).

---

## Current behavior and limits

Aurialis reconstructs local WAV audio, runs shared Go/WASI DSP directly in AudioWorklet and exports native rendered WAVs from one chain shared by Simple and Advanced. The earlier corrective packaged path passed unit/static/build checks, bounded Chromium/Brave playback and a recorded five-minute actual-song run in Brave. The corrected 39-case browser suite and all six remote CI jobs also passed at the recorded source checkpoint; these bounded observations do not certify physical-device or hard real-time behavior. The earlier corrective PR #2 was merged by the owner at `30f576f9` on 2026-10-22 UTC. The owner merged the expanded controls in PR #3 at `97964fc`; their recorded local checkpoint includes 42 Chromium cases, 62 export-control comparisons and three isolated Brave live checks. The earlier WASM DSP JSON-validation follow-up passed its recorded local gates and two remote CI runs. The owner merged the stage-history, paused-initialization and live-control-packet follow-up in PR #4 at `ef18a7f`, after its recorded local gates and two remote CI runs passed. The owner merged the offline-bridge, EQ-prediction and bounded CI-provisioning follow-up in PR #5 at `f5ec9ad`; PR #6 merged measured source diagnostics, supported EQ/limiter controls and algorithm-1 capability foundations at `3886536`, after all CI gates passed. Its 61-case Linux browser suite and 22-request/27-assertion API suite are bounded acceptance evidence. The Library/source-recovery/navigation wave merged in PR #7 at `25d5653` after all six jobs in CI run `39906520601` passed, including 70 Linux browser cases in 4.9 minutes. Its earlier local checkpoint passed 321 unit/component cases. The next ScriptV2 API/schedule foundation is locally verified, including the corrected full 70-case existing-UI browser run in 3.5 minutes; exact remote CI and delegated merge remain pending. The owner authorized continued work with delegated merges; broader AI/separation/automation requirements remain outstanding; [tasks](docs/tasks.md) and [the audit](docs/reviews/2026-10-21-war-room-audit.md) retain the evidence and failure history.

- The production library starts empty. Select, drop or paste multiple PCM WAVs for sequential import; each source goes through one Go reconstruction request. Cancel keeps finished projects and removes an unfinished staged asset. Library offers search, status filters, sorting, live preview, independent settings copies, album assignment, source recovery and awaited deletion. Original source identity includes the canonical PCM digest, rate and frame count; an exact relink preserves settings, while explicit replacement validates settings and clears derived results. Recovery copies remain until project deletion because metadata autosave cannot acknowledge durable storage. Audio uses IndexedDB; denied storage permits a bounded aggregate 128 MiB plus 44-byte session cache with a warning to export before reload or closing the tab. Project metadata/settings use localStorage. Storage estimates and persistent-storage requests describe actual browser responses.
- Advanced mode offers independent input, five-band EQ, compressor, saturation, stereo and sample-limiter controls. The current expansion exposes compressor knee/makeup/sidechain HPF and automatic release, bass-mono frequency and mid/side gains, optional De-Harsh and three-band compression, plus Clean/Tube/Tape/Transformer coloration. Existing projects retain their legacy saturation character. New DSP stages are disabled when restoring older settings. Fresh expanded-control evidence is recorded in tasks; prior playback results remain tied to their earlier artifacts. Live audio calls the shared Go WASI reactor directly in 128-frame AudioWorklet blocks, with a fixed numeric control packet and no processing worker or JSON/callback crossing in the sample path. Module compilation precedes playback; its restricted host permits initialization services and rejects host calls during processing. Export still renders the current settings through native Go at the source rate in 16/24-bit PCM or 32-bit float WAV.
- Deep now offers **Analyze original audio**: measured spectral-band energy and neutral, source-bound change points through a cancellable background job. Cancel immediately releases the UI while the client deletes the admitted job; successful summaries are also released after receipt. These are original-source diagnostics, independent of current processing, not musical-role detection, generated mastering moves or AI repair. Per-band EQ enable/type and limiter release are now visible in Advanced. High-pass gain is inactive and retained for other types; select a band with the band buttons, then drag its single chart target or use labeled controls.
- DSP settings optionally accept `algorithmVersion: 1`; omitted/zero preserves legacy v1, and unimplemented versions are rejected. Explicit capability negotiation distinguishes 81/82-value control interfaces from the sonic algorithm. Production retains its 81-value shared packet, algorithm 1, zero buffered DSP latency and no buffered tail. This foundation adds no new hardware model or lookahead guarantee.
- The ScriptV2 foundation adds source-bound measured proposals, strict validation, native rendering and a separate compiled numeric schedule ABI. Generated proposals retain algorithm 1, the sample-peak limiter, disabled repair and the generic Optical compressor path. The common Go evaluator supports ten scalar targets without implicitly enabling modules. A bound source clock advances during static playback so first Apply inherits the current fractional phase; hosts must bind before the source starts. The existing Deep screen still offers static profiles and source diagnostics; editable automation and actual browser schedule integration require separate acceptance. See the [API contract](docs/api.md#scriptv2-foundation).
- Native rendering and the legacy WASM JSON bridge validate supplied EQ and multiband arrays before applying settings: five complete EQ bands and three complete dynamics bands. Case variants of the containing field names follow the same checks. The legacy offline bridge validates actual typed-array metadata before processing, so shadowed JavaScript properties cannot enlarge its memory views. See [the current bridge follow-up](docs/tasks.md#wasm-dsp-bridge-safety-and-eq-prediction) for verification status. Live control encoding also checks the three-band shape and exact packet length before publishing, preserving the previous shared packet when it rejects malformed settings.
- Simple presets now use conservative genre and tone starting points informed by public professional mastering workflows; see the [parameter tables and research](docs/mastering-controls-research.md). They are original Aurialis recipes, not Waves presets or adaptive song analysis. Zero intensity disables preset compression, saturation and stereo shaping while leaving the selected limiter target in place. Add Air, Cut Mud, Tape Warmth and Glue Comp apply explicit, noncumulative settings visible in Advanced. Their buttons highlight while those settings match; editing or bypassing the relevant processing clears the highlight. Independent starting points can stay highlighted together.
- Simple and Advanced edit one canonical chain; changing views preserves its settings and sound. Genre/tone/intensity write that chain, while custom Advanced edits clear selected Simple directions. Output target reflects the actual chain’s LUFS and ceiling, with Custom for unmatched values. **Set target loudness** explicitly measures and adjusts only input gain on the current chain, producing an offline preview or an unreachable-target error. Export uses the current chain from either view. **Apply profile** selects one of five static live presets; musical-role recognition, timeline automation and AI repair remain unavailable.
- **A Processed** is the default listening state; **B Original** selects the aligned dry source. Both share one playback clock, with an approximately 80 ms aligned processing buffer and an 8 ms transition. There is no Match level option or automatic A/B gain matching. Live parameter changes apply at block boundaries; the A/B transition does not certify smooth automation of every DSP control. Sample peak, RMS, crest factor, correlation and the 4096-point live spectrum describe the actual audible output; played waveform sections use the clay accent with a dense, width-aware envelope derived from 2048 actual sample-peak buckets. The spectrum interpolates between measured frames for visual motion; its underlying FFT still updates at up to 20 Hz. The separate approximate EQ response prediction follows the shared Go TPT filter equations; it is a settings view rather than a measured device response.
- The responsive transport reserves space for status updates. Tap Restart to return to zero; tap Next to open the next Library track, or skip forward 10 seconds at the end of the queue. Hold either control to scrub; release resumes only if playback was active, and reaching the end without repeat stays stopped. A keyboard hold retains its control through asynchronous resume unless focus moves elsewhere. Repeat loops the current track. Keyboard and supported browser media controls operate the current player; mastering sliders and EQ points reset to canonical defaults with double-click or Backspace.
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

## Verification status

Gate commands above are requirements, not claims of passing CI. See [`docs/tasks.md`](docs/tasks.md) and [the ledger](.claude/war-room/ledger.md) for current-session execution evidence and open blockers. The earlier blocked vulnerability lookup was superseded by a successful Go 1.26.10 `govulncheck ./...` run reporting no vulnerabilities. Final local results and failed attempts are recorded in the task tracker; current remote PR checks and verified delegated merges are tracked separately. A passing browser smoke test does not certify analog hardware fidelity, codec support, platform release compliance or all accessibility interactions.

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


<!-- cspell:words SDPA unfused softmax -->
## Private attention research checkpoint

The isolated stem-research branch adds 28 bounded, device-local CPU attention fixtures, preserving every key through N=1723. Actual native Go, original Attend math/CPU SDPA and unfused probes remain distinct; eight small contract tests passed. The mandatory FTZ resurrection case remains limited even though its CPU final value is normal. There is no attention GPU dispatch, model forward, endpoint or public capability. [Private design and evidence](internal/audio/steminfer/testdata/webgpu/attention/README.md) states the resource conventions and remaining gates. This older branch's historical product documentation is not a replacement for newer main documentation.


Private attention source checkpoint: an isolated eight-pass all-key shader and disposable fixture Worker now have 33 CPU/source units and a propagated audit of the unchanged 28 CPU probes (25 ordinary-input diagnostics, three LIMITED). No attention GPU operation, model forward or public feature was enabled. The [private guide](internal/audio/steminfer/testdata/webgpu/attention/README.md#source-only-eight-stage-bridge-checkpoint) records ownership, full uncertainty, retained failures and independent/hardware review still pending.


The private attention receipt follow-up closes independently reproduced disposal escapes using an immutable private backing-buffer inventory and captured intrinsic byte lengths. All 36 source units passed; peer RED probes and the original checkpoint remain preserved. This enables no GPU/model execution or public feature. Hardware qualification remains open.


A private source-only attention capture harness now has 49 passing Node units and three pure handler tests. It selects one pinned local fixture, captures raw stages through bounded 2 KiB chunks and retains memory ownership until parent writing/hashing/closure settles. No server, browser, adapter, GPU or model ran. Shared process helpers are copied exactly with provenance; the actual launcher/hardware gate remains open.


Independent QA reopened that capture source gate: a sink factory could fail after partial acquisition before returning its cleanup handle, while the old driver falsely acknowledged closure. The source-only repair opens parent ownership first and obtains a synchronous managed handle before asynchronous acquisition. Missing handles or failed cleanup retain the receipt. All 58 corrected Node source units passed in 415.363417 milliseconds; the original peer RED and controlled old-driver RED remain preserved. No server/browser/GPU/model ran. The [private guide](internal/audio/steminfer/testdata/webgpu/attention/README.md#capture-acquisition-ownership-repair) records the new boundary; independent review and hardware remain open.


Private attention launcher preparation now reuses the accepted Node admission helper and observed-survivor helper verbatim from `51d206c`. The shared OwnedGroups core remains SHA-256 `d5a9978835c7ebcd6fd9c30c6074f4e55b84ac26683b66c4f9198daf3dd08a40`; no group-membership or signaling framework was forked. Prior helper versions remain bound to their immutable indices, and current per-file hashes/origins are recorded in `scripts/qualification/provenance.json`. Three mocked Node admission controls passed in this source wave; they launch no browser and do not rerun or replace the earlier sixteen process controls. Actual launcher/hardware qualification remains held.


The next private attention launcher is now source-only: normal/crash modes use accepted group ownership and a fresh visible Brave profile with explicit sandboxing. Seventy injected Node/source tests and eight pure Python policy tests passed; no actual browser/server/Worker/GPU ran. [The launcher guide](scripts/qualification/attention-launcher.md) records pinned local runtime files, work admission ACKs, resource caps, commands and actual ownership/hardware gates still held. It activates no audio or model capability.


Private launcher qualification now explicitly ignores only Playwright's `--enable-unsafe-swiftshader` default; the actual-command guard rejects that flag. Visible mode, explicit sandboxing and every other default remain unchanged. Both source regressions failed against the old options/guard and now pass within 70 Node/source and eight pure policy cases. The first actual normal RED is preserved: static Python command-prefix rejection, final saved live and all-member lists empty, no work ACK or audio/adapter work. Its exact alias cause is unknown. New normal/crash controls remain unreleased; this is no hardware result.


The private static-command diagnostic now persists bounded raw `ps` text, exact PID/start/parent/group observations before and after capture, and a separately labeled Darwin executable-path/file-hash observation **before** unchanged argv parsing. A kernel-path match cannot authorize an argv alias, and these observations are not atomic running-image attestation. Original read/hash errors and cleanup failures remain separate. Published Apple interface research, installed SDK header hashes and the retained normal RED are recorded in `scripts/qualification/attention-identity-sources.json`.

A source-only one-child runner uses the exact pinned Python executable and `serve.py` argv. An environment-gated ready marker precedes ownership admission; the child then accepts EOF only and cannot release socket work. The parent reuses unchanged OwnedGroups authority, preserves its exact direct child through every failed setup/cleanup path, and captures `observed`/`fail` evidence without normal/crash or adapter qualification. Thirty-seven injected Python controls, seventy injected Node/source controls and three pure handler cases passed. This source wave ran no actual child diagnostic, server, browser, native identity call, GPU, audio or model. The original normal RED and every historical proof remain unchanged; actual diagnostic and new normal/crash execution remain held.


The separately released one-child identity diagnostic observed Python's exact framework-app runtime rather than its pinned launch wrapper: the saved 257-byte command and Darwin path observation agreed, the child exited zero, cleanup was empty, and final all-member/live-member lists were empty. Its status is `observed`, with qualification false; the old strict launcher-prefix check still rejected it. The original normal RED's missing raw command remains unreconstructed. The next source-only rule names both binaries separately: launch argv stays unchanged, while fresh runtime path/size/SHA-256, stable process identity and exact runtime-prefix/source argv must all match. It permits no generic alias, basename or resolved-path fallback. Forty-four injected Python controls pass, including seven new saved-command replay/negative cases. No diagnostic retry, new normal/crash, browser, GPU, model or audio execution is released by this change.


**Private ownership gate accepted:** exactly one normal and one crash control ran on frozen `9dafac9`, passing in 3.188731333 and 1.803065084 seconds. The forced Node crash left seven exact pre-recorded browser-group survivors; cleanup then left both actual all-member/live-member lists empty. Both runs had empty primary/cleanup errors, one acknowledged tiny Worker, 12 allowlisted GETs with empty bodies and zero selected fixtures. Actual argv omitted unsafe SwiftShader and sandbox-disabling flags; the separate exact Python runtime pin matched. CDP reported an Apple M2 renderer, while WebGPU adapter/features/limits were **not requested**. Independent QA rehashed 142 regular files (10,997,781 bytes) and four symlink records without mismatch. The [private launcher guide](scripts/qualification/attention-launcher.md) records hashes, sampled-resource limits and the still-unreleased adapter/capture proposal. Original REDs, model limitations and whole-project OPEN status remain.


A private metadata-only Worker source command now shares the existing one-active client gate and acknowledged byte-stream/file lifecycle. It requests only the default adapter: no device, GPU buffer, shader, fixture, audio or dispatch. Required API fields are checked; valid empty identity strings mean attribution LIMITED. UTF8 evidence remains at most 8 KiB and travels in one-in-flight 256-byte chunks, with a 54,016-byte logical representation maximum under the existing 65,536-byte allowance. The new private `--mode metadata` path requires fresh ownership/resource ACKs and closed-file hash/closure before disposal. It is source-tested only; actual preparation/browser/adapter execution and every attention capture remain unreleased. Accepted `9dafac9` normal/crash proofs, numeric bounds, model limitations and whole-project OPEN status remain unchanged.
