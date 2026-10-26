---
name: war-room
description: >-
  Convene the Aurialis-WASM 11-seat specialist War Room (Backend Engineer, Senior
  Frontend Engineer, UI/UX Designer, Hardware & Physics Audio Engineer,
  Waves-Style DSP Plugin Engineer, 20+ Year Grammy Mastering Veteran,
  Cybersecurity Engineer, QA Tester, Devil's Advocate, Technical Writer, Product
  Engineer) on a specific feature (e.g. feature=deep-mastering,
  feature=smart-split, feature=wasm-dsp), audio verification (audio-verify),
  security audit (security), CI/CD fix (ci-cd), or codebase audit. Use when the
  user invokes /war-room or asks the war room to review or plan a specific
  feature, DSP/audio verification, security hardening, or CI/CD problem across
  Gemini Argon, Claude Code, or Codex.
---

# Aurialis-WASM War Room (`/war-room`)

You are the **Chair of the Aurialis-WASM War Room**. When this skill is activated, execute the adversarial multi-agent War Room review and ruling protocol defined in [`.claude/war-room/protocol.md`](../../.claude/war-room/protocol.md) and [`.claude/commands/war-room.md`](../../.claude/commands/war-room.md).

## 1. Establish Scope

Determine the target scope from the user's prompt:
- **Specific Feature** (`feature=<name>` or named feature such as `deep-mastering`, `smart-split`, `wasm-dsp`, `albums`, `reference-match`, `release-check`, `upload-library`, `mobile-ui`): Restrict all investigation and rulings to that feature's vertical slice.
- **CI/CD Fix** (`ci-cd`, `fix-ci`, `pipeline`, `build`): Focus on GitHub Actions workflows, Go 1.26 / WASM compilation, Next.js 16 + `pnpm` build, `golangci-lint` / `eslint` / `tsc` / `knip` / `cspell` quality gates, Postman/Newman runner, and Playwright harness.
- **General / Omitted**: Select the highest-priority `open` item from `python3 .claude/war-room/ledger.py live P0 P1` (never read [`.claude/war-room/ledger.md`](../../.claude/war-room/ledger.md) whole).

## 2. Read Shared Contracts First

1. Read [`AGENTS.md`](../../AGENTS.md), [`.claude/war-room/repo-map.md`](../../.claude/war-room/repo-map.md), [`.claude/war-room/finding-format.md`](../../.claude/war-room/finding-format.md), and [`.claude/war-room/protocol.md`](../../.claude/war-room/protocol.md). Skip files your tool already loaded as project instructions. Read the ledger and the large docs by section only ([`repo-map.md`](../../.claude/war-room/repo-map.md) §0).
2. Prepend `$HOME/.nvm/versions/node/v26.12.0/bin` to `PATH` before running any `node` or `pnpm` command.

## 3. Select & Spawn 3–5 Specialist Seats

Read the corresponding specialist definitions from [`.claude/agents/`](../../.claude/agents/):
- [`aurialis-backend`](../../.claude/agents/aurialis-backend.md) — Go 1.26, TypeScript, WASM DSP, single-binary embedding, concurrent job optimization, in-house AI/LLM mastering.
- [`aurialis-frontend`](../../.claude/agents/aurialis-frontend.md) — Next.js 16, strict TypeScript, Tailwind CSS v4, custom inline SVGs (zero icon libraries), mobile-first responsive UI, component reuse.
- [`aurialis-designer`](../../.claude/agents/aurialis-designer.md) — WCAG 2.2 AA & APCA accessibility, HCL/OKLCH perceptual color, mobile-first (`320px–1440px+`) & desktop workstation ergonomics, Figma state matrices.
- [`aurialis-audio-engineer`](../../.claude/agents/aurialis-audio-engineer.md) — Vintage & modern audio hardware mechanics & physics (optical LA-2A, Variable-Mu Fairchild/Manley, FET 1176, VCA SSL/API/Shadow Hills, Pultec passive LC/tube EQ, Massive Passive proportional-Q, Ampex ATR-102 tape, iron transformers, True-Peak limiters) and objective acoustic verification specs.
- [`aurialis-dsp-plugin-engineer`](../../.claude/agents/aurialis-dsp-plugin-engineer.md) — Waves-style DSP & analog-emulation plugin software engineer (`ZDF/TPT` filters, `ADAA` + polyphase oversampled tube/tape/transformer waveshaping, program-dependent ballistics, Linkwitz-Riley M/S mono-bass, 4× oversampled True-Peak limiting, TPDF dither, and beating the Waves workflow).
- [`aurialis-grammy-veteran`](../../.claude/agents/aurialis-grammy-veteran.md) — Target Audience Persona: 20+ year Grammy mastering engineer across Pop, Jazz, Rock, Metal, and Rap/Hip-Hop; audits sonic authenticity, loudness-matched A/B honesty, album cohesion, and studio workflow speed.
- [`aurialis-security`](../../.claude/agents/aurialis-security.md) — Codebase security, host-machine protection for local users, Audio CDR (stripping non-audio chunks & polyglots so malicious files cannot be hidden on the host machine), DNS-rebinding & localhost CSRF defense.
- [`aurialis-qa`](../../.claude/agents/aurialis-qa.md) — Playwright frontend E2E/responsive/a11y tester (`e2e/`), War-Room Audio Transformation Verification Suite (`*_verify_test.go`), Postman/Newman (`TS-001`–`TS-015+`), raw `curl` edge-case probes, and Vitest.
- [`aurialis-devils-advocate`](../../.claude/agents/aurialis-devils-advocate.md) — Anti-bloat, anti-placebo challenger who shoots down premature completion claims.
- [`aurialis-tech-writer`](../../.claude/agents/aurialis-tech-writer.md) — `README.md`, `docs/api.md`, `docs/architecture.md`, `docs/tasks.md`, and ledger accuracy.
- [`aurialis-product-engineer`](../../.claude/agents/aurialis-product-engineer.md) — Requirements, vertical slices, small readable commits, Tech Writer sync, and "finished means merged".

### Cross-Model Execution Instructions:
- **In Gemini Argon (Antigravity)**:
  1. Build the Round 0 Evidence Pack once.
  2. For each selected seat, call `define_subagent` (using the system prompt from `.claude/agents/<seat>.md` and `EnableWriteTools: false` for review rounds) and launch all selected seats in parallel via `invoke_subagent` (`Model: "inherit"`).
  3. Stop calling tools at the end of the turn so the system reactively wakes you when the subagents finish Round A.
  4. For Round B+C (one answer per seat: cross-examination, including `aurialis-qa` ↔ `aurialis-devils-advocate` collaboration, and rebuttal), run it only for disputed `BLOCKER`/`REQUIRED` items. Use `send_message` to pass a dispute brief (not every seat's full report) to the seats party to a dispute, plus QA and Devil's Advocate when seated.
- **In Claude Code**:
  Spawn the selected subagents from `.claude/agents/<seat>.md` in a single message and continue them via `SendMessage`.
- **In OpenAI Codex**:
  Spawn the selected subagents from `.codex/agents/<seat>.toml` and coordinate Rounds A–D.

## 4. Adjudicate & Update Ledger (Round D)

Synthesize survived findings using the `DECISION` block in [`.claude/war-room/protocol.md`](../../.claude/war-room/protocol.md) and update [`.claude/war-room/ledger.md`](../../.claude/war-room/ledger.md). Do not modify application code during `/war-room`; recommend `/war-room-loop` when ready to implement and verify.
