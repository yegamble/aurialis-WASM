# CLAUDE.md — Aurialis-WASM

All agent rules, architecture invariants, toolchain versions (Node 26, `pnpm`, Next.js 16, Tailwind CSS v4, Go 1.26, WASM), mobile-first responsive mandates, and verification gates live in `AGENTS.md` — the single source of truth imported below. Do not duplicate rules here; edit `AGENTS.md` instead.

Pay particular attention to:
- **Low-bundle, zero-icon-library UI**: Tailwind CSS v4 + custom inline SVGs only (`lucide-react` and external icon libraries are banned in production) + aggressive component reuse.
- **Mobile-first & responsive design**: Enforced by `aurialis-frontend` and `aurialis-designer` across `320px–1440px+` with `>=44×44px` touch targets and WCAG 2.2 AA / HCL-OKLCH color discipline.
- **Git hygiene — finished means merged**: Enforced by `aurialis-product-engineer` and `aurialis-tech-writer`. Commit in small, readable commits, sync with the Technical Writer to update `README.md`, API docs, and task docs, and merge finished branches to `main`.

Before claiming completion, follow the completion scrutiny loop imported below. A green unit suite alone is never proof that a full user or API workflow works.

@AGENTS.md

@.claude/review-loop.md

War room (multi-seat adversarial review and pessimistic fix loop): see `.claude/agents/README.md`; run `/war-room <scope|feature=<name>|ci-cd>` or `/war-room-loop [scope|feature=<name>|ci-cd|resume]`. Its persistent backlog is `.claude/war-room/ledger.md`.
