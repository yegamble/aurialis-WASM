#!/usr/bin/env python3
"""Synchronize canonical .claude/agents/*.md definitions across Gemini Argon
(Antigravity / Gemini CLI) and OpenAI Codex CLI directories.

Canonical source: .claude/agents/aurialis-*.md
Generated targets:
  - .agents/agents/aurialis-*.md (Antigravity / Gemini Argon workspace agents)
  - .gemini/agents/aurialis-*.md (Gemini CLI workspace agents)
  - .agents/plugins/aurialis-war-room/agents/aurialis-*.md (Antigravity plugin agents)
  - .codex/agents/aurialis-*.toml + .codex/config.toml (OpenAI Codex CLI TOML agents)
"""
from __future__ import annotations

import glob
import os
import re
import shutil

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

AGY_WRITE_TOOLS = [
    "view_file",
    "write_to_file",
    "replace_file_content",
    "grep_search",
    "find_by_name",
    "list_dir",
    "run_command",
]

AGY_READONLY_TOOLS = [
    "view_file",
    "grep_search",
    "find_by_name",
    "list_dir",
    "run_command",
]


def parse_claude_agent(path: str) -> tuple[dict[str, str], str]:
    with open(path, "r", encoding="utf-8") as f:
        text = f.read()
    match = re.match(r"^---\n(.*?)\n---\n(.*)$", text, re.DOTALL)
    if not match:
        raise ValueError(f"Missing YAML frontmatter in {path}")
    fm_raw, body = match.group(1), match.group(2).lstrip("\n")
    meta: dict[str, str] = {}
    for line in fm_raw.splitlines():
        if ":" in line:
            k, v = line.split(":", 1)
            meta[k.strip()] = v.strip().strip('"')
    return meta, body


def render_antigravity_agent(meta: dict[str, str], body: str) -> str:
    name = meta["name"]
    desc = meta["description"].replace('"', '\\"')
    claude_tools = meta.get("tools", "")
    is_readonly = "Edit" not in claude_tools and "Write" not in claude_tools
    tools = AGY_READONLY_TOOLS if is_readonly else AGY_WRITE_TOOLS
    tools_yaml = "\n".join(f"  - {t}" for t in tools)
    return (
        f"---\n"
        f"name: {name}\n"
        f'description: "{desc}"\n'
        f"tools:\n"
        f"{tools_yaml}\n"
        f"mainAgent: true\n"
        f"subagent: true\n"
        f"commandExecutionPolicy: auto\n"
        f"---\n\n"
        f"{body}"
    )


def render_codex_toml(meta: dict[str, str], body: str) -> str:
    name = meta["name"]
    desc = meta["description"].replace("\\", "\\\\").replace('"', '\\"')
    claude_tools = meta.get("tools", "")
    is_readonly = "Edit" not in claude_tools and "Write" not in claude_tools
    sandbox_mode = "read-only" if is_readonly else "workspace-write"
    escaped_body = body.replace('"""', '\\"\\"\\"')
    return (
        f'# Generated from .claude/agents/{name}.md by scripts/sync-agents.py\n'
        f'name = "{name}"\n'
        f'description = "{desc}"\n'
        f'reasoning_effort = "high"\n'
        f'sandbox_mode = "{sandbox_mode}"\n\n'
        f'developer_instructions = """\n'
        f"{escaped_body}"
        f'"""\n'
    )


def main() -> None:
    claude_dir = os.path.join(ROOT, ".claude", "agents")
    target_md_dirs = [
        os.path.join(ROOT, ".agents", "agents"),
        os.path.join(ROOT, ".gemini", "agents"),
        os.path.join(ROOT, ".agents", "plugins", "aurialis-war-room", "agents"),
    ]
    codex_agents_dir = os.path.join(ROOT, ".codex", "agents")

    for d in target_md_dirs + [codex_agents_dir]:
        os.makedirs(d, exist_ok=True)

    agent_files = sorted(glob.glob(os.path.join(claude_dir, "aurialis-*.md")))
    codex_index: list[tuple[str, str]] = []

    for src in agent_files:
        meta, body = parse_claude_agent(src)
        name = meta["name"]
        agy_md = render_antigravity_agent(meta, body)
        for out_dir in target_md_dirs:
            out_path = os.path.join(out_dir, f"{name}.md")
            with open(out_path, "w", encoding="utf-8") as f:
                f.write(agy_md)

        codex_toml = render_codex_toml(meta, body)
        codex_path = os.path.join(codex_agents_dir, f"{name}.toml")
        with open(codex_path, "w", encoding="utf-8") as f:
            f.write(codex_toml)
        codex_index.append((name, meta["description"]))

    # Mirror skills into .gemini/skills and .agents/plugins/aurialis-war-room/skills
    skills_src = os.path.join(ROOT, ".agents", "skills")
    for mirror_skills_root in [
        os.path.join(ROOT, ".gemini", "skills"),
        os.path.join(ROOT, ".agents", "plugins", "aurialis-war-room", "skills"),
    ]:
        os.makedirs(mirror_skills_root, exist_ok=True)
        for skill_name in ("war-room", "war-room-loop"):
            s_dir = os.path.join(skills_src, skill_name)
            d_dir = os.path.join(mirror_skills_root, skill_name)
            os.makedirs(d_dir, exist_ok=True)
            shutil.copyfile(
                os.path.join(s_dir, "SKILL.md"),
                os.path.join(d_dir, "SKILL.md"),
            )

    # Mirror AGENTS.md into .agents/plugins/aurialis-war-room/rules/AGENTS.md
    plugin_rules_dir = os.path.join(ROOT, ".agents", "plugins", "aurialis-war-room", "rules")
    os.makedirs(plugin_rules_dir, exist_ok=True)
    shutil.copyfile(
        os.path.join(ROOT, "AGENTS.md"),
        os.path.join(plugin_rules_dir, "AGENTS.md"),
    )

    # Write .codex/config.toml
    codex_config_path = os.path.join(ROOT, ".codex", "config.toml")
    lines = [
        "# OpenAI Codex CLI Workspace Configuration for Aurialis-WASM",
        "# Generated by scripts/sync-agents.py — edit .claude/agents/*.md and re-run.",
        'approval_policy = "on-request"',
        'sandbox_mode = "workspace-write"',
        'model_reasoning_effort = "high"',
        "",
        "[features]",
        "multi_agent = true",
        "",
    ]
    for name, desc in codex_index:
        safe_desc = desc.replace("\\", "\\\\").replace('"', '\\"')
        lines.extend(
            [
                f"[agents.{name}]",
                f'description = "{safe_desc}"',
                f'config_file = ".codex/agents/{name}.toml"',
                "",
            ]
        )
    with open(codex_config_path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines))

    print(f"Synced {len(agent_files)} war-room agents across Claude, Gemini/Antigravity, and Codex.")


if __name__ == "__main__":
    main()
