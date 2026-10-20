# Pessimistic Completion Scrutiny Loop

Adapted from `opsecmkt` and `vidra` for **Aurialis-WASM** (Go 1.26 + Next.js 16 + WASM single binary, Tailwind CSS v4, custom inline SVGs, mobile-first responsive UI, in-house AI/LLM mastering).

**Core Axiom**: *Presume the feature or codebase is INCOMPLETE until proven otherwise by execution evidence.* A checked task list, a compiling Go binary, or a passing unit test alone never proves that a complete user/audio workflow works end-to-end.

1. **Establish Scope & Acceptance Criteria**:
   - Inspect `git status` and `git branch` first; preserve unrelated work.
   - Read relevant Go packages (`cmd/aurialis`, `internal/`, `wasm/`), Next.js routes/components (`src/`), design specifications (`docs/design/aurialis-redesign.md`), tests, and `.claude/war-room/ledger.md` before judging whether a task is done.
   - Determine whether the invocation targets a **specific feature** (`feature=<name>`), **CI/CD recovery** (`ci-cd`), or a **whole-product completeness sweep** (`all`).

2. **Implement in Small, Atomic, Readable Commits**:
   - Stay strictly within the requested scope.
   - Follow the **Product Engineer** (`aurialis-product-engineer`) commit contract: break work into small, single-concern commits with clear messages so peer engineer agents can review each diff without cognitive overload.
   - Enforce stack rules at every step:
     - Latest Node (`v26.12.0`), `pnpm` (`10.33.0`), Next.js 16, Go 1.26.
     - Tailwind CSS v4 + **hand-crafted inline SVGs only** (no `lucide-react` or icon libraries).
     - Maximum component reuse (`Button`, `Icon`, `SliderField`, `SegmentedControl`, `Toggle`, `Modal`, `BottomSheet`, `Waveform`, `SpectrumChart`, `DeepTimeline`, `Transport`, `MetricStrip`).
     - **Mobile-first** (`320px–390px`) responsive design scaling cleanly to tablet (`768px`) and desktop workstation (`1024px–1440px+`), with `>=44×44px` touch targets and HCL/OKLCH perceptual color tokens.

3. **Synchronize with the Technical Writer (`aurialis-tech-writer`)**:
   - Before declaring any code slice ready for verification, catch up with `aurialis-tech-writer` to update `README.md`, `docs/api.md`, `docs/architecture.md`, `docs/tasks.md`, and `.claude/war-room/ledger.md`.
   - Code and documentation must tell the exact same story in the same branch before merge.

4. **Run Mandatory Verification Gates**:
   - Run the applicable gates from `AGENTS.md` and `.claude/war-room/repo-map.md`.
   - Record exact commands and actual outcomes, including skipped suites or unavailable prerequisites.

5. **Switch to Pessimistic Adversarial Review (`aurialis-qa` + `aurialis-devils-advocate`)**:
   - Re-read the original request and `git diff main...HEAD`.
   - Ask: *"What would disprove this completion claim?"*
   - **`aurialis-qa`** probes the running Go binary and UI with:
     - **Postman/Newman** (`pnpm run test:backend:postman`) and raw **`curl`** requests: malformed multipart uploads, spoofed magic bytes (`.pdf`/`.exe` renamed `.wav`), `250MB+` oversized payloads (`413`), corrupted RIFF/WAV headers, zero-duration/mono-8kHz/96kHz files, CRLF/path-traversal filenames (`../`), rapid job cancel/retry races, concurrent job saturation, and COOP/COEP headers (`Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp`).
     - **Playwright & Responsive/A11y checks**: `320px`, `375px`, `768px`, `1024px`, `1440px` viewports, keyboard-only navigation, focus trapping, screen-reader text summaries on SVG charts, and `prefers-reduced-motion`.
   - **`aurialis-devils-advocate`** challenges:
     - Whether UI controls actually wire into the WASM DSP / Go backend or are decorative placebo sliders.
     - Whether a feature or abstraction is unnecessary bloat or leaves testing bloat behind.
     - Whether other roadmap features in `docs/design/aurialis-redesign.md` or `.claude/war-room/ledger.md` remain incomplete or below professional studio quality.

6. **Record & Fix Findings**:
   - Record every defect using `.claude/war-room/finding-format.md` with severity, `file:line`, reproducible trigger (`curl` / Newman / Playwright / `go test`), user impact, and verification step.
   - Fix required in-scope defects in small commits, sync docs with `aurialis-tech-writer`, and return to Step 4.

7. **Merge Gate ("Finished Means Merged")**:
   - Finish only when zero unresolved `BLOCKER` or `REQUIRED` in-scope findings remain, all verification gates pass, `aurialis-tech-writer` signs off on docs, and `aurialis-product-engineer` confirms the branch is merged to `main` (or explicitly reported as `open — awaiting merge` if merge is owner-gated).
