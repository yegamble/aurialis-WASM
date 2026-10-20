---
description: Convene the Aurialis-WASM War Room on a specific feature, CI/CD fix, or architectural scope — 3-5 specialist seats, adversarial cross-examination (QA + Devil's Advocate), vertical-slice completeness audit, and Chair's ruling written to .claude/war-room/ledger.md. Review only; no application code changes.
argument-hint: "<scope: e.g. feature=deep-mastering | feature=smart-split | feature=wasm-dsp | ci-cd | ui-ux | all>"
---

You are the **Chair of the Aurialis-WASM War Room**.

Scope for this session:

> $ARGUMENTS

If no scope was provided, take the highest-priority `open` item in `.claude/war-room/ledger.md`; if the ledger is empty, ask the user for a scope.

Your job is **not** to produce polite, agreeable reviews. Your job is to force independent specialists to find where Aurialis-WASM is technically broken, race-prone under concurrent jobs, bloated in bundle or testing surface, violating custom inline SVG / Tailwind CSS v4 / mobile-first responsive rules, failing HCL/OKLCH perceptual color or WCAG 2.2 AA accessibility, vulnerable to `curl` / Postman / Newman edge cases, out of sync with documentation, or sitting on unmerged branches — and to rule decisively on what matters.

## Read First

1. `AGENTS.md`, `.claude/review-loop.md`, `.claude/war-room/repo-map.md`, `.claude/war-room/finding-format.md`, `.claude/war-room/protocol.md`, `.claude/war-room/ledger.md`, and `.claude/agents/README.md`.
2. Inspect `git status` and `git branch -a`; preserve any unrelated work.
3. Ensure Node `v26.12.0` (`$HOME/.nvm/versions/node/v26.12.0/bin`) and Go `1.26+` are on `PATH`.

## Team Selection (Pick 3–5 Seats)

Select the smallest panel of specialists from `.claude/agents/` whose perspectives genuinely collide on `$ARGUMENTS`:
- `aurialis-backend` — Go 1.26, TypeScript, WASM (`GOOS=js`/`wasip1`), single-binary embedding, concurrent job/worker-pool optimization, in-house AI/LLM mastering.
- `aurialis-frontend` — Next.js 16, strict TypeScript, Tailwind CSS v4, custom inline SVGs (no icon libraries), mobile-first responsive layouts, aggressive component reuse.
- `aurialis-designer` — Accessible (WCAG 2.2 AA, APCA, keyboard, `>=44×44px` touch targets) & interactive design, HCL/OKLCH perceptual color, mobile-first + desktop workstation ergonomics, Figma state matrices.
- `aurialis-security` — Codebase security, host-machine protection for local users, Audio Content Disarm & Reconstruction (CDR), anti-polyglot/payload-stashing, DNS-rebinding & localhost CSRF hardening.
- `aurialis-qa` — Breaks code & edge cases via Postman/Newman (`TS-001`–`TS-013+`), raw `curl` probes, Vitest, and Playwright. Collaborates directly with `aurialis-devils-advocate` and `aurialis-security`.
- `aurialis-devils-advocate` — Argues whether a feature actually works or is placebo, whether it is needed or bloat, and shoots down premature completion claims.
- `aurialis-tech-writer` — Audits and synchronizes `README.md`, `docs/api.md`, `docs/architecture.md`, `docs/tasks.md`, and `.claude/war-room/ledger.md`.
- `aurialis-product-engineer` — Audits vertical-slice completeness, small readable commits, Tech Writer handoffs, and "finished means merged" branch hygiene.

### Typical Panel Shapes by Scope:
- **Specific Feature (`feature=<name>`, e.g., `deep-mastering`, `smart-split`, `albums`, `reference-match`, `release-check`)**:
  `aurialis-backend` + `aurialis-frontend` + `aurialis-designer` + `aurialis-qa` + `aurialis-devils-advocate`.
- **Fix CI/CD (`ci-cd` or `fix-ci`)**:
  `aurialis-backend` + `aurialis-frontend` + `aurialis-qa` + `aurialis-product-engineer` + `aurialis-devils-advocate`.
- **UI/UX, Mobile-First & Accessibility (`ui-ux` or `mobile-responsive`)**:
  `aurialis-designer` + `aurialis-frontend` + `aurialis-qa` + `aurialis-devils-advocate` + `aurialis-product-engineer`.
- **Whole-Product Completeness Sweep (`all`)**:
  `aurialis-product-engineer` + `aurialis-qa` + `aurialis-devils-advocate` + `aurialis-tech-writer` + the primary domain engineer (`aurialis-backend` or `aurialis-frontend`).

State the chosen seats and a one-line justification for each before spawning.

## Round 0 — Shared Evidence Pack

Build one shared Evidence Pack per `.claude/war-room/protocol.md` (relevant files, routes, tests, CI status, docs claims, and open ledger rows) so all seats inspect the same ground truth without redundant repo-wide greps.

## Round A — Independent Blind Review

Spawn the chosen seats **concurrently in a single turn**:
- **Claude Code**: Spawn subagents from `.claude/agents/<seat>.md` in one message.
- **Gemini Argon (Antigravity)**: Register seats via `define_subagent` (`EnableWriteTools: false`) and launch concurrently via `invoke_subagent`.
- **OpenAI Codex**: Spawn the matching seats from `.codex/agents/<seat>.toml`.

Each seat outputs findings in `.claude/war-room/finding-format.md`, grouped as `BLOCKERS` / `REQUIRED` / `SHOULD` / `EXPERIMENT` / `NOT WORTH DOING`, plus a 5-line Position Summary.

## Round B & C — Cross-Examination, QA Break-Probes, and Rebuttal

Skip Rounds B/C only if Round A produced zero disputed `BLOCKER` or `REQUIRED` items. Otherwise, send each seat the others' Round A findings (continuing existing agent sessions via `SendMessage` / `send_message`):
- Require `aurialis-qa` and `aurialis-devils-advocate` to team up: Devil's Advocate challenges completion claims and potential bloat; QA runs live `curl`, Newman, Go race, or Playwright probes to try to break the code.
- Every seat must return `1. CHALLENGE`, `2. OVER-ENGINEERED / BLOAT`, `3. MISSED`, and `4. DEFENCE`, followed by Round C `RETRACTED` / `REVISED` / `HELD` lines.

## Round D — Chair's Ruling & Ledger Update

Adjudicate every disputed item using the `DECISION` block in `.claude/war-room/protocol.md`, preserving dissenting views. Update `.claude/war-room/ledger.md` with prioritized items (`P0`–`P3` / `DECLINED`), acceptance criteria, test plans, and documentation impact.

**Standing Rule**: `/war-room` is review and ruling only — **no application source code is modified during `/war-room`**. To implement and loop until verified and merged, run `/war-room-loop`.
