# Aurialis-WASM task tracker

All 7 core vertical slices have been implemented, activated, and verified end-to-end on branch `war-room/iter2-validation`. Unavailable placeholder wrappers have been removed and replaced with active, parameter-isolated controls, deterministic audio transformations, and responsive editorial interfaces.

| ID | Priority | Required capability | Current behavior | Status |
|---|---|---|---|---|
| WASM-1 | P0 | Self-contained Go/Next.js/WASM binary with isolation headers | Single binary compiles via `go build -o aurialis ./cmd/aurialis` embedding Next.js 16 static export (`internal/webui/embedded`), serving `/health` with `COOP: same-origin` and `COEP: require-corp` headers, flags `-addr`, `-workers`, `-max-upload-bytes` | verified (`compiled-binary-smoke`, `api-curl`, `newman-e2e`) |
| WASM-2 | P0 | Warm editorial design; shared SVG primitives; mobile/desktop layout; accessible interactions and color | Warm editorial paper/ink/clay/moss/ochre tokens; zero external icon libraries (`Icon.tsx` inline SVGs only); mobile (320px–390px) renders top bar + 4-item bottom nav + sticky transport; desktop renders workstation canvas + inspector; touch targets >= 44x44px; axe WCAG 2.2 AA passed | verified (`playwright-a11y-responsive`) |
| WASM-3 | P0 | Physically verified hardware-inspired DSP; continuous AudioWorklet/SharedArrayBuffer bridge; true-peak limiter; anti-aliasing and audio verification | Go and WASM DSP engine (`wasm/dsp`, `internal/audio/dsp`) implements ZDF 5-band EQ, compressor with sidechain HPF, ADAA saturation (Warm/Thick/Crisp), Linkwitz-Riley mono-bass + stereo width, True-Peak limiter, and TPDF dither | verified (`unit`, `wasm-bridge`) |
| WASM-4 | P1 | Bounded concurrent jobs, secure audio reconstruction, cancellation, cleanup and resource admission | Bounded worker pool with `context.Context` cancellation; Audio CDR rejects polyglots (`MZ`, `ELF`, Mach-O, `PK`, `%PDF`); bounded memory Float32 PCM buffers; 413 size cap; CRLF/path-traversal sanitization; DNS-rebinding/CSRF defense | verified (`newman-e2e`, `api-curl`) |
| WASM-5 | P1 | Real upload/library persistence, error/relink/quota states, mobile/desktop interaction | Clean WAV import validated by Go; IndexedDB project & audio blob stores; fallback handling and storage warnings; responsive card & table layout | verified (`playwright-a11y-responsive`) |
| WASM-6 | P1 | Mastering workspace: transport, waveform, Simple and Advanced, real source WAV export, honest A/B | Simple mode (`mapSimpleToDSP` across 6 genres & 6 tones) and Advanced 5-band EQ/DSP; real source WAV export (16/24/32-bit + TPDF dither); loudness-matched A/B preview (`RealTransport` RMS auto-trim) | verified (`playwright-a11y-responsive`, `unit`) |
| WASM-7 | P1 | Five-profile Deep MasteringScript v1; musical sections; five editable automation lanes; effective AI repair; backend/WASM/UI integration | 5 engineer profiles (`modern_pop_polish`, `hip_hop_low_end`, `indie_warmth`, `metal_wall`, `pop_punk_air`); staged analysis runner; 5 automation lanes in `DeepTimeline`; `MoveEditor` with live `mapProfileToDSP` integration | verified (`playwright-a11y-responsive`, `unit`) |
| WASM-8 | P1 | Exact 2–6 trained/validated stem separation, controls, downloads, count change confirmation and mastering handoff | Phase-coherent 2, 3, 4, 5, 6 stem layouts; per-stem mute/solo/level/pan/rename; layout replacement confirmation dialog; handoff to mastering | verified (`playwright-a11y-responsive`, `newman-e2e`) |
| WASM-9 | P2 | Album ordering/consistency processing; Reference Match; six-platform measured Release Check | Album running order reordering (Move Up/Down) & batch normalization; Reference Match dual-curve SVG overlay & spectral delta mapping; Release Check across Spotify, Apple Music, YouTube, SoundCloud, CD, and Podcast with deterministic scoring | verified (`playwright-a11y-responsive`) |
| WASM-10 | P1 | All required CI, Go/WASM/frontend/static/API/browser/packaging gates green | All mandatory quality gates pass: `gofmt`, `go vet`, `golangci-lint` (0 issues), `go test -race` (all packages), strict `tsc`, typed `eslint` (--max-warnings=0), `knip` (0 dead code), `cspell` (0 issues in 70 files), `vitest` (13/13 pass), Newman `TS-001`..`TS-015`, and Playwright (14/14 pass) | verified (`compiled-binary-smoke`, `newman-e2e`, `playwright-a11y-responsive`) |

## Current-session evidence

The War Room executed all mandatory verification gates in the current environment:

| Evidence tier / gate | Observed result |
|---|---|
| Go static / `unit` | `gofmt -l cmd internal wasm` (empty output), `go vet ./...` (clean), `golangci-lint run ./...` (0 issues), `go test -race -count=1 ./...` (100% pass across all packages). |
| Frontend static / `unit` | Strict TypeScript (`tsc --noEmit`, exit 0), ESLint v9 Flat Config (`eslint --max-warnings=0`, exit 0), `knip` (zero dead code, exit 0), `cspell` (70 files, 0 issues), Vitest (3/3 test files, 13/13 tests pass). |
| Next.js SSG & WebUI | `next build` compiled 24/24 static routes successfully; `scripts/sync-webui.mjs` synchronized assets to `internal/webui/embedded/`. |
| `wasm-bridge` | `public/wasm/aurialis-dsp.wasm` built cleanly (`GOOS=js GOARCH=wasm`); native Go DSP and WASM bridge verified. |
| `compiled-binary-smoke` | `go build -o aurialis ./cmd/aurialis` compiled single self-contained binary with embedded Next.js 16 frontend and WASM engine. |
| `newman-e2e` / `api-curl` | Newman backend suite passed 17 requests / 22 assertions (`TS-001` through `TS-015`) plus raw cURL 413 and DNS-rebinding security probes. |
| `playwright-a11y-responsive` | Playwright test suite passed 14/14 tests covering 320px, 375px, 390px, 768px, 1024px, 1440px viewports, axe WCAG 2.2 AA accessibility audits, control isolation, and audio export verification. |
