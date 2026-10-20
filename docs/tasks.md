# Aurialis-WASM Developer Task Tracker

Maintained by [`aurialis-tech-writer`](../.claude/agents/aurialis-tech-writer.md) and [`aurialis-product-engineer`](../.claude/agents/aurialis-product-engineer.md). Every engineer agent (`aurialis-backend`, `aurialis-frontend`, `aurialis-designer`, `aurialis-qa`) must catch up with `aurialis-tech-writer` to update this file and [`.claude/war-room/ledger.md`](../.claude/war-room/ledger.md) before merging a branch to `main`.

---

## Workflow Rules

1. **Small, Atomic Commits**: Break every task below into small, single-concern commits (`feat`, `fix`, `test`, `docs`) on a short-lived branch.
2. **Developer → Technical Writer Catch-Up**: Before requesting final QA/Product Engineer sign-off, brief `aurialis-tech-writer` on any changed flags, endpoints, components, or test commands so `README.md`, `docs/api.md`, `docs/architecture.md`, and this file are updated in the same branch.
3. **Pessimistic Verification (`aurialis-qa` + `aurialis-devils-advocate`)**: No task moves to `verified` until all fail-fast static checks (`golangci-lint`, `identypo`, `govulncheck`, `tsc --noEmit`, `eslint --max-warnings=0`, `knip`, `cspell`), Postman/Newman (`TS-001`–`TS-013`), `curl` probes, and Playwright `320px–1440px` responsive + axe WCAG 2.2 AA tests pass.
4. **Finished Means Merged (`aurialis-product-engineer`)**: Merge verified branches into `main` immediately and delete the merged work branch.

---

## Task Checklist

- [ ] **`WASM-1` (P0)**: Single Go 1.26 + Next.js 16 (`pnpm`, Node 26) scaffold & `//go:embed` server (`cmd/aurialis`) with COOP/COEP headers.
- [ ] **`WASM-2` (P0)**: Warm editorial HCL/OKLCH design system tokens, custom inline SVG `<Icon />` primitive (zero icon libraries), and mobile-first responsive `AppShell` (`320px–1440px+`).
- [ ] **`WASM-3` (P0)**: Go/WASM DSP core (`wasm/dsp`) + `AudioWorklet` / `SharedArrayBuffer` lock-free bridge (5-band EQ, compressor, limiter, saturation, stereo width, LUFS/True-Peak metering).
- [ ] **`WASM-4` (P1)**: Concurrent job engine (`internal/jobs`) + audio upload validation (magic bytes, `413` size cap, CRLF/path-traversal sanitization, `DELETE /jobs/{id}` cancellation).
- [ ] **`WASM-5` (P1)**: Upload/Home (`/`) & persisted IndexedDB Library (`/library`) reusing `Button`, `DropZone`, `StatusBadge`, `Modal`.
- [ ] **`WASM-6` (P1)**: Mastering Workspace (`/master/[trackId]`): Transport, custom SVG Waveform, Simple mode, Advanced 5-band EQ/DSP mode, and 16/24/32-bit WAV export with TPDF dither.
- [ ] **`WASM-7` (P1)**: In-house Deep Mastering (`MasteringScript` v1): 5 engineer profiles, section detection, AI-artifact analysis (`AI Repair`), and responsive 5-lane automation timeline + mobile bottom-sheet move editor.
- [ ] **`WASM-8` (P1)**: Smart Stem Splitter (`/split/[trackId]`) with exact `2–6` stem selector, post-processing count-change confirmation, and "Send to mastering".
- [ ] **`WASM-9` (P2)**: Albums (`/albums`, `/albums/[albumId]`), Reference Match (`/reference/[trackId]`), and Release Check (`/release-check/[trackId]`).
- [ ] **`WASM-10` (P1)**: Unified GitHub Actions CI/CD pipeline (`.github/workflows/ci.yml`) enforcing all Go, WASM, Next.js/TS, Newman, and Playwright gates.
