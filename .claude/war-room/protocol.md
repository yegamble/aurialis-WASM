# War-Room Protocol — How `war-room` and `war-room-loop` Run

The **Chair** (the primary orchestrator session in **Gemini Argon**, **Claude Code**, or **OpenAI Codex**) runs the rounds and enforces the protocol. Every specialist seat obeys its round and tool boundaries.

---

## 1. Invocation Modes & Scope Targeting

Both `/war-room` and `/war-room-loop` accept a scope argument so the user can target a **single feature**, **CI/CD fixes**, or a **whole-codebase completeness audit**:

| Scope Argument | What It Targets | Default Seats Convened |
|---|---|---|
| `feature=<name>` (or `<feature name>`, e.g., `deep-mastering`, `smart-split`, `wasm-dsp`, `albums`, `reference-match`, `release-check`, `upload-library`) | Only the specified feature's vertical slice (Go API/worker + WASM DSP + Next.js mobile/desktop UI + tests + docs) | `aurialis-backend`, `aurialis-frontend`, `aurialis-designer`, `aurialis-qa`, `aurialis-devils-advocate` (+ `aurialis-tech-writer` & `aurialis-product-engineer` for doc/commit gates) |
| `ci-cd` (or `fix-ci`, `pipeline`, `build`) | GitHub Actions workflows, Go/WASM compilation, Next.js 16 + `pnpm` build, Newman runner, Playwright harness, flaky or failing gates | `aurialis-backend`, `aurialis-frontend`, `aurialis-qa`, `aurialis-product-engineer`, `aurialis-devils-advocate` |
| `ui-ux` (or `mobile`, `responsive`, `a11y`, `design`) | Mobile-first responsive layouts (`320px–1440px`), HCL/OKLCH tokens, WCAG 2.2 AA, custom inline SVGs, component reuse | `aurialis-designer`, `aurialis-frontend`, `aurialis-qa`, `aurialis-devils-advocate`, `aurialis-product-engineer` |
| `backend-wasm` (or `concurrency`, `dsp`, `jobs`) | Single Go binary embedding, WASM DSP bridge, worker-pool optimization, memory/goroutine safety, Newman/cURL API verification | `aurialis-backend`, `aurialis-qa`, `aurialis-devils-advocate`, `aurialis-product-engineer`, `aurialis-tech-writer` |
| `all` (or omitted / `resume`) | Full-product pessimistic completeness sweep across `.claude/war-room/ledger.md` | 3–5 seats rotated per sweep area, always including `aurialis-qa` and `aurialis-devils-advocate` before any completion claim |

---

## 2. Round 0 — Shared Evidence Pack (Chair, Before Spawning Seats)

Enumeration is not judgment. Before Round A, the Chair builds one **Evidence Pack** for the target scope (either directly or with one lightweight retrieval subagent):
- Relevant Go files (`cmd/aurialis/`, `internal/`, `wasm/`), Next.js routes & components (`src/`), tests (`tests/postman/`, `e2e/`), CI logs, and docs (`README.md`, `docs/api.md`, `docs/architecture.md`, `docs/tasks.md`, `docs/design/aurialis-redesign.md`).
- Current `git status`, `git branch -a`, recent commit log (`git log -n 10 --oneline`), and open rows in `.claude/war-room/ledger.md`.
- Every spawned seat receives this exact Evidence Pack so all seats argue over the same files and state rather than paying 5× to grep the repo independently.

---

## 3. Round A — Blind Independent Review

The Chair spawns the selected **3–5 specialist seats concurrently** in a single turn.
- During Round A, seats are **strictly read-only** on source code (`Read`, `Grep`, `Glob`, `Bash` for inspection/test execution/cURL probes only — never `Edit`, `Write`, `git commit`, or `git push`).
- Each seat investigates independently without seeing the other seats' conclusions.
- Each seat outputs findings in `.claude/war-room/finding-format.md`, grouped as:
  ```text
  BLOCKERS
  REQUIRED
  SHOULD
  EXPERIMENT
  NOT WORTH DOING   ← mandatory: in-scope ideas or abstractions declined as bloat, with why
  ```
- Each seat closes with a **Position Summary** (max 5 lines: what you conclude and what concrete evidence would falsify your view).

---

## 4. Round B — Cross-Examination & Adversarial Break-Testing

When Round A completes, the Chair sends each seat's Round A findings to the other seats (continuing existing subagent sessions via `send_message` / `SendMessage` so context is preserved).
- **Special QA ↔ Devil's Advocate Pairing**:
  - `aurialis-devils-advocate` attacks every claim that a feature "works", questions whether proposed features/abstractions are even needed or are bloat, and flags any gap between studio-grade expectations and current code.
  - `aurialis-qa` takes the claims from `aurialis-backend`, `aurialis-frontend`, and `aurialis-designer` plus the skepticism from `aurialis-devils-advocate` and attempts to **break the code live** (via `curl`, Postman/Newman, Vitest, Playwright, or Go race tests).
- Every seat **must** return all four sections:
  1. **CHALLENGE** — Attack at least one substantive recommendation or completion claim of another seat with `file:line` or execution evidence.
  2. **OVER-ENGINEERED / BLOAT** — Identify at least one proposal, dependency, or duplicated component that adds unnecessary bundle or testing bloat.
  3. **MISSED** — Highlight one edge case, mobile/responsive flaw, concurrency hazard, or doc drift inside your domain that other seats overlooked.
  4. **DEFENCE** — Answer every challenge aimed at your seat with concrete evidence.

---

## 5. Round C — Rebuttal & Position Revision

Each seat responds concisely to Round B challenges:
```text
RETRACTED: <finding-id> — <who disproved it and with what evidence>
REVISED:   <finding-id> — <old severity/scope> → <new severity/scope> — <why>
HELD:      <finding-id> — <the challenge> — <why the evidence still stands>
```
Changing position when shown concrete counter-evidence is a **success**. Clinging to a disproven opinion is a failure.

---

## 6. Round D — Chair's Ruling & Ledger Update

The Chair does **not** majority-vote; arguments that survive evidence and cross-examination win. For each disputed item, the Chair records:
```text
DECISION:            ACCEPT | MODIFY | EXPERIMENT | DEFER | REJECT | BLOCK RELEASE
WHY:
DISSENTING VIEW:     (name the seat; never erase a losing technical argument)
AFFECTED LAYER:      go-backend | wasm-dsp | nextjs-ui | mobile-responsive | a11y-hcl | qa-newman | docs | ci-cd
USER / AUDIO IMPACT:
BUNDLE / TEST IMPACT:
ACCEPTANCE CRITERIA:
TEST PLAN:
DOCS TO UPDATE:
```
The Chair then updates `.claude/war-room/ledger.md` with prioritized items (`P0` release blockers · `P1` required for vertical-slice completeness · `P2` high-value improvements · `P3` experiments · `DECLINED` with reason).

- **If invoked via `/war-room <scope>`**: Stop here and present the ruling and updated ledger to the user. No application code is modified during `/war-room`.
- **If invoked via `/war-room-loop`**: Proceed immediately to Step 7 (Implementation Wave) and Step 8 (Round E Pessimistic Verification).

---

## 7. Implementation Wave (`/war-room-loop` Only)

When `/war-room-loop` runs an implementation wave on ready `P0`/`P1` ledger items:

1. **Non-Overlapping Worktree / Branch Assignment**:
   - Assign up to 3 non-overlapping ledger items to the appropriate implementation engineers (`aurialis-backend` for Go/WASM/API/CI, `aurialis-frontend` for Next.js/Tailwind/SVG/mobile-first UI, `aurialis-designer` for HCL/OKLCH tokens & Figma design states, `aurialis-qa` for Newman/Playwright/test fixtures).
   - Never run two agents editing the same files in the same wave; use isolated git worktrees (`isolation: "worktree"` in Claude Code, `Workspace: "share"`/`"branch"` in Gemini Argon, or separate worktree directories in Codex).
2. **Product Engineer's Atomic Commit Discipline (`aurialis-product-engineer`)**:
   - Every engineer commits work in **small, atomic, readable commits** on a scoped branch (`feat/...`, `fix/...`, `test/...`, `docs/...`).
   - Engineers review each other's commits for code reuse, zero icon libraries, mobile-first responsiveness, and concurrency safety.
3. **Mandatory Technical Writer Catch-Up (`aurialis-tech-writer`)**:
   - Before an engineer marks a slice ready for verification, the engineer catches up with `aurialis-tech-writer`.
   - `aurialis-tech-writer` updates `README.md`, `docs/api.md`, `docs/architecture.md`, `docs/tasks.md`, and `.claude/war-room/ledger.md` in a dedicated `docs(...): ...` commit on the branch so docs never lag behind code.

---

## 8. Round E — Pessimistic Verification & Merge Gate (`/war-room-loop`)

The loop is **explicitly pessimistic**: it assumes the implementation is still broken or incomplete until proven otherwise.

1. **Adversarial Verification Quartet**:
   - **`aurialis-qa`**: Runs the full verification gate (`go test -race`, WASM build, `pnpm run lint`, `tsc`, `vitest`, `next build`, Postman/Newman `PR Suite`, live `curl` edge-case probes, and Playwright mobile/desktop responsive + axe a11y checks) and tries new adversarial inputs to break the fix.
   - **`aurialis-devils-advocate`**: Audits the integrated diff to check for fake/placebo wiring, unrequested bloat, skipped tests, missing edge cases, or unfinished adjacent requirements.
   - **`aurialis-tech-writer`**: Verifies that every changed flag, endpoint, component, and task status matches `README.md` and `docs/`.
   - **`aurialis-product-engineer`**: Verifies commit granularity, clean branch history, vertical-slice completeness, and merge readiness.
2. **Verdict**:
   - **`VERDICT: VERIFIED`** → `aurialis-product-engineer` merges the finished branch into `main` (when `merge=delegated` or local integration branch; or marks `open — awaiting merge` if owner-gated), deletes the merged work branch, and updates `.claude/war-room/ledger.md`.
   - **`VERDICT: INCOMPLETE — SEND BACK TO WAR ROOM LOOP`** → Any failing criterion, broken `curl`/Newman/Playwright probe, mobile overflow, icon-library import, missing doc update, or sloppy commit history reopens the ledger item and triggers the next loop iteration.
