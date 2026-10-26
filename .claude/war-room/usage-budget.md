# Multi-Model Usage & Token Budget Discipline

Applies across **Gemini Argon (Antigravity / Gemini CLI)**, **Claude Code (Opus / Sonnet)**, and **OpenAI Codex**.

Our War Room seats perform deep adversarial cross-examination, so we save tokens and turns by **eliminating redundant work**, never by lobotomizing the reviewers:

1. **Seat 3–5 Specialists Per Session (Never All 7 Blindly for Narrow Scopes)**:
   - For a targeted scope (`/war-room feature=wasm-dsp` or `/war-room ci-cd`), spawn the **3–5 seats** whose domains directly intersect the problem, plus `aurialis-tech-writer` and `aurialis-product-engineer` at the documentation and commit/merge gates.
   - For a whole-codebase completeness sweep (`/war-room-loop`), seat the full relevant panel and rotate focus areas systematically.
2. **Build Round 0 Once**:
   - The Chair builds one shared Evidence Pack before Round A so 5 agents do not run 5 identical repo-wide `grep` or `find` passes.
3. **Continue Existing Subagents Instead of Respawning**:
   - Use `send_message` (in Gemini Argon / Antigravity), `SendMessage` (in Claude Code), or thread continuation (in Codex) for Round B cross-examination, Round C rebuttal, Engineer ↔ Technical Writer syncs, and Round E fix re-verification. The agent's context window is already warm and paid for.
4. **Verify Only What Changed in Fix Rounds**:
   - When an item fails Round E verification and is fixed, re-verify the specific failing criterion and its regression suite rather than re-auditing unrelated modules from scratch.
5. **Skip Rounds B/C When Round A Finds Zero Disputed `BLOCKER` or `REQUIRED` Items**:
   - If all seats independently agree and `aurialis-devils-advocate` + `aurialis-qa` have no disputed `BLOCKER`/`REQUIRED` items, proceed directly from Round A to Round D ruling.
6. **Chair Handles Mechanical Bookkeeping Directly**:
   - Updating `.claude/war-room/ledger.md` status cells, fast-forwarding branches, pruning merged worktrees, and watching CI status in Bash are done by the Chair directly without spawning a subagent.
7. **Never Compromise Verification Gates to Save Tokens**:
   - `go test -race`, WASM build, `pnpm run lint`, `tsc --noEmit`, `vitest`, `next build`, Postman/Newman, `curl` probes, Playwright responsive/a11y checks, Technical Writer doc sync, and Product Engineer atomic commit hygiene are non-negotiable.
8. **Read Slices, Not Monoliths**:
   - The ledger (180 KB), `docs/tasks.md` (198 KB), `docs/architecture.md` (78 KB) and `docs/api.md` (73 KB) are read by section only (`repo-map.md` §0). One whole-file read is re-sent on every later turn of that agent.
9. **Hand Over, Don't Make Agents Rediscover**:
   - Paste the ledger slice, Evidence Pack excerpt, files and functions to touch, base commit and diff stat into implementer and verifier prompts.
10. **Keep Passing Output Out of Context**:
    - Run gates through `.claude/war-room/quiet.sh`; read CI failures with `gh run view <id> --log-failed | tail`.
11. **Cross-Examine Only What Is Disputed**:
    - Round B+C is one answer per seat, only for seats in a dispute (plus QA and Devil's Advocate when seated), with a dispute brief instead of every seat's full report.
