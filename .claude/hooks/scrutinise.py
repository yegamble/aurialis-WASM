#!/usr/bin/env python3
"""Dual-compatible pessimistic scrutiny & finished-means-merged Stop hook.

Supports both:
1. Claude Code (`Stop` / `SubagentStop` via `.claude/settings.json` with `hook_event_name` / `stop_hook_active`)
2. Google Antigravity / Gemini Argon (`Stop` via `.agents/hooks.json` with camelCase `terminationReason` / `executionNum`)

Reminds agents to verify fail-fast gates, sync docs with `aurialis-tech-writer`,
and commit/merge finished work in small readable commits per `aurialis-product-engineer`.
Never traps a session in an infinite loop.
"""
from __future__ import annotations

import hashlib
import json
import os
import sys

REMINDER_TEXT = (
    "Before finishing, run one pessimistic scrutiny pass using .claude/review-loop.md: "
    "(1) Challenge your completion claim with concrete execution evidence (golangci-lint, "
    "tsc --noEmit, eslint --max-warnings=0, knip, cspell, go test -race, Vitest, Newman/curl, "
    "Playwright 320px-1440px responsive & WCAG 2.2 AA). "
    "(2) Confirm zero external icon libraries (custom inline SVGs + Tailwind CSS v4 only) and "
    "mobile-first responsive behavior. "
    "(3) Catch up with aurialis-tech-writer so README.md, docs/api.md, docs/architecture.md, "
    "docs/tasks.md, and .claude/war-room/ledger.md match your changes. "
    "(4) Follow aurialis-product-engineer git hygiene: commit finished work in small, atomic, "
    "readable commits and merge to main (or explicitly report 'open — awaiting merge'). "
    "Read-only war-room review seats report findings to the Chair without editing files."
)


def check_antigravity_stop(payload: dict) -> dict | None:
    """Handle Antigravity / Gemini Argon camelCase Stop hook contract."""
    term_reason = payload.get("terminationReason", "")
    if term_reason != "NO_TOOL_CALL":
        return {}
    conv_id = str(payload.get("conversationId", "default"))
    state_dir = os.path.join(os.path.dirname(__file__), ".state")
    os.makedirs(state_dir, exist_ok=True)
    key = hashlib.sha256(f"agy:{conv_id}".encode()).hexdigest()[:16]
    marker = os.path.join(state_dir, f"{key}.reminded")
    if os.path.exists(marker):
        try:
            os.remove(marker)
        except OSError:
            pass
        return {"decision": "allow"}
    try:
        with open(marker, "w", encoding="utf-8") as f:
            f.write("1\n")
    except OSError:
        return {"decision": "allow"}
    return {
        "decision": "continue",
        "reason": REMINDER_TEXT,
    }


def check_claude_stop(payload: dict) -> dict | None:
    """Handle Claude Code snake_case Stop / SubagentStop hook contract."""
    if payload.get("hook_event_name") not in ("Stop", "SubagentStop"):
        return None
    if payload.get("stop_hook_active") is True:
        return None
    return {
        "decision": "block",
        "reason": REMINDER_TEXT,
    }


def main() -> None:
    try:
        payload = json.load(sys.stdin)
    except (ValueError, OSError):
        return
    if not isinstance(payload, dict):
        return

    if "terminationReason" in payload or "conversationId" in payload:
        res = check_antigravity_stop(payload)
        if res is not None:
            print(json.dumps(res))
        return

    res = check_claude_stop(payload)
    if res is not None:
        print(json.dumps(res))


if __name__ == "__main__":
    main()
