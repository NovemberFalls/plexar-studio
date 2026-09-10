"""JSONL session file watcher — tails Claude Code conversation files and yields structured messages.

Claude Code writes conversation turns as JSONL lines to:
  ~/.claude/projects/<project-id>/<session-id>.jsonl

This module provides an async generator that watches a JSONL file for new lines,
parses them, and yields only the message types relevant for the chat UI.
"""

from __future__ import annotations

import asyncio
import json
import threading
import logging
import os
import re
from pathlib import Path
from typing import AsyncGenerator

logger = logging.getLogger("cockpit.jsonl")

# JSONL types to skip (internal bookkeeping, not displayable)
SKIP_TYPES = {"queue-operation", "last-prompt"}


def parse_jsonl_entry(line: str) -> dict | None:
    """Parse a single JSONL line into a chat-renderable message.

    Returns a dict with:
      - id: unique message UUID
      - type: 'user' | 'assistant' | 'system' | 'tool_result'
      - role: 'user' | 'assistant' | 'system'
      - content: list of content blocks
      - timestamp: ISO timestamp
      - parentId: parent message UUID (for threading)

    Returns None for entries that should be skipped.
    """
    try:
        obj = json.loads(line)
    except json.JSONDecodeError:
        return None

    entry_type = obj.get("type")
    if entry_type in SKIP_TYPES:
        return None

    msg = obj.get("message", {})
    uuid = obj.get("uuid")
    if not uuid:
        return None

    timestamp = obj.get("timestamp")
    parent_id = obj.get("parentUuid")

    if entry_type == "user":
        content = msg.get("content", "")
        # User messages can be a string (regular text) or an array (tool results)
        if isinstance(content, str):
            return {
                "id": uuid,
                "type": "user",
                "role": "user",
                "content": [{"type": "text", "text": content}],
                "timestamp": timestamp,
                "parentId": parent_id,
            }
        elif isinstance(content, list):
            # Check if this is a tool_result response
            has_tool_result = any(
                block.get("type") == "tool_result" for block in content if isinstance(block, dict)
            )
            if has_tool_result:
                blocks = []
                for block in content:
                    if not isinstance(block, dict):
                        continue
                    if block.get("type") == "tool_result":
                        # Extract tool result content
                        result_content = block.get("content", "")
                        if isinstance(result_content, list):
                            # Content can be [{type: "text", text: "..."}]
                            texts = [b.get("text", "") for b in result_content if isinstance(b, dict)]
                            result_content = "\n".join(texts)
                        blocks.append({
                            "type": "tool_result",
                            "tool_use_id": block.get("tool_use_id"),
                            "content": str(result_content)[:2000],  # Truncate large results
                            "is_error": block.get("is_error", False),
                        })
                return {
                    "id": uuid,
                    "type": "tool_result",
                    "role": "user",
                    "content": blocks,
                    "timestamp": timestamp,
                    "parentId": parent_id,
                }
            return None  # Unknown user content format

    elif entry_type == "assistant":
        content = msg.get("content", [])
        if not isinstance(content, list):
            return None

        blocks = []
        for block in content:
            if not isinstance(block, dict):
                continue
            block_type = block.get("type")
            if block_type == "text":
                text = block.get("text", "")
                if text:
                    blocks.append({"type": "text", "text": text})
            elif block_type == "tool_use":
                blocks.append({
                    "type": "tool_use",
                    "tool_name": block.get("name", "unknown"),
                    "tool_id": block.get("id", ""),
                    "input": _summarize_tool_input(block.get("input", {})),
                })
            elif block_type == "thinking":
                # Include thinking but mark it as collapsed by default
                thinking_text = block.get("thinking", "")
                if thinking_text:
                    blocks.append({
                        "type": "thinking",
                        "text": thinking_text[:1000],  # Truncate long thinking
                    })

        if not blocks:
            return None

        return {
            "id": uuid,
            "type": "assistant",
            "role": "assistant",
            "content": blocks,
            "timestamp": timestamp,
            "parentId": parent_id,
            "model": msg.get("model"),
            "stop_reason": msg.get("stop_reason"),
        }

    elif entry_type == "system":
        content = msg.get("content", "")
        if isinstance(content, list):
            texts = [b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text"]
            content = "\n".join(texts)
        return {
            "id": uuid,
            "type": "system",
            "role": "system",
            "content": [{"type": "text", "text": str(content)[:500]}],
            "timestamp": timestamp,
            "parentId": parent_id,
        }

    return None


def _summarize_tool_input(input_data: dict) -> dict:
    """Produce a compact summary of tool input for display."""
    summary = {}
    for key, value in input_data.items():
        if isinstance(value, str) and len(value) > 200:
            summary[key] = value[:200] + "..."
        else:
            summary[key] = value
    return summary


async def tail_jsonl(
    filepath: str,
    from_beginning: bool = True,
    poll_interval: float = 0.3,
    start_offset: int | None = None,
) -> AsyncGenerator[dict, None]:
    """Async generator that tails a JSONL file and yields parsed messages.

    Args:
        filepath: Path to the JSONL file to watch.
        from_beginning: If True, read all existing entries first. If False, start from end.
        poll_interval: Seconds between file polls.
        start_offset: When *from_beginning* is False, use this byte offset as the
            initial tail position instead of stat-ing the file size at the moment
            iteration begins. Async generators are lazy — the body of this function
            does not run until the caller starts iterating, which can happen well
            after the caller decided to watch the file (e.g. bridge_manager injects
            a kickoff prompt, THEN creates the watcher task). If the watched process
            appends a new entry in that gap, a bare ``from_beginning=False`` would
            silently skip it because ``offset = path.stat().st_size`` is taken too
            late. Callers that need race-free tailing should snapshot the file size
            (0 if the file doesn't exist yet) BEFORE triggering whatever might
            produce new content, then pass that snapshot here. Defaults to None,
            which preserves the original stat-at-discovery behavior.

    Yields:
        Parsed message dicts (see parse_jsonl_entry).
    """
    path = Path(filepath)

    # Wait for file to exist (Claude Code may not have written it yet)
    wait_count = 0
    while not path.exists():
        wait_count += 1
        if wait_count > 100:  # ~30s at 0.3s interval
            logger.warning("JSONL file never appeared: %s", filepath)
            return
        await asyncio.sleep(poll_interval)

    offset = 0

    if from_beginning:
        # Read all existing entries
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                for line in f:
                    line = line.strip()
                    if line:
                        entry = parse_jsonl_entry(line)
                        if entry:
                            yield entry
                offset = f.tell()
        except Exception:
            logger.debug("Error reading JSONL: %s", filepath, exc_info=True)
    elif start_offset is not None:
        offset = start_offset
    else:
        try:
            offset = path.stat().st_size
        except OSError:
            offset = 0

    # Tail for new entries
    while True:
        try:
            current_size = path.stat().st_size
        except OSError:
            await asyncio.sleep(poll_interval)
            continue

        if current_size > offset:
            try:
                with open(path, "r", encoding="utf-8", errors="replace") as f:
                    f.seek(offset)
                    new_data = f.read()
                    offset = f.tell()
                for line in new_data.split("\n"):
                    line = line.strip()
                    if line:
                        entry = parse_jsonl_entry(line)
                        if entry:
                            yield entry
            except Exception:
                logger.debug("Error tailing JSONL: %s", filepath, exc_info=True)

        await asyncio.sleep(poll_interval)


def read_all_messages(filepath: str) -> list[dict]:
    """Synchronously read all messages from a JSONL file. Returns a list of parsed messages."""
    path = Path(filepath)
    if not path.exists():
        return []

    messages = []
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.strip()
                if line:
                    entry = parse_jsonl_entry(line)
                    if entry:
                        messages.append(entry)
    except Exception:
        logger.debug("Error reading JSONL: %s", filepath, exc_info=True)

    return messages


# Max length of a CLI-side title we are willing to adopt as a session name.
MAX_CUSTOM_TITLE_LEN = 120


def latest_custom_title(path: str, tail_bytes: int = 65536) -> str | None:
    """Return the LAST user-set session title recorded in a Claude Code JSONL.

    Claude Code's ``/rename`` appends ``{"type": "custom-title",
    "customTitle": "<name>", ...}`` to the transcript. Automatic titles are
    written as ``{"type": "ai-title", ...}`` and are deliberately NOT adopted:
    an automatic title is not the user's rename.

    TAIL-ONLY BY CONTRACT. These transcripts routinely reach 100 MB, so this
    seeks to at most the last *tail_bytes* and drops the first (probably
    partial) line. A rename older than that window is simply not seen — which
    is correct, since a newer rename would be inside it.

    Returns the stripped title (non-empty, at most ``MAX_CUSTOM_TITLE_LEN``
    chars) or None when there is none / the file cannot be read.
    """
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            size = f.tell()
            start = max(0, size - tail_bytes)
            f.seek(start)
            chunk = f.read()
    except OSError:
        return None

    text = chunk.decode("utf-8", errors="replace")
    lines = text.split("\n")
    if start > 0 and lines:
        lines = lines[1:]  # first line is probably truncated mid-record

    title: str | None = None
    for line in lines:
        line = line.strip()
        if not line or '"custom-title"' not in line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        if obj.get("type") != "custom-title":
            continue
        value = obj.get("customTitle")
        if not isinstance(value, str):
            continue
        value = value.strip()
        if value:
            title = value[:MAX_CUSTOM_TITLE_LEN]
    return title


# Max length of the collapsed preview text handed to the phone's sessions list.
MAX_PREVIEW_TEXT_LEN = 160

# Per-path cache of the last computed preview, keyed internally on
# (mtime_ns, size) so the phone's periodic sessions-list poll costs no I/O
# when nothing changed. Small and unbounded-but-capped: one entry per live
# session, evicted oldest-first past _PREVIEW_CACHE_MAX.
_PREVIEW_CACHE: dict[str, tuple[tuple, dict | None]] = {}
_PREVIEW_CACHE_MAX = 128

# Default ceiling on how far back from EOF _compute_latest_preview will scan
# looking for a qualifying text turn. A busy session's tail can be entirely
# thinking/tool_use/tool_result/attachment records for many megabytes; this
# caps the cost of walking backward through them without ever reading a
# multi-hundred-MB transcript in full.
DEFAULT_PREVIEW_MAX_BYTES = 2 * 1024 * 1024

# Wrapper tags used for system-injected text that is not the user's own
# words -- hook stdout/stderr, slash-command scaffolding, task
# notifications. A user record whose visible text is entirely one of these
# blocks (possibly nested with a trailing <system-reminder> appended) does
# not qualify as a preview.
_SYSTEM_INJECTED_TAGS = (
    "task-notification",
    "system-reminder",
    "local-command-stdout",
    "local-command-stderr",
    "command-name",
    "command-message",
    "command-args",
    "bash-input",
)
_LEADING_TAG_RE = re.compile(
    r"^\s*<(" + "|".join(_SYSTEM_INJECTED_TAGS) + r")(?:\s[^>]*)?>.*?</\1>",
    re.DOTALL,
)
_TRAILING_SYSTEM_REMINDER_RE = re.compile(
    r"<system-reminder(?:\s[^>]*)?>.*?</system-reminder>\s*$", re.DOTALL
)
# Residue that is nothing but leftover tag markup -- an empty/self-closed tag
# like ``<command-args></command-args>`` that survived stripping. This is the
# belt to the blocklist's braces: the next wrapper tag Claude Code invents
# must not become a preview either.
_TAG_ONLY_RESIDUE_RE = re.compile(r"^\s*<[^>]+>\s*(?:</[^>]+>)?\s*$")


def _strip_system_injected(text: str) -> str | None:
    """Strip leading/trailing system-injected wrapper blocks from user text.

    Repeatedly removes a leading ``<tag ...>...</tag>`` block for any tag in
    ``_SYSTEM_INJECTED_TAGS``, then strips a trailing ``<system-reminder>``
    block. Returns the stripped text, or ``None`` if nothing non-whitespace
    remains (the record does not qualify as a preview).
    """
    while True:
        match = _LEADING_TAG_RE.match(text)
        if not match:
            break
        text = text[match.end() :]
    text = _TRAILING_SYSTEM_REMINDER_RE.sub("", text)
    stripped = text.strip()
    return stripped if stripped else None


# Markdown emphasis: **bold**, *italic* -- these are matched intra-word too
# (that is what CommonMark itself does for `*`), non-greedily so "**a** and
# **b**" yields two hits, not one spanning the middle text.
_MD_STAR_BOLD_RE = re.compile(r"\*\*(?!\s)(.+?)(?<!\s)\*\*")
_MD_STAR_ITALIC_RE = re.compile(r"\*(?!\s)(.+?)(?<!\s)\*")
# __bold__ / _italic_ -- unlike `*`, underscore emphasis requires a boundary
# that is NOT a word character on either outer side, so "my_file_name.py"
# is left alone (CommonMark disables intra-word `_` emphasis for exactly
# this reason: it is common inside identifiers and paths).
_MD_UNDERSCORE_BOLD_RE = re.compile(r"(?<!\w)__(?!\s)(.+?)(?<!\s)__(?!\w)")
_MD_UNDERSCORE_ITALIC_RE = re.compile(r"(?<!\w)_(?!\s)(.+?)(?<!\s)_(?!\w)")
# Inline code span: `like this`.
_MD_INLINE_CODE_RE = re.compile(r"`([^`\n]+)`")
# A leading heading/blockquote/list marker on a line: "# ", "> ", "- ", "* ".
_MD_LEADING_MARKER_RE = re.compile(r"^\s*(?:#{1,6}|>|[-*])\s+", re.MULTILINE)


def _strip_markdown(text: str) -> str:
    """Strip the markdown decoration a preview bubble should not show raw.

    Removes emphasis markers, inline-code backticks and leading heading /
    blockquote / list markers -- keeping the wrapped TEXT, not the markup.
    Whitespace collapsing happens separately, after this, at the call site.
    """
    text = _MD_LEADING_MARKER_RE.sub("", text)
    text = _MD_INLINE_CODE_RE.sub(r"\1", text)
    text = _MD_STAR_BOLD_RE.sub(r"\1", text)
    text = _MD_STAR_ITALIC_RE.sub(r"\1", text)
    text = _MD_UNDERSCORE_BOLD_RE.sub(r"\1", text)
    text = _MD_UNDERSCORE_ITALIC_RE.sub(r"\1", text)
    return text


def latest_preview(
    path: str,
    tail_bytes: int = 65536,
    max_bytes: int = DEFAULT_PREVIEW_MAX_BYTES,
) -> dict | None:
    """Return the last user/assistant TEXT message in a Claude Code JSONL.

    Walks BACKWARD from EOF in ``tail_bytes``-sized windows -- a busy
    session's tail can be entirely thinking/tool_use/tool_result/attachment
    records for many megabytes, so a single tail read can legitimately find
    nothing even though a real text turn exists just before that window.
    Each window drops its first (probably partial) line. The scan stops at
    the first qualifying record found (scanning newest-to-oldest within a
    window, oldest-to-newest overall) or once ``max_bytes`` total has been
    scanned from EOF, whichever comes first -- the whole file is still never
    read when it exceeds that ceiling.

    Records with no plain text block -- tool_result-only user turns,
    tool_use-only assistant turns, meta/system lines -- are skipped. A user
    record whose text is entirely a system-injected wrapper (see
    ``_strip_system_injected``) is also skipped; the wrapper is stripped
    from a partially-injected user record before it is returned.

    Returns ``{"role": "user"|"assistant", "text": str, "timestamp": str|None}``
    (text whitespace-collapsed, truncated to ``MAX_PREVIEW_TEXT_LEN`` with an
    ellipsis) or ``None`` when there is nothing to show / the file cannot be
    read. Cached per (path, mtime, size).
    """
    try:
        st = os.stat(path)
    except OSError:
        logger.debug("latest_preview: could not stat %s", path, exc_info=True)
        return None

    cache_key = (st.st_mtime_ns, st.st_size)
    cached = _PREVIEW_CACHE.get(path)
    if cached is not None and cached[0] == cache_key:
        return cached[1]

    result = _compute_latest_preview(path, tail_bytes, max_bytes)
    if path not in _PREVIEW_CACHE and len(_PREVIEW_CACHE) >= _PREVIEW_CACHE_MAX:
        _PREVIEW_CACHE.pop(next(iter(_PREVIEW_CACHE)))
    _PREVIEW_CACHE[path] = (cache_key, result)
    return result


def _extract_preview_text(entry_type: str, content) -> str | None:
    """Pull the first plain-text block out of a raw JSONL `message.content`."""
    if entry_type == "user" and isinstance(content, str):
        return content
    if isinstance(content, list):
        for block in content:
            if isinstance(block, dict) and block.get("type") == "text":
                text = block.get("text")
                if isinstance(text, str):
                    return text
    return None


def _preview_from_window(lines: list[str]) -> dict | None:
    """Scan lines (oldest-first) for the LAST qualifying preview record."""
    preview: dict | None = None
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        entry_type = obj.get("type")
        if entry_type not in ("user", "assistant"):
            continue
        if obj.get("isMeta"):
            continue
        msg = obj.get("message", {})
        if not isinstance(msg, dict):
            continue
        found_text = _extract_preview_text(entry_type, msg.get("content", ""))
        if not found_text:
            continue
        if entry_type == "user":
            found_text = _strip_system_injected(found_text)
            if not found_text:
                continue
        if _TAG_ONLY_RESIDUE_RE.match(found_text):
            continue
        found_text = _strip_markdown(found_text)
        collapsed = " ".join(found_text.split())
        if not collapsed:
            continue
        if len(collapsed) > MAX_PREVIEW_TEXT_LEN:
            collapsed = collapsed[:MAX_PREVIEW_TEXT_LEN].rstrip() + "…"
        preview = {
            "role": entry_type,
            "text": collapsed,
            "timestamp": obj.get("timestamp"),
        }
    return preview


def _compute_latest_preview(
    path: str, tail_bytes: int, max_bytes: int = DEFAULT_PREVIEW_MAX_BYTES
) -> dict | None:
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            size = f.tell()
            end = size
            scanned = 0
            while end > 0 and scanned < max_bytes:
                start = max(0, end - tail_bytes)
                f.seek(start)
                chunk = f.read(end - start)
                scanned += end - start

                text = chunk.decode("utf-8", errors="replace")
                lines = text.split("\n")
                if start > 0 and lines:
                    lines = lines[1:]  # first line is probably truncated

                preview = _preview_from_window(lines)
                if preview is not None:
                    return preview

                end = start
    except OSError:
        logger.debug("latest_preview: could not read %s", path, exc_info=True)
        return None

    return None


# ── Workflow calls, read INCREMENTALLY (R-193) ────────────────────────────────
#
# `/api/terminals/{id}/workflows` used to call `read_all_messages` — open the
# whole transcript and JSON-parse every line — on EVERY poll, and the UI polls it
# every 3 s for every open pane. MEASURED 2026-09-10 with py-spy on the owner's
# sidecar with six live sessions: that path was ~19% of all samples in the
# process, burning worker threads that hold the GIL and starving the event loop
# until health probes and requests timed out. A busy session's transcript
# changes constantly, so a (size, mtime) cache would miss exactly when it
# matters. Instead each transcript is scanned ONCE and then only its appended
# bytes are parsed. Claude Code writes JSONL append-only, which is what makes
# this correct; a file that shrinks or is replaced (a new inode) is rescanned.
#
# The output is defined to be IDENTICAL to the full re-parse it replaces —
# `tests/test_workflows_incremental.py` holds the old algorithm as a reference
# and compares across appends, a partial final line, and a truncation.

_WORKFLOW_SCANS: dict = {}
_WORKFLOW_SCANS_MAX = 64
_WORKFLOW_GUARD = threading.Lock()


class _WorkflowScan:
    __slots__ = ("lock", "ino", "offset", "uses", "results")

    def __init__(self, ino: int) -> None:
        self.lock = threading.Lock()   # one per transcript: sessions never queue on each other
        self.ino = ino
        self.offset = 0                # bytes of COMPLETE lines already consumed
        self.uses: list = []           # Workflow tool_use records, in file order
        self.results: dict = {}        # tool_use_id -> {"completed_at", "is_error"}


def _apply_workflow_entry(entry: dict, uses: list, results: dict) -> None:
    """Fold one parsed entry into the scan — the exact rules the full parse used."""
    if entry.get("type") == "tool_result":
        for block in entry.get("content", []):
            tuid = block.get("tool_use_id")
            if tuid:
                results[tuid] = {
                    "completed_at": entry.get("timestamp"),
                    "is_error": block.get("is_error", False),
                }
    elif entry.get("type") == "assistant":
        for block in entry.get("content", []):
            if block.get("type") != "tool_use" or block.get("tool_name") != "Workflow":
                continue
            inp = block.get("input", {}) or {}
            uses.append({
                "tool_id": block.get("tool_id", ""),
                "name": inp.get("name") or inp.get("title") or "workflow",
                "description": inp.get("description") or "",
                "args": inp.get("args"),
                "script_preview": (inp.get("script") if isinstance(inp.get("script"), str) else None),
                "script_path": inp.get("scriptPath"),
                "started_at": entry.get("timestamp"),
            })


def _parsed_entries(raw_lines):
    for raw in raw_lines:
        line = raw.decode("utf-8", errors="replace").strip()
        if line:
            entry = parse_jsonl_entry(line)
            if entry:
                yield entry


def workflow_calls(filepath: str) -> list[dict]:
    """Every Workflow tool call in *filepath*, each paired with its result.

    Same records, fields and status rule as the full re-parse it replaces;
    callers sort and cap. Parses only bytes appended since the previous call.
    """
    try:
        st = os.stat(filepath)
    except OSError:
        return []
    with _WORKFLOW_GUARD:
        scan = _WORKFLOW_SCANS.pop(filepath, None)
        if scan is None or scan.ino != st.st_ino or st.st_size < scan.offset:
            scan = _WorkflowScan(st.st_ino)
        _WORKFLOW_SCANS[filepath] = scan           # re-insert: most recently used last
        while len(_WORKFLOW_SCANS) > _WORKFLOW_SCANS_MAX:
            _WORKFLOW_SCANS.pop(next(iter(_WORKFLOW_SCANS)))

    with scan.lock:
        tail = b""
        if st.st_size > scan.offset:
            try:
                with open(filepath, "rb") as f:
                    f.seek(scan.offset)
                    chunk = f.read()
            except OSError:
                logger.debug("Could not read transcript for workflows: %s", filepath, exc_info=True)
                chunk = b""
            cut = chunk.rfind(b"\n")
            complete, tail = (chunk[: cut + 1], chunk[cut + 1:]) if cut >= 0 else (b"", chunk)
            for entry in _parsed_entries(complete.split(b"\n")):
                _apply_workflow_entry(entry, scan.uses, scan.results)
            scan.offset += len(complete)

        uses, results = scan.uses, scan.results
        if tail.strip():
            # A final line with no newline yet. The full read counted it, so this
            # must too — but it is NOT committed, because more of it may follow.
            pending = list(_parsed_entries([tail]))
            if pending:
                uses, results = list(uses), dict(results)
                for entry in pending:
                    _apply_workflow_entry(entry, uses, results)

        out = []
        for use in uses:
            result = results.get(use["tool_id"])
            out.append({
                **use,
                "completed_at": result["completed_at"] if result else None,
                "is_error": result["is_error"] if result else False,
                "status": "completed" if result else "in_progress",
            })
        return out
