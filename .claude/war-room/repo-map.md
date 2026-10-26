# Aurialis-WASM Repo Map — Binding Context for Every War-Room Seat
<!-- cspell:words buildmode trimpath -->

Read this once before forming any opinion. Then read `AGENTS.md`, `.claude/review-loop.md`, `.claude/war-room/finding-format.md`, `.claude/war-room/protocol.md`, and the Round 0 evidence pack provided by the chair.

---

## 0. Reading Large Files

Never read `.claude/war-room/ledger.md` (180 KB), `docs/tasks.md` (198 KB), `docs/architecture.md` (78 KB) and `docs/api.md` (73 KB) whole. Every later tool call re-sends what you have read.
- Ledger: `python3 .claude/war-room/ledger.py start | live [P0 P1] | item <ID> | log [N] | grep <regex>`.
- Docs: `grep -n '^#' <file>` for the outline, or `grep -n <term> <file>`, then read only that range.
- Run gate commands through `.claude/war-room/quiet.sh <label> <command…>`: full output goes to a log file, you get a PASS line or the failure lines, and the exit status is kept. Quote those lines as evidence.

## 1. Repository Layout

| Path | Owns |
|---|---|
| `cmd/aurialis/` | Single compiled Go entrypoint: CLI flags, HTTP/API server, `//go:embed` static/standalone Next.js & `.wasm` asset serving, COOP/COEP middleware, graceful shutdown |
| `internal/server/` | HTTP routes, multipart upload streaming, magic-byte validation, rate/size caps (`413`/`400`), CORS, SSE/polling job progress |
| `internal/jobs/` | Concurrent job scheduler, bounded worker pools, semaphores, context cancellation, back pressure, zero-copy buffer pooling, deterministic cleanup |
| `internal/audio/` | Bounded mono/stereo PCM/float WAV and 16-bit PCM AIFF reconstruction/encoding; unsupported compressed formats are rejected. Native diagnostic loudness/peak/crest/correlation meters are not hardware or platform certification |
| `internal/mastering/` | Experimental deterministic `MasteringScript` analysis/render helpers and frequency decomposition; these do not provide trained AI, instrument separation or enabled automation. Product workflows expose static profiles and honest unavailable states |
| `wasm/dsp/` | Go/WASM DSP modules (`GOOS=js GOARCH=wasm` and `GOOS=wasip1 GOARCH=wasm`): biquad parametric EQ, compressor, limiter, saturation, stereo width, real-time block processor for `AudioWorklet` + `SharedArrayBuffer` |
| `src/app/` | Next.js 16 App Router pages/routes faithfully matching `docs/design/figma-make-reference/src/App.tsx` (`/`, `/library`, `/master/[trackId]`, `/split/[trackId]`, `/albums`, `/albums/[albumId]`, `/reference/[trackId]`, `/release-check/[trackId]`, `/tools`) |
| `src/components/` | Reusable Tailwind CSS v4 + custom inline SVG primitives (`layout/`, `audio/`, `controls/`, `shared/`) — zero external icon libraries |
| `src/lib/` | Direct Go WASI AudioWorklet controller/numeric controls, legacy offline WASM bridge, IndexedDB audio persistence and canonical project/settings store; production simulation fallback removed |
| `public/worklets/` & `public/wasm/` | Direct Go WASI AudioWorklet, restricted initialization host, live reactor and legacy offline `.wasm` DSP assets |
| `tests/postman/` | Postman collections (`aurialis-backend.postman_collection.json`), Newman runner (`run-newman.sh`), and deterministic audio fixture generator (`TS-001` through `TS-013+`) |
| `e2e/` | Playwright E2E, mobile-first responsive (`320px`, `375px`, `768px`, `1024px`, `1440px`), and axe WCAG 2.2 AA accessibility suites |
| `docs/` | `architecture.md`, `api.md`, `tasks.md`, and canonical Figma design artifacts in `docs/design/` (`aurialis-redesign.md`, `aurialis-redesign-d7a69d24.md`, and `figma-make-reference/src/{index.css,App.tsx,store.tsx,types.ts,db.ts}`) |
| `.claude/`, `.agents/`, `.gemini/`, `.codex/` | Cross-platform War Room agents, skills, slash commands, hooks, and ledger |

---

## 2. Non-Negotiable Invariants

These are product requirements, not claims that every workflow is enabled or certified. Current implemented scope and evidence are in `docs/tasks.md`.

1. **Single Self-Contained Go + Next.js + WASM Binary**:
   - Production compiles into a single Go binary (`aurialis`) that serves the Next.js UI, `.wasm` modules, AudioWorklets, and JSON/multipart APIs in-house without requiring an external Python FastAPI container at runtime.
   - All responses serving the app shell and worklets must include `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` so `SharedArrayBuffer` and WASM `AudioWorklet` pipelines work in Chrome, Firefox, and Safari.
2. **Latest Node, Next.js 16, and `pnpm` Only**:
   - Node `26.12.0` (`>=24.0.0`), `pnpm@10.33.0`, Next.js `^16.4.2`, React 19, TypeScript 5.8+, Go `1.26.10`.
   - Any use of `npm` or `yarn`, or committing `package-lock.json` / `yarn.lock`, is a **BLOCKER**.
3. **Zero External Icon Libraries & Low Bundle Weight**:
   - All styling uses **Tailwind CSS v4**.
   - All icons use **custom inline SVGs** (`src/components/shared/Icon.tsx`). Importing `lucide-react`, `@heroicons/react`, `react-icons`, or emoji icons in application code is a **BLOCKER**.
   - Components must be reused across all 8 routes (`Button`, `SliderField`, `SegmentedControl`, `Toggle`, `Modal`, `BottomSheet`, `StatusBadge`, `DropZone`, `Waveform`, `SpectrumChart`, `DeepTimeline`, `Transport`, `MetricStrip`). One-off duplicated sliders, buttons, or modals are **REQUIRED** defects.
4. **Mobile-First & Responsive Workstation Ergonomics**:
   - Enforced jointly by `aurialis-frontend` and `aurialis-designer`.
   - Base CSS/Tailwind classes target `320px–390px` mobile screens first (compact header, 4-item bottom nav, sticky mini-transport, bottom-sheet move editors, horizontally scrollable Deep timeline with sticky lane headers), then scale up at `md:` (`768px` tablet 2-column grids) and `lg:`/`xl:` (`1024px–1440px+` desktop left rail + central canvas + right inspector + bottom transport).
   - Zero unintended horizontal page scroll at `320px`, `375px`, `390px`, `768px`, `1024px`, and `1440px`.
   - All interactive controls and drag handles must have `>=44×44px` hit areas and single-pointer/keyboard equivalents (`WCAG 2.5.7`, `2.5.8`).
5. **HCL / OKLCH Perceptual Color & WCAG 2.2 AA Accessibility**:
   - Warm editorial identity (`--canvas: #f2eee6`, `--paper: #faf7f0`, `--ink: #29231f`, `--clay: #b4543c`, `--moss: #596c52`, `--ochre: #b8893d`, `Newsreader` + `Instrument Sans` + `tabular-nums`).
   - Color ramps and state washes are audited in **HCL / OKLCH** perceptual space and certified against **WCAG 2.2 AA** contrast ratios.
   - Every custom SVG visualization must provide an accessible text summary and labeled form controls; status is never conveyed by color alone.
6. **Production-Compatible Contracts (`MasteringScript` v1 & Smart Split 2–6)**:
   - Deep mode uses the version `1` `MasteringScript` schema with the 5 engineer profiles (`modern_pop_polish`, `hip_hop_low_end`, `indie_warmth`, `metal_wall`, `pop_punk_air`), section vocabulary (`intro`, `verse`, `chorus`, `bridge`, `drop`, `breakdown`, `outro`, `unknown`), and 5 automation lanes (`Volume`, `EQ`, `Comp/Sat`, `Width`, `AI Repair`).
   - Smart Split supports every exact stem count from `2` through `6` (`2`: Vocals/Instrumental; `3`: Vocals/Drums/Other; `4`: Vocals/Drums/Bass/Other; `5`: Vocals/Drums/Bass/Melody/Other; `6`: Vocals/Drums/Bass/Guitar/Piano/Other).
7. **Concurrent Job Safety & Resource Bounds**:
   - Multiple concurrent uploads, stem splits, deep analyses, and album batch jobs must run through bounded Go worker pools with `context.Context` cancellation, upload size limits (`MAX_UPLOAD_BYTES_OVERRIDE` / 413), magic-byte sniffing (`400`), filename sanitization (no CRLF or `../`), and deterministic temp/buffer cleanup.
8. **Small Commits, Technical Writer Sync, and Finished Means Merged**:
   - Enforced by `aurialis-product-engineer` and `aurialis-tech-writer`. Small readable commits, synchronized docs (`README.md`, `docs/api.md`, `docs/architecture.md`, `docs/tasks.md`), and merged to `main` before claiming completion.

---

## 3. Verification Gates (Quote These; Do Not Invent Others)

| Area | Gate Command |
|---|---|
| **Toolchain Preflight** | `export PATH="$HOME/.nvm/versions/node/v26.12.0/bin:$PATH" && node -v && pnpm -v && go version` |
| **Go Backend, Static Quality & Concurrency** | `"$(go env GOROOT)/bin/gofmt" -l cmd internal wasm` (empty) · `go mod verify` · `go vet ./...` · `golangci-lint run ./...` (runs `staticcheck -checks all`, `revive`, `gosec`, `nakedret`, `misspell`, `dupword`, `gocritic`, `errorlint`, `bodyclose`, `noctx`, `exhaustive` via `.golangci.yml`; use `--fix` locally only, never in CI) · `identypo ./...` · `govulncheck ./...` · `go test -race -count=1 -timeout 10m ./...` |
| **WASM Compilation & Audio Transformation Verification** | `GOOS=js GOARCH=wasm go build -trimpath -o public/wasm/aurialis-dsp.wasm ./wasm/dsp` · `GOOS=wasip1 GOARCH=wasm go build -buildmode=c-shared -trimpath -o public/wasm/aurialis-realtime.wasm ./wasm/dsp` · `go test -race -v ./wasm/... ./internal/audio/...` (scoped signal transformation fixtures; hardware, anti-aliasing and true-peak certification remain separate open requirements) |
| **Frontend Strict Quality & Zero-Icon-Lib** | `pnpm exec tsc --noEmit` (`staticcheck` equivalent) · `pnpm run lint` (`eslint --max-warnings=0` with `strictTypeChecked`, `@next/next`, `security`, `sonarjs`, `unicorn`, `jsx-a11y`, and `no-restricted-imports` banning `lucide-react`/`@heroicons`/`react-icons`) · `pnpm exec knip` (dead code/unused exports) · `pnpm exec cspell lint "**/*.{ts,tsx,go,md}"` (`identypo` equivalent) · `pnpm test` · `pnpm run build` |
| **Single Binary Build** | `pnpm run build:binary` |
| **API (Postman/Newman + cURL)** | `pnpm run test:backend:postman` + `curl -i` COOP/COEP & edge-case probes |
| **Responsive & A11y E2E** | `pnpm exec playwright test` (verifying `320px`, `375px`, `768px`, `1024px`, `1440px` viewports + axe WCAG 2.2 AA) |
| **CI/CD Workflows** | `.github/workflows/ci.yml` all jobs green (`repo-and-agent-hygiene`, `go-wasm`, `frontend-quality`, `backend-newman`, `playwright-e2e`, `ci-passed`); verify with `gh run list --branch "$(git branch --show-current)" --limit 5` and `gh run view <id> --log-failed` |

---

## 4. Evidence Tiers — Never Promote One to Another

1. `unit` — Go package unit test or Vitest component test with mocked/in-memory state.
2. `audio-verify` — Objective mathematical & acoustic verification tests (`internal/audio/verify_test.go`, `wasm/dsp/dsp_verify_test.go`) co-designed by `aurialis-audio-engineer`, `aurialis-dsp-plugin-engineer`, `aurialis-grammy-veteran`, and `aurialis-qa` proving via FFT/Goertzel, LUFS/dBTP, THD harmonics, stereo correlation, and section envelope deltas that the output audio is changed in the exact physically expected way.
3. `wasm-bridge` — Real compiled `.wasm` module loaded and processing audio Float32 frames in test harness.
4. `api-curl` — Real compiled `aurialis` Go binary serving live HTTP endpoints verified via `curl -i` (including headers, status codes, multipart errors, and concurrency).
5. `newman-e2e` — Full Postman/Newman `PR Suite` (`TS-001` through `TS-015+`) passing against the live Go server.
6. `playwright-a11y-responsive` — Real headless browser running Playwright E2E frontend tests (`pnpm exec playwright test`) against the embedded Next.js + Go + WASM stack across all 9 routes and mobile (`320px`/`375px`), tablet (`768px`), and desktop (`1024px`/`1440px`) viewports with axe WCAG 2.2 AA passing.
7. `compiled-binary-smoke` — Single standalone `./aurialis` binary executed outside the source tree in a clean temp directory, serving UI, WASM, and API end-to-end.

*Rule*: Simulated/deterministic frontend fallback state is **not** WASM DSP or Go backend evidence. Merged is not released is not deployed.

---

## 5. Traps That Have Burned This Project

- **Node version in non-interactive shells**: macOS default non-interactive `zsh` resolves `node` to `~/.nvm/versions/node/v19.9.0/bin/node`, which fails Next.js 16 and Vite 8 builds. Always prepend `$HOME/.nvm/versions/node/v26.12.0/bin` to `PATH` (or use `mise exec --`).
- **`gofmt` shell alias**: `gofmt` may be aliased to `gofmt -w .` in the owner's interactive shell. Always invoke `"$(go env GOROOT)/bin/gofmt" -l cmd internal wasm` so read-only review seats never dirty the tree.
- **Figma Make reference imports `lucide-react` and `react-router-dom`**: The reference prototype in `docs/design/figma-make-reference/` came from Figma Make (Vite + `react-router-dom` + `lucide-react`). When building/porting into Next.js 16 (`src/`), **never** copy `lucide-react` or `react-router-dom`—use Next.js App Router (`next/link`, `next/navigation`) and custom inline SVGs (`src/components/shared/Icon.tsx`).
- **Newman upload-limit setup**: `pnpm run test:backend:postman` starts its loopback server with `-max-upload-bytes 1048576` and sends a bounded oversized fixture to verify `413`. Do not carry the historical 200 MiB environment override into this harness: it exceeds the current 129 MiB request hard limit and prevents startup. The collection and harness are the current case inventory.
- **`SharedArrayBuffer` silently degrades without COOP/COEP**: If the Go server or Next.js dev server omits `Cross-Origin-Opener-Policy: same-origin` or `Cross-Origin-Embedder-Policy: require-corp`, `window.crossOriginIsolated` is `false` and `SharedArrayBuffer` throws `ReferenceError`, forcing the audio engine into bypass fallback. Always verify headers with `curl -I`.
- **Object URL & WASM linear memory leaks**: Creating `URL.createObjectURL(blob)` or allocating WASM Float32 buffers per render/block without revoking URLs or reusing pre-allocated ring buffers causes browser OOM on 10-minute tracks (`TS-012`).
- **Killing shared processes**: Multiple agents may run tests concurrently. Track the PID of any `./aurialis` test server you start on a unique free port (`127.0.0.1:<port>`) and kill only that PID (`lsof -tiTCP:<port> -sTCP:LISTEN`); never run `pkill -f aurialis`.
