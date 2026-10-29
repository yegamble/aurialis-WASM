# AGENTS.md — Aurialis-WASM

Single source of truth for all AI coding agents and services operating in this repository (**Gemini Argon / Antigravity / Gemini CLI**, **Claude Code**, and **OpenAI Codex**). Do not duplicate or fork these rules across model-specific files; `CLAUDE.md` and `GEMINI.md` import this file directly.

---

## 1. Mission & Product Vision

**Aurialis-WASM** is a self-contained **Golang + Next.js + WebAssembly (WASM)** audio mastering workstation based on [Aurialis](https://aurialis.yosefgamble.com/) ([`yegamble/Aurialis`](https://github.com/yegamble/Aurialis)) and the canonical Figma warm editorial redesign specification and reference code in [`docs/design/`](docs/design/) ([`docs/design/aurialis-redesign.md`](docs/design/aurialis-redesign.md), [`docs/design/aurialis-redesign-d7a69d24.md`](docs/design/aurialis-redesign-d7a69d24.md), [`docs/design/figma-make-reference/src/index.css`](docs/design/figma-make-reference/src/index.css), and [`docs/design/figma-make-reference/src/App.tsx`](docs/design/figma-make-reference/src/App.tsx)). All agents must strictly follow the Figma design in `docs/design/`.

Our architectural goal is a **single compiled Go binary** (`aurialis`) that embeds the Next.js frontend, serves the HTTP/JSON API, compiles and ships the client/server WASM DSP modules, orchestrates concurrent audio jobs, and runs smart AI/LLM mastering (`MasteringScript` v1), stem separation (`2–6` stems), reference track matching, album consistency mastering, and platform release checks **in-house**.

**v1 release target (owner ruling):** the **browser build** served from Cloudflare ([aurialis.yosefgamble.com](https://aurialis.yosefgamble.com/), [aurialis.yosef.app](https://aurialis.yosef.app/)) is the primary product; every audio job runs on the user's device in Go/WASM Web Workers and nothing is uploaded. The native single binary is a documented, **source-built fallback** (no prebuilt binaries are distributed) for files beyond a browser's memory budget, and it is the only build that runs Smart Split. User-facing copy must say "native Aurialis build (built from source)", never "desktop app", and must branch on `usesBrowserAudio()` / `useBrowserBuild()` wherever the two builds differ.

---

## 2. Stack & Non-Negotiable Technical Constraints

1. **Latest Toolchain & Package Manager**:
   - **Node.js**: Latest Node `26.12.0` (`>=24.0.0` Active LTS / current; pinned in [`.nvmrc`](.nvmrc) and [`.mise.toml`](.mise.toml)).
     - *Shell Trap*: Non-interactive shells on macOS may default to an older `.nvm` Node (`v19.9.0`). Always ensure `~/.nvm/versions/node/v26.12.0/bin` is on `PATH` (or run via `mise exec --`).
   - **Package Manager**: **`pnpm` (`pnpm@10.33.0`) ONLY**. Never use `npm` or `yarn`, and never commit `package-lock.json` or `yarn.lock`.
   - **Next.js & React**: Latest **Next.js 16** (`^16.4.2`, App Router, static/standalone embedding) + **React 19** + **TypeScript 5.8+** (`strict: true`).
   - **Go**: **Go 1.26+** (`go1.26.10`), compiling both the native host binary (`cmd/aurialis`) and WebAssembly DSP modules (`GOOS=js GOARCH=wasm` / `GOOS=wasip1 GOARCH=wasm`).
2. **Low-Bundle, Zero-Icon-Library Frontend**:
   - **Styling**: **Tailwind CSS v4** (`@import 'tailwindcss';` and `@theme` tokens) for all styling.
   - **Icons**: **Hand-crafted inline SVGs ONLY**. External icon libraries (`lucide-react`, `@heroicons/react`, `react-icons`, `feather-icons`, font icons, or emoji glyphs) are **strictly forbidden** in production code to keep the client bundle minimal.
   - **Aggressive Component Reuse**: Build and reuse a small, strict set of shared primitives (`Button`, `Icon`, `SliderField`, `SegmentedControl`, `Toggle`, `Modal`, `BottomSheet`, `StatusBadge`, `DropZone`, `Waveform`, `SpectrumChart`, `DeepTimeline`, `Transport`, `MetricStrip`). Duplicating UI patterns across pages inflates bundle size and creates testing bloat.
3. **Mobile-First & Responsive Design (Enforced by Frontend & UI/UX Designer)**:
   - Every screen and component **must** be designed and styled **mobile-first** (`320px–390px`), then progressively enhanced for **tablet** (`768px`) and **desktop audio workstation** (`1024px–1440px+`).
   - Never simply stretch a mobile view or squish a desktop layout. Mobile uses a compact top bar, 4-item bottom navigation (`Home`, `Library`, `Albums`, `Tools`), sticky mini-player transport, horizontally scrollable Deep automation timeline with sticky lane labels, and bottom sheets/accordions. Desktop uses a persistent left rail, central visualization canvas, right contextual inspector, and sticky bottom transport.
   - Zero unintended horizontal page overflow at `320px`, `375px`, `390px`, `768px`, `1024px`, and `1440px`.
   - Every interactive target (buttons, sliders, EQ band nodes, timeline moves, stem mute/solo) must be at least **`44×44px`** on touch/mobile and fully keyboard-operable (`Tab`, arrow keys, `Escape`).
4. **HCL / OKLCH Perceptual Color & Accessibility (WCAG 2.2 AA)**:
   - Follow the warm editorial design system (`--canvas: #f2eee6`, `--paper: #faf7f0`, `--ink: #29231f`, `--clay: #b4543c`, `--moss: #596c52`, `--ochre: #b8893d`, `Newsreader` display serif + `Instrument Sans` UI sans + tabular numerals).
   - Evaluate color ramps and interactive states in **HCL / OKLCH** perceptual space for uniform lightness and chroma stability, and verify every text/surface pair against **WCAG 2.2 AA** contrast ratios (and APCA `Lc` targets).
   - Every custom SVG chart (Waveform, EQ Spectrum, Deep Timeline, Album Consistency, Reference Overlay) must have an accessible text summary and labeled form-control equivalents. Never rely on color alone to communicate pass/warning/fail/muted/edited states.
5. **Single Go Binary + WASM + Concurrent Job Optimization**:
   - The Go binary embeds compiled frontend assets (`//go:embed`) and `.wasm` modules, sets `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` so `SharedArrayBuffer` and `AudioWorklet` operate at full speed, and manages concurrent audio processing jobs (Smart Split `2–6` stems, Deep Analysis `MasteringScript` v1, Album Batch Mastering) via bounded worker pools, context cancellation, zero-copy buffer reuse, and deterministic resource limits.
6. **Cybersecurity, Host-Machine Protection & Audio Content Disarm & Reconstruction (Enforced by `aurialis-security`)**:
   - **Zero Persistent Raw Uploads / Anti-Payload Stashing**: Never write uploaded files to the host disk using user-supplied filenames or extensions. Process uploads in bounded memory (`sync.Pool` Float32 PCM buffers) or, when spill-to-disk is needed, use an isolated `0700` temp directory with random CSPRNG UUID `.pcm.tmp` filenames opened with `O_CREATE|O_EXCL|O_NOFOLLOW` and `0600` (non-executable) permissions, unlinked immediately on job completion/cancellation.
   - **Audio Content Disarm & Reconstruction (CDR)**: Validate container magic bytes and chunk bounds, reject polyglots (`MZ`, `\x7fELF`, Mach-O, `PK\x03\x04` ZIP/JAR trailers, `%PDF`, scripts), strip all non-audio chunks (`LIST`, `INFO`, `ID3`, `JUNK`, `PAD`, trailing bytes after `data`), and re-synthesize clean PCM samples so hidden payloads cannot survive on the host machine or in exported audio.
   - **Localhost Hardening**: Bind to `127.0.0.1` by default, validate `Host` and `Origin`/`Sec-Fetch-Site` headers against DNS rebinding and drive-by localhost CSRF, ban `os/exec` (`exec.Command`) in audio/request paths, and enforce strict CSP, `X-Content-Type-Options: nosniff`, and `X-Frame-Options: DENY`.

---

## 3. Mandatory Verification Gates

Before claiming any task or slice is complete, run the applicable verification gates with Node 26 and Go 1.26 on `PATH`:

```bash
export PATH="$HOME/.nvm/versions/node/v26.12.0/bin:$PATH"

# 1. Go & WASM Quality Gate (configured in .golangci.yml)
"$(go env GOROOT)/bin/gofmt" -l cmd internal wasm   # Must output nothing (never use shell alias `gofmt`)
go mod verify
go vet ./...
golangci-lint run ./...                              # Runs staticcheck (all), revive, gosec, nakedret, misspell, dupword, gocritic, errorlint, bodyclose, noctx, exhaustive (use `--fix` ONLY locally before committing, NEVER in CI/gates)
identypo ./...                                       # AST identifier typo check across Go symbols
govulncheck ./...                                    # Go dependency & stdlib CVE reachability check
go test -race -count=1 ./...
# The race build trims signal matrices; run every sample rate and full meter case too.
go test -run 'HoldTheCeilingAgainstTheLongSincReference$|^TestLivePlaybackOfALoudAbruptEndRendersTheExport$' -count=1 ./wasm/dsp
go test -run '^Test(ExportMeter|TruePeakMeterReads|LiveMeter)' -count=1 ./internal/audio/dsp
GOOS=js GOARCH=wasm go build -o public/wasm/aurialis-dsp.wasm ./wasm/dsp

# 2. Next.js 16 / TypeScript & Bundle Quality Gate (pnpm only — direct equivalents to Go linters)
pnpm exec tsc --noEmit                               # Equivalent to `staticcheck -checks all`: strict TS + noUncheckedIndexedAccess + exactOptionalPropertyTypes + noImplicitReturns
pnpm run lint                                        # Equivalent to `golangci-lint` + `revive` + `gosec` + `nakedret`: ESLint v9 Flat Config (--max-warnings=0) with typescript-eslint strictTypeChecked, @next/eslint-plugin-next (core-web-vitals), eslint-plugin-security, eslint-plugin-sonarjs/unicorn, eslint-plugin-jsx-a11y, and no-restricted-imports banning external icon libraries
pnpm exec knip                                       # Dead code, unused exports, unused files & dependencies check
pnpm exec cspell lint "**/*.{ts,tsx,go,md}"          # Equivalent to `identypo` + `misspell` across TS/Go identifiers & docs
pnpm test                                            # Vitest unit/component suite
pnpm run build                                       # Next.js 16 production build

# 3. E2E & Responsive / Accessibility Gate
pnpm exec playwright test                            # Includes 320/375/768/1024/1440px & axe WCAG 2.2 AA checks

# 4. Backend API Gate (Postman/Newman + cURL probes)
pnpm run test:backend:postman                        # Health, Happy Path, Edge Cases, Security (413/400/CRLF/Path Traversal)
```

- Never claim a test passed unless you executed it in the current session and observed its exit status and output.
- Label evidence tiers honestly (`unit` · `wasm-bridge` · `api-curl` · `newman-e2e` · `playwright-a11y-responsive` · `compiled-binary-smoke`).

---

## 4. Git Hygiene — "Finished Means Merged" & Atomic Commits

Enforced by the **Product Engineer** (`aurialis-product-engineer`) and the Stop hooks across all coding agents:

1. **Small, Atomic, Readable Commits**:
   - Work on a short-lived feature/fix branch off `main`.
   - Commit early and often in small, single-concern, readable commits (`feat(dsp): ...`, `fix(ui): ...`, `test(qa): ...`, `docs(api): ...`) so other engineer agents can review each commit cleanly. Never dump a mega-commit at the end of a session.
2. **Mandatory Technical Writer Catch-Up Before Closing**:
   - Every engineer agent (`aurialis-backend`, `aurialis-frontend`, `aurialis-designer`, `aurialis-qa`) **must** sync with `aurialis-tech-writer` when code, API contracts, CLI flags, UI workflows, or task statuses change.
   - Code, tests, and documentation (`README.md`, `docs/api.md`, `docs/architecture.md`, `docs/tasks.md`, `.claude/war-room/ledger.md`) land together.
3. **Finished Means Merged**:
   - A task or ledger item is **finished** only when all verification gates pass, `aurialis-qa` and `aurialis-devils-advocate` fail to break it, `aurialis-tech-writer` confirms documentation accuracy, and the branch is **merged to `main`** (and pushed if a remote is configured).
   - If merging is blocked (awaiting owner approval, external prerequisite, or red CI), report the state strictly as **`open — awaiting merge`**, never `done` or `complete`.
   - Immediately delete merged feature branches locally (`git branch -d <branch>`) and remotely (`git push origin --delete <branch>`), and sweep any stale branches already merged into `main`.

---

## 5. The War Room & War Room Loop (`war-room` / `war-room-loop`)

We use an 11-seat adversarial specialist War Room that works across **Gemini Argon (Antigravity / Gemini CLI)**, **Claude Code**, and **OpenAI Codex**:

| Agent ID | Role | Core Responsibility |
|---|---|---|
| [`aurialis-backend`](.claude/agents/aurialis-backend.md) | **Backend Engineer** | Go + TypeScript + WASM (`GOOS=js`/`wasip1`), single-binary embedding, concurrent job/worker-pool optimization, in-house audio & AI/LLM mastering pipeline. |
| [`aurialis-frontend`](.claude/agents/aurialis-frontend.md) | **Senior Frontend Engineer** | Next.js 16 + strict TypeScript + Tailwind CSS v4, custom inline SVGs (no icon libraries), mobile-first responsive layouts, maximum component reuse to eliminate test bloat. |
| [`aurialis-designer`](.claude/agents/aurialis-designer.md) | **UI/UX Designer** | Accessible (WCAG 2.2 AA, APCA, keyboard, 44px touch targets) & interactive design, HCL/OKLCH perceptual color mastery, mobile-first + desktop workstation ergonomics, Figma skills & state matrices. |
| [`aurialis-audio-engineer`](.claude/agents/aurialis-audio-engineer.md) | **Hardware & Physics Audio Engineer** | Vintage & modern audio hardware mechanics & physics (optical LA-2A, Variable-Mu Fairchild/Manley, FET 1176, VCA SSL/API/Shadow Hills, Pultec passive LC/tube EQ, Massive Passive proportional-Q, Ampex ATR-102 tape, iron transformers, True-Peak limiters) and objective acoustic verification specs. |
| [`aurialis-dsp-plugin-engineer`](.claude/agents/aurialis-dsp-plugin-engineer.md) | **Waves-Style DSP Plugin Engineer** | Digitizing analog hardware into ZDF/TPT filters, ADAA + polyphase oversampled tube/tape/transformer waveshaping, program-dependent ballistics, Linkwitz-Riley M/S mono-bass, 4× oversampled True-Peak limiting, TPDF dither, and beating the Waves workflow. |
| [`aurialis-grammy-veteran`](.claude/agents/aurialis-grammy-veteran.md) | **20+ Year Grammy Mastering Engineer (Target Audience)** | Studio veteran across Pop, Jazz, Rock, Metal, and Rap/Hip-Hop; evaluates genre translation, loudness-matched A/B honesty, ear fatigue, album sequencing cohesion, and whether Aurialis beats a Waves/hardware chain. |
| [`aurialis-security`](.claude/agents/aurialis-security.md) | **Cybersecurity Engineer** | Codebase & supply-chain security, host-machine protection for local users, Audio Content Disarm & Reconstruction (CDR), anti-polyglot/payload-stashing, DNS-rebinding & localhost CSRF defense. |
| [`aurialis-qa`](.claude/agents/aurialis-qa.md) | **QA Tester** | Breaks code & hunts edge cases using Playwright frontend E2E/responsive/a11y tests, the War-Room Audio Transformation Verification Suite (`*_verify_test.go`), Postman/Newman, raw `curl` probes, and Vitest. Collaborates with Devil's Advocate, Audio/DSP Engineers, and Cybersecurity Engineer. |
| [`aurialis-devils-advocate`](.claude/agents/aurialis-devils-advocate.md) | **Devil's Advocate** | Challenges whether features work properly, whether they are needed or bloat, and shoots down premature "finished" claims when features, edge cases, or studio polish are missing. |
| [`aurialis-tech-writer`](.claude/agents/aurialis-tech-writer.md) | **Technical Writer** | Keeps `README.md`, `docs/api.md`, `docs/architecture.md`, `docs/tasks.md`, and `.claude/war-room/ledger.md` 100% synchronized with code. All developers catch up with Tech Writer on every change. |
| [`aurialis-product-engineer`](.claude/agents/aurialis-product-engineer.md) | **Product Engineer** | Owns requirements, vertical-slice completeness, small readable commits, peer-agent review handoffs, Tech Writer sync, and merging finished branches to `main`. |

### Invoking the War Room

- **`/war-room <scope>`** (e.g., `/war-room feature=deep-mastering`, `/war-room feature=smart-split`, `/war-room ci-cd`):
  Convenes 3–5 relevant seats on a specific feature or CI/CD problem (Rounds 0 → A → B → C → D) and records rulings in [`.claude/war-room/ledger.md`](.claude/war-room/ledger.md).
- **`/war-room-loop [scope|feature=<name>|ci-cd|resume] [max-iterations=N] [merge=owner|delegated]`**:
  Runs the pessimistic scrutiny and implementation loop (`review → rule → implement in small commits → tech-writer sync → QA + Devil's Advocate break-test → Product Engineer merge → repeat`). The loop **presumes the feature or codebase is incomplete** until every layer, edge case, responsive viewport, and doc is proven by execution evidence.

See [`.claude/agents/README.md`](.claude/agents/README.md), [`.claude/war-room/protocol.md`](.claude/war-room/protocol.md), and [`.claude/war-room/cross-model-guide.md`](.claude/war-room/cross-model-guide.md) for full details.
