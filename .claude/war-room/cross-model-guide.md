# Cross-Model Agent Best Practices & Quality Gates Guide

This document captures our research and architecture for running the **Aurialis-WASM War Room** (`war-room` and `war-room-loop`) seamlessly across **Gemini Argon (Google Antigravity / Gemini CLI)**, **Claude (Claude Code)**, and **OpenAI Codex (Codex CLI)**, along with our fail-fast **Go 1.26** and **Next.js 16 / TypeScript 5.8** static quality gates.

---

## 1. How the Three Coding Ecosystems Discover Rules, Skills, Agents & Hooks

| Capability | Claude Code (`claude`) | Gemini Argon (`Antigravity` / `agy` / `gemini`) | OpenAI Codex (`codex`) | How Aurialis-WASM Unifies Them |
|---|---|---|---|---|
| **Root Project Instructions** | `CLAUDE.md` (supports `@path` imports) | `AGENTS.md` and `GEMINI.md` (supports `@[label](path)` imports) | `AGENTS.md` (Linux Foundation Agentic AI standard) | [`AGENTS.md`](../../AGENTS.md) is the single source of truth; [`CLAUDE.md`](../../CLAUDE.md) and [`GEMINI.md`](../../GEMINI.md) import it directly. |
| **Slash Commands & Workflows (`/war-room`, `/war-room-loop`)** | `.claude/commands/war-room.md` & `.claude/commands/war-room-loop.md` (`$ARGUMENTS`) | `.agents/skills/<name>/SKILL.md` (and `.gemini/skills/<name>/SKILL.md`) — provides both `/war-room` slash commands and progressive skill activation | `.agents/skills/<name>/SKILL.md` (invoked via `/skills` or prompt) | Both `.claude/commands/*.md` and `.agents/skills/*/SKILL.md` are checked in and reference the shared [`.claude/war-room/protocol.md`](protocol.md). |
| **Specialist Subagents (7 Seats)** | `.claude/agents/aurialis-*.md` (`name`, `description`, `tools: Read, Grep, ...`, `model`, `effort: high`) | `.agents/agents/aurialis-*.md`, `.gemini/agents/aurialis-*.md`, `.agents/plugins/aurialis-war-room/agents/*.md`, plus dynamic `define_subagent` + `invoke_subagent` | `.codex/config.toml` (`[features] multi_agent = true`) + `.codex/agents/aurialis-*.toml` (`developer_instructions`, `sandbox_mode`, `reasoning_effort`) | [`scripts/sync-agents.py`](../../scripts/sync-agents.py) compiles the canonical `.claude/agents/aurialis-*.md` files into native Antigravity/Gemini `.md` and Codex `.toml` formats automatically. |
| **Inter-Agent Messaging (Round B/C & Tech Writer Sync)** | `SendMessage` to existing subagent ID | `send_message` (`Recipient: conversationId`) with reactive wakeup (no polling loops) | `/subagents` thread messaging & shared `.claude/war-room/ledger.md` artifacts | All three preserve warm subagent context across Round A → B → C and Engineer ↔ Technical Writer catch-ups. |
| **Parallel Worktree Isolation** | `isolation: "worktree"` on subagent spawn | `invoke_subagent` with `Workspace: "share"` or `"branch"` | Separate git worktrees (`git worktree add`) per worker agent | Prevents parallel engineers (`aurialis-backend`, `aurialis-frontend`, `aurialis-designer`) from overwriting each other's files. |
| **Lifecycle / Stop Hooks** | `.claude/settings.json` (`Stop`, `SubagentStop` JSON stdin/stdout with `hook_event_name`) | `.agents/hooks.json` (`Stop` JSON stdin/stdout with camelCase `terminationReason` & `conversationId`) | Git pre-commit / pre-push hooks + `AGENTS.md` completion gate | [`.claude/hooks/scrutinise.py`](../hooks/scrutinise.py) detects both Claude's snake_case payload and Antigravity's camelCase payload in one script. |

---

## 2. Best Practices for Running Multi-Model War Rooms

1. **Keep Progressive Disclosure Lean**:
   - Root `AGENTS.md` and `GEMINI.md` are loaded on every turn (subject to a 24 KB per-file cap and 20,000-token rules budget in Antigravity). Keep root rules concise and put detailed schemas, protocols, and design specs in `.claude/war-room/` and `docs/` where agents read them on demand.
2. **Never Pay 5× for Repository Enumeration (Round 0 Evidence Pack)**:
   - Before spawning 3–5 specialist seats in Round A, the Chair builds **one** shared Evidence Pack listing the exact files, routes, tests, and open ledger rows. Every seat reads the pack first instead of running redundant repository-wide searches.
3. **Cross-Model Adversarial Pairing (Generator vs. Breaker)**:
   - You can run the War Room entirely inside **Gemini Argon**, entirely inside **Claude Code**, entirely inside **Codex**, or **mix models across iterations** via the shared [`.claude/war-room/ledger.md`](ledger.md):
     - Example hybrid workflow: Run `/war-room-loop feature=wasm-dsp` in **Gemini Argon** or **Claude Code** to implement a wave, then run `/war-room feature=wasm-dsp` in **Codex** (or vice versa) so a different model family acts as `aurialis-devils-advocate` and `aurialis-qa` against the committed branch.
4. **Never Add "Show Your Reasoning" Prompts**:
   - Modern reasoning models (Gemini Argon High, Claude Opus/Sonnet with extended thinking, GPT-5/Codex High) already reason internally. Asking them to echo chain-of-thought in output wastes output tokens and clutters cross-examination payloads. Instead, ask for **falsification conditions** (*"What concrete evidence would change your mind?"*).
5. **Single Source of Truth Synchronization**:
   - Edit agent prompts only in `.claude/agents/aurialis-*.md`, then run:
     ```bash
     python3 scripts/sync-agents.py
     ```
     This regenerates `.agents/agents/`, `.gemini/agents/`, `.agents/plugins/aurialis-war-room/`, and `.codex/agents/` with zero drift.

---

## 3. Fail-Fast Go 1.26 Quality Gate Analysis

We evaluated the 6 candidate Go linter commands to determine which to run and how to force builds to fail on bad quality code:

| Candidate Command | Verdict | Why & How We Configure It |
|---|---|---|
| `golangci-lint run --fix` | **Use `golangci-lint run ./...` (NO `--fix`) in CI/gates; use `--fix` ONLY locally** | Passing `--fix` in CI or during a War Room review silently mutates files on disk instead of failing cleanly, or leaves dirty uncommitted diffs. In CI and verification gates, run `golangci-lint run ./...` (configured via [`.golangci.yml`](../../.golangci.yml) v2) so any violation **exits non-zero and fails the build**. |
| `staticcheck -checks all ./...` | **Included inside `.golangci.yml`** (`linters.settings.staticcheck.checks: ["all"]`) | `golangci-lint v2.6+` embeds `staticcheck` natively. Enabling `checks: ["all"]` inside `.golangci.yml` runs every `SA*`, `S1*`, `ST1*`, and `QF*` check in the same AST pass without compiling the project twice. |
| `revive -formatter friendly -exclude ./vendor/... ./...` | **Included inside `.golangci.yml`** (`revive` enabled + `vendor` excluded) | `golangci-lint v2` embeds `revive` natively and excludes `vendor/` via `linters.exclusions.paths`. Running it inside `golangci-lint` enforces `context-as-argument`, `error-return`, `errorf`, `exported`, `receiver-naming`, `unreachable-code`, and `unused-parameter` in the same pass. |
| `identypo ./...` | **Run standalone alongside `misspell` + `cspell`** | `identypo` (`github.com/SwingbyProtocol/identypo`) analyzes Go AST identifier frequency distances to catch subtle single-letter variable/field typos that dictionary spellcheckers miss. We pair it with `misspell` (in `.golangci.yml`) and `cspell`. |
| `nakedret ./...` | **Included inside `.golangci.yml`** (`nakedret.max-func-lines: 0`) | Bundled inside `golangci-lint`. Setting `max-func-lines: 0` bans naked returns completely across all Go functions, forcing explicit return values. |
| `gosec -fmt=golint -quiet ./...` | **Included inside `.golangci.yml` + paired with `govulncheck ./...`** | `golangci-lint` embeds `gosec` for AST security scanning (weak crypto, file traversal, command injection, integer overflow, unhandled errors). We pair it with `govulncheck ./...` to check reachable CVEs in dependencies and the Go standard library. |

### Canonical Go Fail-Fast Gate Commands:
```bash
# Local developer auto-fix (before committing):
golangci-lint run --fix ./...

# Mandatory CI / War-Room Build-Failure Gate (read-only, fails on any issue):
"$(go env GOROOT)/bin/gofmt" -l cmd internal wasm   # Must return empty output
go mod verify
go vet ./...
golangci-lint run ./...                              # Executes staticcheck(all), revive, gosec, nakedret(0), misspell, dupword, gocritic, errorlint, bodyclose, noctx, exhaustive
identypo ./...                                       # AST identifier typo detector
govulncheck ./...                                    # Reachable CVE scanner
go test -race -count=1 ./...
```

---

## 4. Next.js 16 + TypeScript 5.8 Equivalents (Fail-Fast Frontend Gate)

To enforce the exact same rigor in our **Next.js 16 + TypeScript + Tailwind CSS v4** frontend (using **`pnpm`** and **Node `26.12.0`**), each Go tool maps to a specific TypeScript/Next.js gate:

| Go Tool | Next.js 16 / TypeScript Equivalent | What It Enforces to Fail Bad Code |
|---|---|---|
| `golangci-lint run` (`--fix` locally) | **`pnpm run lint`** (`eslint . --max-warnings=0` via ESLint v9 Flat Config `eslint.config.mjs`; `pnpm run lint:fix` locally) | Single unified AST runner that fails the build on **any** error or warning (`--max-warnings=0`). |
| `staticcheck -checks all ./...` | **`pnpm exec tsc --noEmit`** (with strict `tsconfig.json`) + **`typescript-eslint` `strictTypeChecked` & `stylisticTypeChecked`** + **`pnpm exec knip`** | `tsc` enforces `"strict": true`, `"noUncheckedIndexedAccess": true`, `"exactOptionalPropertyTypes": true`, `"noImplicitReturns": true`, `"noFallthroughCasesInSwitch": true`, `"noImplicitOverride": true`, `"noUnusedLocals": true`, `"noUnusedParameters": true`. `knip` fails the build on any dead files, unused exports, or unused `package.json` dependencies. |
| `revive -formatter friendly ...` | **`@next/eslint-plugin-next` (`core-web-vitals`) + `eslint-plugin-unicorn` + `eslint-plugin-sonarjs` + `no-restricted-imports`** | Enforces React 19 / Next.js 16 App Router rules, cognitive complexity limits, consistent type imports, and **hard-bans external icon libraries** (`lucide-react`, `@heroicons/*`, `react-icons/*`) so only custom inline SVGs are allowed. |
| `identypo ./...` | **`pnpm exec cspell lint "**/*.{ts,tsx,go,md}" --no-progress`** | Splits camelCase, PascalCase, and snake_case identifiers across TypeScript, Go, and Markdown files to fail the build on misspelled variable names, types, or documentation typos. |
| `nakedret ./...` | **`noImplicitReturns` (`tsconfig.json`) + `consistent-return` & `@typescript-eslint/explicit-module-boundary-types`** | Bans ambiguous implicit `undefined` returns and requires every exported function/hook/component to have explicit, predictable return contracts. |
| `gosec` + `govulncheck` | **`eslint-plugin-security` + `eslint-plugin-jsx-a11y` (strict mode) + `pnpm audit --audit-level=high`** | Fails the build on unsafe regexes, `eval`, object injection, unescaped XSS sinks (`dangerouslySetInnerHTML`), non-literal path access, WCAG 2.2 AA JSX violations (missing labels, invalid ARIA, non-interactive click handlers), and vulnerable npm packages. |
