---
description: Run the Aurialis-WASM War Room as a pessimistic loop — review, rule, implement in small atomic commits, sync docs with Technical Writer, break-test with QA + Devil's Advocate, and merge via Product Engineer — repeating until the feature, CI/CD pipeline, or codebase is 100% verified.
argument-hint: "[scope: feature=<name> | ci-cd | all | resume] [max-iterations=N (default 4)] [merge=owner|delegated (default owner)]"
---

You are the **Chair of the Aurialis-WASM War Room**, running **`war-room-loop`**.

Arguments:

> $ARGUMENTS

- Default scope (if omitted): `all` (*scrutinize and complete Aurialis-WASM into a releasable single-binary Go + Next.js 16 + WASM audio mastering product*).
- Targeted feature scope: `feature=<name>` (e.g., `feature=deep-mastering`, `feature=smart-split`, `feature=wasm-dsp`, `feature=mobile-ui`, `feature=albums`). The loop works **only** on that feature until every vertical-slice layer is complete.
- CI/CD scope: `ci-cd` (or `fix-ci`). The loop inspects, fixes, and verifies build, linter, WASM, Newman, and Playwright CI/CD pipelines until every gate is green.

## Core Pessimistic Mandate

**`war-room-loop` is intentionally pessimistic**:
- Presume at the start of every iteration that the feature or codebase is **INCOMPLETE** and has hidden edge cases, mobile/responsive overflow, unwired DSP controls, missing tests, or doc drift.
- Whenever any agent claims a feature or the product is "finished", **`aurialis-devils-advocate`** and **`aurialis-qa`** must actively attempt to falsify that claim and break the implementation with `curl`, Postman/Newman, corrupted audio fixtures, concurrency races, and `320px–1440px` Playwright responsive/a11y checks.
- No item closes until **all four** sign off: `aurialis-qa` (tests & break probes pass), `aurialis-devils-advocate` (no placebo wiring, bloat, or missing slice requirements), `aurialis-tech-writer` (`README.md`, `docs/api.md`, `docs/architecture.md`, `docs/tasks.md` updated), and `aurialis-product-engineer` (small readable commits, merged to `main` or `open — awaiting merge`).

## Read First

1. Once per loop, not per iteration: `.claude/war-room/repo-map.md` and `.claude/war-room/protocol.md`. Skip files your tool already loaded as project instructions (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`). Read the ledger and the large docs by section only (`repo-map.md` §0).
2. Check `git status` and `git branch -a`; never discard unrelated work.
3. Ensure Node `v26.12.0` (`$HOME/.nvm/versions/node/v26.12.0/bin`) and Go `1.26+` are on `PATH`.

## One Loop Iteration

### Step 1: State & Branch Hygiene (`aurialis-product-engineer`)
- `python3 .claude/war-room/ledger.py start`, `live P0 P1` and `log 3`; `grep -n` the scope in `docs/tasks.md`. Never read either file whole.
- Create or reuse the working branch (or integration branch `war-room/integration` off `main`).
- Audit for any unmerged finished branches or uncommitted changes left behind from prior runs.

### Step 2: War Room Review & Ruling (Rounds 0–D)
- If fewer than 3 ruled `P0`/`P1` items exist for the current scope (or if running a fresh scrutiny sweep after fixes), run a `/war-room` session on the target scope (specific feature, `ci-cd`, or next product area in rotation: `go-wasm-binary` → `design-mobile-shell` → `wasm-dsp-engine` → `concurrent-jobs-api` → `upload-library` → `mastering-simple-advanced` → `deep-mastering-script` → `smart-split-2-6` → `albums-reference-release` → `ci-cd`).

### Step 3: Implementation Wave (Small, Readable Commits)
- Pick up to **3** non-overlapping `P0`/`P1` items from `ledger.py live P0 P1` (grouped so no two agents edit the same files concurrently).
- Paste into each implementer's prompt: the `ledger.py item <ID>` output (row, acceptance criteria, test plan), the files and functions the ruling names, and the base commit, so it does not rediscover them. While iterating it runs only the tests it is changing; it runs the full gate once at the end, through `quiet.sh`.
- Dispatch the owning implementation specialists (`aurialis-backend`, `aurialis-dsp-plugin-engineer`, `aurialis-audio-engineer`, `aurialis-grammy-veteran`, `aurialis-frontend`, `aurialis-designer`, `aurialis-security`, `aurialis-qa`) in isolated worktrees (`isolation: "worktree"` in Claude Code, `Workspace: "share"`/`"branch"` in Gemini Argon, or separate worktrees in Codex).
- **Enforce `aurialis-product-engineer` rules**:
  - Commit early and often in **small, atomic, readable commits** (`feat(wasm): ...`, `feat(ui): ...`, `fix(jobs): ...`, `test(qa): ...`).
  - Peer engineer agents review each commit diff for component reuse, custom inline SVGs (zero icon libraries), mobile-first responsive layout (`320px–1440px+`), and Go concurrency safety.

### Step 4: Mandatory Technical Writer Catch-Up (`aurialis-tech-writer`)
- Every implementing engineer catches up with **`aurialis-tech-writer`** (via `SendMessage` / `send_message`) to walk through what changed.
- `aurialis-tech-writer` updates `README.md`, `docs/api.md`, `docs/architecture.md`, `docs/tasks.md`, and `.claude/war-room/ledger.md` in an atomic `docs(...): ...` commit on the branch.

### Step 5: Full Quality Gate Execution
Run all applicable fail-fast gates from `AGENTS.md`, each through `.claude/war-room/quiet.sh <label> <command…>` so passing output stays in a log file. Read a red CI job with `gh run view <id> --log-failed | tail -n 80`, not the full log:
1. **Go & WASM**: `"$(go env GOROOT)/bin/gofmt" -l cmd internal wasm`, `go mod verify`, `go vet ./...`, `golangci-lint run ./...`, `identypo ./...`, `govulncheck ./...`, `go test -race -count=1 ./...`, `GOOS=js GOARCH=wasm go build -o public/wasm/aurialis-dsp.wasm ./wasm/dsp`.
2. **Next.js 16 & TypeScript**: `pnpm exec tsc --noEmit`, `pnpm run lint` (`--max-warnings=0`), `pnpm exec knip`, `pnpm exec cspell lint "**/*.{ts,tsx,go,md}"`, `pnpm test`, `pnpm run build`.
3. **API & E2E**: `pnpm run test:backend:postman` + `pnpm exec playwright test`.

### Step 6: Round E — Pessimistic Adversarial Verification (`aurialis-qa` + `aurialis-devils-advocate` + `aurialis-tech-writer` + `aurialis-product-engineer`)
- Dispatch **`aurialis-qa`** and **`aurialis-devils-advocate`** concurrently against the integrated branch. Paste into each prompt the items' acceptance criteria, the commits, `git diff --stat main...HEAD` and the Step 5 gate results, so they start from the diff. They still run the probes and tests each criterion names; a criterion that calls for a test is never accepted from the diff alone:
  - `aurialis-qa` runs Newman, crafts adversarial `curl` requests (corrupt WAVs, 250 MB `413` payloads, CRLF/path traversal, 15-way concurrent POST/DELETE races, COOP/COEP headers), and checks mobile (`320px`/`375px`) & desktop (`1024px`/`1440px`) Playwright viewports and keyboard/a11y flows.
  - `aurialis-devils-advocate` inspects the diff to verify the feature is genuinely wired end-to-end (no placebo UI), introduces zero bloat, and leaves no required vertical-slice gap open.
- **If ANY check or probe fails**: Mark the item back to `open` with the exact failing reproduction, and continue to the next iteration to fix it.
- **If ALL checks pass (`VERDICT: VERIFIED`)**:
  - `aurialis-product-engineer` enforces **"Finished Means Merged"**:
    - Merge the verified work branch into the target integration/`main` branch (or if `merge=owner` gates remote `main`, open/update the PR and mark `open — awaiting merge`), delete the merged feature branch, and record the commit SHA + evidence tier in `.claude/war-room/ledger.md`.

## Stop Conditions (Checked After Every Iteration)

1. **`VERDICT: 100% COMPLETE` (Scope Satisfied)**:
   - Zero open `P0`/`P1` items remain for the requested scope (`ledger.py live P0 P1` empty, and `ledger.py grep 'reopened|NOT VERIFIED|still open'` shows no unresolved recent hit), `aurialis-qa` and `aurialis-devils-advocate` ran a fresh pessimistic sweep that found zero new `BLOCKER`/`REQUIRED` defects, `aurialis-tech-writer` confirmed all docs are synchronized, all quality gates are green, and `aurialis-product-engineer` confirmed branches are merged and cleaned up.
2. **Max Iterations Reached** (default `4`): Stop and report exact progress, verified commits, and remaining open ledger items.
3. **Owner Decision or External Blocker**: Ask the user clearly, mark the item `blocked (<reason>)`, and finish independent items first.
4. **No Progress Across 3 Consecutive Iterations**: Stop and report the root blocker with diagnostic evidence.
