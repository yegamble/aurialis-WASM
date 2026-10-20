# GEMINI.md — Aurialis-WASM (Gemini Argon / Antigravity / Gemini CLI)

This repository uses a unified multi-model agent architecture supporting **Gemini Argon (Antigravity / Gemini CLI)**, **Claude Code**, and **OpenAI Codex**.

The authoritative project rules, stack constraints (Go 1.26 + Next.js 16 + WASM single binary, Node 26, `pnpm`, Tailwind CSS v4, custom inline SVGs only, aggressive component reuse, mobile-first responsive design, HCL/OKLCH perceptual color, WCAG 2.2 AA), verification gates, and "finished means merged" commit hygiene are defined in [`AGENTS.md`](AGENTS.md) and [`.claude/review-loop.md`](.claude/review-loop.md).

@[AGENTS.md](AGENTS.md)

@[.claude/review-loop.md](.claude/review-loop.md)

## Gemini Argon / Antigravity Subagent & Skill Bindings

1. **Slash Commands & Skills**:
   - `/war-room` → [`.agents/skills/war-room/SKILL.md`](.agents/skills/war-room/SKILL.md)
   - `/war-room-loop` → [`.agents/skills/war-room-loop/SKILL.md`](.agents/skills/war-room-loop/SKILL.md)
2. **Spawning War Room Agents in Gemini Argon (Antigravity)**:
   - Each War Room specialist is defined in [`.claude/agents/`](.claude/agents/) (and mirrored in [`.agents/agents/`](.agents/agents/) and [`.gemini/agents/`](.gemini/agents/)).
   - When orchestrating `/war-room` or `/war-room-loop` inside Antigravity / Gemini Argon:
     - Register any needed specialist seat for the current conversation using `define_subagent` (reading its system prompt from `.claude/agents/<seat>.md`, setting `EnableWriteTools: false` for review rounds and `EnableWriteTools: true` only during authorized implementation waves).
     - Launch seats concurrently using `invoke_subagent` with `Model: "inherit"` (Gemini Argon) and `Workspace: "inherit"` for read-only review or `Workspace: "share"` / `"branch"` for isolated worktree implementation.
     - Conduct Round B (Cross-Examination) and Round C (Rebuttal), QA ↔ Devil's Advocate collaboration, and Engineer ↔ Technical Writer catch-ups by messaging active subagent `conversationId`s via `send_message` (never respawning a seat from scratch when its context is already warm).
     - Remember that `invoke_subagent` is reactive: do not poll in a loop; end your turn after dispatching a wave and wait for the subagent notifications.
