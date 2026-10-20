---
name: war-room-loop
description: >-
  Run the Aurialis-WASM War Room as a pessimistic iterative loop (review -> rule ->
  implement in small atomic commits -> Technical Writer doc sync -> QA + Devil's
  Advocate break-testing -> Product Engineer merge gate -> repeat). Use when the
  user invokes /war-room-loop or wants the agents to build, fix, and relentlessly
  scrutinize a specific feature, CI/CD pipeline, or the entire codebase until
  100% verified.
---

# Aurialis-WASM Pessimistic War Room Loop (`/war-room-loop`)

You are the **Chair of the Aurialis-WASM War Room**, running the pessimistic completion loop defined in [`.claude/commands/war-room-loop.md`](../../.claude/commands/war-room-loop.md) and [`.claude/war-room/protocol.md`](../../.claude/war-room/protocol.md).

## 1. Pessimistic Stance

**Presume the target feature, CI/CD pipeline, or codebase is INCOMPLETE until proven by execution evidence.**
- Every completion claim by an implementing engineer is challenged by [`aurialis-devils-advocate`](../../.claude/agents/aurialis-devils-advocate.md) (checking for placebo UI, unnecessary dependencies/bloat, missing vertical-slice requirements, or sub-studio polish) and [`aurialis-qa`](../../.claude/agents/aurialis-qa.md) (attempting to break the code via Postman/Newman, raw `curl` requests, corrupted audio files, concurrency races, and `320px–1440px` Playwright mobile/desktop + axe WCAG 2.2 AA tests).
- Every code change must be committed in **small, atomic, readable commits** enforced by [`aurialis-product-engineer`](../../.claude/agents/aurialis-product-engineer.md), reviewed by peer engineer seats, and synchronized with [`aurialis-tech-writer`](../../.claude/agents/aurialis-tech-writer.md) (`README.md`, `docs/api.md`, `docs/architecture.md`, `docs/tasks.md`, `.claude/war-room/ledger.md`) before merge.

## 2. Loop Workflow Per Iteration

1. **Preflight & Scope**:
   - Parse arguments: `feature=<name>` (work only on that feature), `ci-cd` (fix CI/CD & build gates), `all` / `resume` (whole-product sweep), `max-iterations=N` (default 4), `merge=owner|delegated` (default `owner`).
   - Prepend `$HOME/.nvm/versions/node/v26.12.0/bin` to `PATH`.
   - Inspect `git status`, `git branch -a`, and [`.claude/war-room/ledger.md`](../../.claude/war-room/ledger.md).
2. **War Room Council (Rounds 0–D)**:
   - If fewer than 3 ready `P0`/`P1` items exist for the scope (or after completing a fix wave), run a `/war-room` sweep on the scope to surface and rule on all gaps.
3. **Implementation Wave (Isolated Worktrees + Small Atomic Commits)**:
   - Dispatch up to 3 non-overlapping `P0`/`P1` items to the owning engineers (`aurialis-backend`, `aurialis-dsp-plugin-engineer`, `aurialis-audio-engineer`, `aurialis-grammy-veteran`, `aurialis-frontend`, `aurialis-designer`, `aurialis-security`, `aurialis-qa`):
     - **Gemini Argon (Antigravity)**: `define_subagent` with `EnableWriteTools: true`, then `invoke_subagent` with `Workspace: "share"` (or `"branch"` / `"inherit"` for non-overlapping files).
     - **Claude Code**: `isolation: "worktree"`.
     - **OpenAI Codex**: Parallel subagent worktrees.
   - Engineers commit in small, readable commits (`feat(...): ...`, `fix(...): ...`, `test(...): ...`).
4. **Mandatory Technical Writer Sync (`aurialis-tech-writer`)**:
   - Have `aurialis-tech-writer` review the engineers' diffs and commit synchronized updates to `README.md`, `docs/api.md`, `docs/architecture.md`, `docs/tasks.md`, and `.claude/war-room/ledger.md`.
5. **Fail-Fast Static & Runtime Quality Gates**:
   - **Go & WASM**: `"$(go env GOROOT)/bin/gofmt" -l cmd internal wasm`, `go mod verify`, `go vet ./...`, `golangci-lint run ./...`, `identypo ./...`, `govulncheck ./...`, `go test -race -count=1 ./...`, `GOOS=js GOARCH=wasm go build -o public/wasm/aurialis-dsp.wasm ./wasm/dsp`.
   - **Next.js 16 & TypeScript**: `pnpm exec tsc --noEmit`, `pnpm run lint` (`--max-warnings=0`), `pnpm exec knip`, `pnpm exec cspell lint "**/*.{ts,tsx,go,md}"`, `pnpm test`, `pnpm run build`.
   - **API & E2E**: `MAX_UPLOAD_BYTES_OVERRIDE=209715200 pnpm run test:backend:postman` and `pnpm exec playwright test`.
6. **Round E — Pessimistic Verification & Merge Gate**:
   - Dispatch `aurialis-qa` and `aurialis-devils-advocate` (read-only) to break-test the integrated branch, plus `aurialis-tech-writer` and `aurialis-product-engineer`.
   - If any test, `curl` probe, responsive viewport (`320px–1440px`), contrast check, or doc sync fails: reopen the ledger item (`VERDICT: INCOMPLETE — SEND BACK TO WAR ROOM LOOP`) and start the next iteration.
   - If verified (`VERDICT: VERIFIED`): `aurialis-product-engineer` merges the branch to `main` (or marks `open — awaiting merge` if owner-gated), deletes the merged work branch, and records the commit SHA and evidence tier in `.claude/war-room/ledger.md`.
