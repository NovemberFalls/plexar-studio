"""The slash-command catalogue a phone offers for one session.

`GET /remote/v1/sessions/{terminal_id}/commands` answers with every command the
session's CLI would complete after a "/": the harness built-ins plus user,
project, plugin and skill commands found on disk. Device-authenticated through
`remote_gateway.require_device`; /remote/v1 is origin-exempt (see CLAUDE.md).
"""

from __future__ import annotations

import asyncio
import json
import re
from pathlib import Path
from typing import Any

from fastapi import APIRouter, Depends

import remote_gateway
from remote_gateway import Device, require_device

router = APIRouter(prefix="/remote/v1")

_CLAUDE_BUILTINS: list[tuple[str, str, str | None]] = [
    ("/add-dir", "Add a working directory", "<path>"),
    ("/agents", "Manage subagents", None),
    ("/bashes", "List background tasks", None),
    ("/btw", "Ask a side question", "<question>"),
    ("/clear", "Clear the conversation", None),
    ("/compact", "Compact the context", "[instructions]"),
    ("/config", "Open settings", None),
    ("/context", "Show context usage", None),
    ("/cost", "Show token usage and cost", None),
    ("/doctor", "Check the installation", None),
    ("/effort", "Set the effort level", "[level]"),
    ("/exit", "Exit the session", None),
    ("/export", "Export the conversation", "[filename]"),
    ("/fast", "Toggle fast mode", None),
    ("/help", "List the commands", None),
    ("/hooks", "Manage hooks", None),
    ("/ide", "Manage IDE integration", None),
    ("/init", "Create a CLAUDE.md", None),
    ("/install-github-app", "Set up the GitHub app", None),
    ("/login", "Sign in", None),
    ("/logout", "Sign out", None),
    ("/mcp", "Manage MCP servers", None),
    ("/memory", "Edit memory files", None),
    ("/model", "Switch the model", "[model]"),
    ("/output-style", "Set the output style", "[style]"),
    ("/permissions", "Manage tool permissions", None),
    ("/plugin", "Manage plugins", None),
    ("/pr-comments", "Show pull request comments", None),
    ("/privacy-settings", "Open privacy settings", None),
    ("/release-notes", "Show release notes", None),
    ("/resume", "Resume a conversation", "[session]"),
    ("/review", "Review a pull request", "[pr]"),
    ("/rewind", "Rewind the conversation", None),
    ("/security-review", "Review pending changes for security", None),
    ("/status", "Show session status", None),
    ("/statusline", "Set up the status line", None),
    ("/terminal-setup", "Install terminal key bindings", None),
    ("/todos", "List the todo items", None),
    ("/upgrade", "Upgrade the plan", None),
    ("/usage", "Show plan usage", None),
    ("/vim", "Toggle vim mode", None),
]

_HARNESS_BUILTINS: dict[str, list[tuple[str, str, str | None]]] = {
    "codex": [
        ("/clear", "Clear the conversation", None),
        ("/compact", "Compact the context", None),
        ("/diff", "Show the git diff", None),
        ("/init", "Create an AGENTS.md", None),
        ("/model", "Switch the model", None),
        ("/new", "Start a new conversation", None),
        ("/review", "Review the working tree", None),
        ("/status", "Show session status", None),
    ],
    "plexar-harness": [
        ("/clear", "Clear the conversation", None),
        ("/help", "List the commands", None),
    ],
}

_FRONTMATTER = re.compile(r"\A---\r?\n(.*?)\r?\n---\r?\n?", re.S)
_QUOTES = "'\""

#: (working_dir, harness) -> (stamp, entries). A stamp that still matches means
#: no scanned file was added, removed or touched, so the parsed list is reused.
_cache: dict[tuple[str, str], tuple[tuple, list[dict]]] = {}


def _parse(path: Path) -> tuple[str, str | None]:
    """(description, argument_hint) from frontmatter, else the first body line."""
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return "", None
    meta: dict[str, str] = {}
    m = _FRONTMATTER.match(text)
    if m:
        for line in m.group(1).splitlines():
            key, sep, val = line.partition(":")
            if sep and not line.startswith((" ", "\t")):
                meta[key.strip().lower()] = val.strip().strip(_QUOTES)
        text = text[m.end():]
    desc = meta.get("description", "")
    if not desc:
        desc = next((ln.strip().lstrip("#").strip() for ln in text.splitlines() if ln.strip()), "")
    hint = meta.get("argument-hint") or meta.get("argument_hint") or None
    return desc[:200], hint


def _sources(working_dir: str) -> list[tuple[Path, str, str]]:
    """(directory, source, plugin-name) for every place commands live."""
    home = Path.home() / ".claude"
    out: list[tuple[Path, str, str]] = [
        (home / "commands", "user", ""),
        (home / "skills", "skill", ""),
    ]
    if working_dir:
        proj = Path(working_dir) / ".claude"
        out += [(proj / "commands", "project", ""), (proj / "skills", "skill", "")]
    try:
        installed = json.loads((home / "plugins" / "installed_plugins.json").read_text(encoding="utf-8"))
        for key, installs in (installed.get("plugins") or {}).items():
            plugin = key.split("@", 1)[0]
            for inst in installs or []:
                root = Path(str(inst.get("installPath") or ""))
                out += [(root / "commands", "plugin", plugin), (root / "skills", "plugin", plugin)]
    except (OSError, ValueError, AttributeError):
        pass
    return out


def _files(directory: Path) -> list[tuple[Path, str]]:
    """(file, command-name) under *directory*; a skills dir holds */SKILL.md."""
    if not directory.is_dir():
        return []
    if directory.name == "skills":
        return [(p, p.parent.name) for p in sorted(directory.glob("*/SKILL.md"))]
    return [
        (p, ":".join(p.relative_to(directory).with_suffix("").parts))
        for p in sorted(directory.rglob("*.md"))
    ]


def _entry(command: str, description: str, source: str, hint: str | None) -> dict:
    out = {"command": command, "description": description, "source": source}
    if hint:
        out["argument_hint"] = hint
    return out


def _scan(working_dir: str, harness: str) -> tuple[tuple, list[dict]]:
    if harness != "claude-code":
        built = _HARNESS_BUILTINS.get(harness, [])
        return (), [_entry(c, d, "builtin", h) for c, d, h in built]
    entries = [_entry(c, d, "builtin", h) for c, d, h in _CLAUDE_BUILTINS]
    seen = {e["command"] for e in entries}
    stamp: list[Any] = []
    for directory, source, plugin in _sources(working_dir):
        for path, name in _files(directory):
            try:
                stamp.append((str(path), path.stat().st_mtime_ns))
            except OSError:
                continue
            command = "/" + (f"{plugin}:{name}" if plugin else name)
            if command in seen:
                continue
            seen.add(command)
            desc, hint = _parse(path)
            entries.append(_entry(command, desc, source, hint))
    return tuple(stamp), entries


def _catalog(working_dir: str, harness: str) -> list[dict]:
    key = (working_dir, harness)
    stamp, entries = _scan(working_dir, harness)
    cached = _cache.get(key)
    if cached is not None and cached[0] == stamp:
        return cached[1]
    _cache[key] = (stamp, entries)
    return entries


@router.get("/sessions/{terminal_id}/commands")
async def list_commands(terminal_id: str, device: Device = Depends(require_device)):
    backend, _store_ = remote_gateway._require_configured()
    session = backend.get_session(terminal_id)
    if session is None:
        return remote_gateway._error(404, "unknown session")
    harness = str(remote_gateway._session_field(session, "harness", "claude-code") or "claude-code")
    working_dir = str(remote_gateway._session_field(session, "working_dir", "") or "")
    commands = await asyncio.to_thread(_catalog, working_dir, harness)
    return {"commands": commands}
