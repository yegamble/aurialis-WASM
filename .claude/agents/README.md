# The Aurialis-WASM War Room

Eight specialist agents that scrutinize, secure, design, build, break-test, document, and ship **Aurialis-WASM** — our single-binary **Go 1.26 + Next.js 16 + WebAssembly (WASM)** audio mastering workstation — across **Gemini Argon (Antigravity / Gemini CLI)**, **Claude Code**, and **OpenAI Codex**.

Adapted from the `opsecmkt` (`~/github/opsecmkt/.claude/agents`) and `vidra` (`~/github/vidra/.claude/agents`) war rooms for an in-house Go + Next.js + WASM audio & AI/LLM mastering stack.

---

## Launch Commands

```text
/war-room <scope>
  # Convene 3-5 specialist seats on a specific feature (e.g. `feature=deep-mastering`,
  # `feature=smart-split`, `feature=wasm-dsp`, `feature=mobile-ui`) or `ci-cd`.
  # Runs Round 0 (Evidence) -> Round A (Blind Review) -> Round B (Cross-Examination)
  # -> Round C (Rebuttal) -> Round D (Chair Ruling into .claude/war-room/ledger.md).

/war-room-loop [scope|feature=<name>|ci-cd|resume] [max-iterations=N] [merge=owner|delegated]
  # Pessimistic scrutiny & implementation loop:
  # review -> rule -> implement in small atomic commits -> Technical Writer doc sync
  # -> QA + Devil's Advocate adversarial break-test -> Product Engineer merge gate -> repeat.
  # Presumes the feature or codebase is INCOMPLETE until proven by execution evidence.
```

---

## Roster

| Agent ID | Seat / Role | Primary Question |
|---|---|---|
| [`aurialis-backend`](aurialis-backend.md) | **Backend Engineer** (Go, TypeScript, WASM, Concurrency & Audio Infrastructure) | Does the single Go binary + WASM bridge process audio and AI mastering accurately, reuse testable packages, and stay fast and race-free when multiple jobs run concurrently? |
| [`aurialis-frontend`](aurialis-frontend.md) | **Senior Frontend Engineer** (Next.js 16, TypeScript, Tailwind CSS v4, Custom Inline SVGs, Mobile-First & Component Reuse) | Is the UI built mobile-first from reusable Tailwind CSS v4 primitives and custom inline SVGs with zero icon libraries, ultra-low bundle weight, and zero test bloat? |
| [`aurialis-designer`](aurialis-designer.md) | **UI/UX Designer** (WCAG 2.2 AA Accessibility, Interactive States, HCL/OKLCH Color, Mobile-First & Figma Skills) | Is every surface measurably accessible, mobile-first (`320px–1440px+`), perceptually balanced in HCL/OKLCH, and specified across all interactive states? |
| [`aurialis-security`](aurialis-security.md) | **Cybersecurity Engineer** (Codebase Security, Host Machine Protection, Audio CDR, Anti-Polyglot/Payload-Stashing, Localhost CSRF/DNS-Rebinding Defense) | How could a malicious audio upload, polyglot file, path-traversal/RTLO filename, or cross-origin localhost request exploit our codebase or hide/execute a payload on the user's host machine? |
| [`aurialis-qa`](aurialis-qa.md) | **QA Tester** (Adversarial Breaker, Postman/Newman, cURL, Playwright, Edge Cases) | How can I break this code right now with `curl`, Newman, corrupted audio, concurrency races, or viewport torture — and working with Devil's Advocate, is it actually ready for production? |
| [`aurialis-devils-advocate`](aurialis-devils-advocate.md) | **Devil's Advocate** (Skeptic, Anti-Bloat & Anti-Placebo Challenger, Completion Gatekeeper) | Does this feature actually work or is it placebo? Is it even needed? And what missing features, edge cases, or sub-professional details prove this product is NOT finished? |
| [`aurialis-tech-writer`](aurialis-tech-writer.md) | **Technical Writer** (`README.md`, API Docs, Developer Architecture Docs, Task & Ledger Sync) | Are `README.md`, `docs/api.md`, `docs/architecture.md`, `docs/tasks.md`, and `.claude/war-room/ledger.md` 100% accurate after talking with every developer who touched code? |
| [`aurialis-product-engineer`](aurialis-product-engineer.md) | **Product Engineer** (Requirements, Vertical Slices, Small Readable Commits, "Finished Means Merged") | Does this meet the product requirements and stack rules, are changes committed in small reviewable commits synced with the Tech Writer, and is finished code merged to `main` instead of rotting on an open branch? |

---

## Team Selection by Scope

When `/war-room` or `/war-room-loop` is called with a specific scope, the Chair selects the smallest panel whose perspectives genuinely collide:

- **Specific Feature (`feature=<name>`, e.g., `deep-mastering`, `smart-split`, `albums`, `reference-match`, `release-check`)**:
  `aurialis-backend` + `aurialis-frontend` + `aurialis-designer` + `aurialis-qa` + `aurialis-devils-advocate` (with `aurialis-tech-writer` and `aurialis-product-engineer` enforcing the documentation and commit/merge gates).
- **Fix CI/CD (`ci-cd` or `fix-ci`)**:
  `aurialis-backend` + `aurialis-frontend` + `aurialis-qa` + `aurialis-product-engineer` + `aurialis-devils-advocate`.
- **UI/UX, Mobile-First & Accessibility (`ui-ux` or `mobile-responsive`)**:
  `aurialis-designer` + `aurialis-frontend` + `aurialis-qa` + `aurialis-devils-advocate` + `aurialis-product-engineer`.
- **WASM DSP, Concurrency & Single Binary (`backend-wasm` or `dsp`)**:
  `aurialis-backend` + `aurialis-security` + `aurialis-qa` + `aurialis-devils-advocate` + `aurialis-product-engineer`.
- **Cybersecurity, Host Protection & Upload Hardening (`security` or `upload-security`)**:
  `aurialis-security` + `aurialis-backend` + `aurialis-qa` + `aurialis-devils-advocate` + `aurialis-product-engineer`.
- **Whole-Product Completeness Sweep (`all` / `/war-room-loop`)**:
  All 8 seats orchestrated across review, implementation waves, doc sync, adversarial QA + Security + Devil's Advocate break-testing, and Product Engineer merge gates.

---

## Multi-Model Directory Mirroring

To run identically across **Gemini Argon (Antigravity / Gemini CLI)**, **Claude Code**, and **OpenAI Codex**:
- **Claude Code**: `.claude/agents/*.md` and `.claude/commands/{war-room,war-room-loop}.md`
- **Gemini Argon (Antigravity & Gemini CLI)**: `.agents/agents/*.md`, `.gemini/agents/*.md`, `.agents/skills/{war-room,war-room-loop}/SKILL.md`, and `.agents/plugins/aurialis-war-room/`
- **OpenAI Codex CLI**: `AGENTS.md`, `.agents/skills/{war-room,war-room-loop}/SKILL.md`, `.codex/config.toml`, and `.codex/agents/*.toml`

See [`.claude/war-room/cross-model-guide.md`](../war-room/cross-model-guide.md) for the complete cross-service guide.
