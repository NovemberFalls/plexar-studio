"""Read-only, bounded-memory pages of native Codex conversation messages."""
import json
import os
import re
import threading
from collections import OrderedDict, deque
from pathlib import Path

_TEXT_PARTS = ("input_text", "output_text", "text")
# A tool body can be megabytes (a file dump). The reader shows what Codex did,
# not a second copy of the file; the cap is stated in the entry, never silent.
_TOOL_TEXT_MAX = 12000
_EXEC_CMD = re.compile(r'\bcmd\s*:\s*("(?:[^"\\]|\\.)*")')


def _clip(text):
    if len(text) <= _TOOL_TEXT_MAX:
        return text, False
    return text[:_TOOL_TEXT_MAX], True


def _message_text(payload):
    content = payload.get("content", [])
    if not isinstance(content, list):
        return ""
    return "\n".join(part["text"] for part in content if isinstance(part, dict)
                     and part.get("type") in _TEXT_PARTS and isinstance(part.get("text"), str))


def _exec_commands(source):
    """The shell commands inside a Codex ``exec`` script, else the script itself."""
    commands = []
    for literal in _EXEC_CMD.findall(source):
        try:
            commands.append(json.loads(literal))
        except ValueError:
            continue
    return "\n".join(commands) if commands else source.strip()


def _output_text(output):
    if isinstance(output, str):
        return output
    if not isinstance(output, list):
        return ""
    pieces = []
    for part in output:
        if not isinstance(part, dict) or not isinstance(part.get("text"), str):
            continue
        text = part["text"]
        try:
            chunk = json.loads(text)
        except ValueError:
            chunk = None
        if isinstance(chunk, dict) and isinstance(chunk.get("output"), str):
            code = chunk.get("exit_code")
            pieces.append(chunk["output"] + (f"\n[exit code {code}]" if code not in (None, 0) else ""))
        else:
            pieces.append(text)
    return "".join(pieces)


def _is_native(row):
    payload = row.get("payload", {})
    return (row.get("type") == "response_item" and payload.get("type") == "message"
            and payload.get("role") in ("user", "assistant"))


def _entry(row, offset, native, full):
    """One page entry for a rollout row, or None. ``native`` selects between the
    response_item message format and the legacy event_msg format."""
    if not isinstance(row, dict):
        return None
    payload = row.get("payload", {})
    if not isinstance(payload, dict):
        return None
    kind = payload.get("type")
    base = {"index": offset, "timestamp": row.get("timestamp")}
    if _is_native(row):
        text = _message_text(payload)
        if not text:
            return None
        entry = {**base, "role": payload["role"], "text": text}
        if full and isinstance(payload.get("phase"), str):
            entry["phase"] = payload["phase"]
        return entry
    if not native and row.get("type") == "event_msg" and kind in ("user_message", "agent_message")             and isinstance(payload.get("message"), str):
        return {**base, "role": "user" if kind == "user_message" else "assistant", "text": payload["message"]}
    if not full or row.get("type") != "response_item":
        return None
    name = payload.get("name") if isinstance(payload.get("name"), str) else "tool"
    if kind == "custom_tool_call" and isinstance(payload.get("input"), str):
        text = _exec_commands(payload["input"]) if name == "exec" else payload["input"]
        tool_kind = "call"
    elif kind == "function_call" and isinstance(payload.get("arguments"), str):
        if payload.get("namespace") == "collaboration":
            # Sub-agent messages are encrypted; only the routing is readable.
            try:
                args = json.loads(payload["arguments"])
            except ValueError:
                args = {}
            target = args.get("target") if isinstance(args, dict) else None
            text = f"-> {target}" if isinstance(target, str) else ""
        else:
            text = payload["arguments"]
        tool_kind = "call"
    elif kind in ("custom_tool_call_output", "function_call_output"):
        text = _output_text(payload.get("output"))
        if not text.strip():
            return None
        name, tool_kind = None, "output"
    else:
        return None
    text, truncated = _clip(text)
    entry = {**base, "role": "tool", "kind": tool_kind, "text": text,
             "call_id": payload.get("call_id") if isinstance(payload.get("call_id"), str) else None}
    if name:
        entry["name"] = name
    if truncated:
        entry["truncated"] = True
    return entry


def _uncached_page(path, before=None, limit=50, full=False):
    messages = deque(maxlen=max(1, min(200, limit)) + 1)
    legacy_messages = deque(maxlen=messages.maxlen)
    has_native_messages = False
    try:
        with Path(path).open("rb") as stream:
            while True:
                offset = stream.tell()
                line = stream.readline(16 * 1024 * 1024)
                if not line:
                    break
                if not line.endswith(b"\n"):
                    # An incomplete append is retried on the next page request.
                    # Skip oversized records without parsing their fragments.
                    while line and not line.endswith(b"\n"):
                        line = stream.readline(16 * 1024 * 1024)
                    continue
                if before is not None and offset >= before:
                    break
                try:
                    row = json.loads(line)
                    if _is_native(row):
                        has_native_messages = True
                    entry = _entry(row, offset, False, full)
                    if entry is None:
                        continue
                    native_entry = _is_native(row) or entry["role"] == "tool"
                    (messages if native_entry else legacy_messages).append(entry)
                    if native_entry and full:
                        legacy_messages.append(entry)
                except (ValueError, TypeError, AttributeError):
                    continue
    except OSError:
        return {"messages": [], "before": None, "has_more": False, "available": False}
    if not has_native_messages:
        messages = legacy_messages
    has_more = len(messages) > max(1, min(200, limit))
    if has_more:
        messages.popleft()
    result = list(messages)
    return {"messages": result, "before": result[0]["index"] if has_more else None,
            "has_more": has_more, "available": True}


# Store offsets, never conversation text. Deep pages outside this bounded index
# use the original bounded-memory reader rather than losing old history.
_MAX_FILES = 8
_MAX_OFFSETS = 50000
_CACHE = OrderedDict()
_LOCK = threading.Lock()


def _boundary_guard(stream, position):
    """Detect truncate-and-regrow at the same inode without hashing tool bodies."""
    size = min(position, 128)
    stream.seek(0)
    head = stream.read(size)
    stream.seek(position - size)
    return head, stream.read(size)


def _index_append(stream, index, end):
    stream.seek(index["position"])
    while stream.tell() < end:
        offset = stream.tell()
        line = stream.readline(min(16 * 1024 * 1024, end - offset))
        if not line.endswith(b"\n"):
            while line and not line.endswith(b"\n") and stream.tell() < end:
                line = stream.readline(min(16 * 1024 * 1024, end - stream.tell()))
            if not line.endswith(b"\n"):
                break  # Retry this partial record when the writer finishes it.
            index["position"] = stream.tell()
            continue
        index["position"] = stream.tell()
        # Most of a rollout is token counts and item_completed events; the row
        # type sits in the first bytes, so skip those without a JSON parse.
        head = line[:160]
        if b'"response_item"' not in head and (index["native"] or b'"event_msg"' not in head
                                               or (b'"user_message"' not in line[:400] and b'"agent_message"' not in line[:400])):
            continue
        try:
            row = json.loads(line)
            if _is_native(row) and not index["native"]:
                index["native"] = True
                if not index["full"]:
                    index["offsets"].clear()
                else:
                    # Tool rows stay; only the legacy message rows are superseded.
                    index["offsets"] = deque((n for n, tool in zip(index["offsets"], index["tools"]) if tool),
                                             maxlen=_MAX_OFFSETS)
                index["tools"] = deque((True for _ in index["offsets"]), maxlen=_MAX_OFFSETS)
                index["dropped"] = False
            entry = _entry(row, offset, index["native"], index["full"])
            if entry is not None:
                if len(index["offsets"]) == _MAX_OFFSETS:
                    index["dropped"] = True
                index["offsets"].append(offset)
                index["tools"].append(entry["role"] == "tool")
        except (ValueError, TypeError, AttributeError):
            continue


def transcript_page(path, before=None, limit=50, detail="messages"):
    limit = max(1, min(200, limit))
    full = detail == "full"
    # The two details index different rows, so they are different cache entries.
    key = (str(Path(path).resolve()), full)
    # The global lock protects only cache membership. A cold file must not hold
    # up an already indexed conversation belonging to another terminal.
    with _LOCK:
        entry = _CACHE.get(key)
        if entry is None:
            entry = {"lock": threading.Lock()}
            _CACHE[key] = entry
        _CACHE.move_to_end(key)
        while len(_CACHE) > _MAX_FILES:
            _CACHE.popitem(last=False)
    with entry["lock"]:
        try:
            with Path(path).open("rb") as stream:
                stat = os.fstat(stream.fileno())
                identity = (stat.st_dev, stat.st_ino)
                index = entry if "identity" in entry else None
                if (index is None or index["identity"] != identity or stat.st_size < index["size"]
                        or (stat.st_size == index["size"] and stat.st_mtime_ns != index["mtime"])
                        or _boundary_guard(stream, index["position"]) != index["guard"]):
                    entry.update({"identity": identity, "size": 0, "mtime": None, "position": 0,
                             "native": False, "full": full, "offsets": deque(maxlen=_MAX_OFFSETS),
                             "tools": deque(maxlen=_MAX_OFFSETS), "dropped": False}
                    )
                    index = entry
                _index_append(stream, index, stat.st_size)
                index.update(size=stat.st_size, mtime=stat.st_mtime_ns)
                index["guard"] = _boundary_guard(stream, index["position"])
                offsets = [n for n in index["offsets"] if before is None or n < before]
                if index["dropped"] and len(offsets) <= limit:
                    return _uncached_page(path, before, limit, full)
                selected = offsets[-(limit + 1):]
                messages = []
                for offset in selected:
                    stream.seek(offset)
                    row = json.loads(stream.readline(16 * 1024 * 1024))
                    entry = _entry(row, offset, index["native"], full)
                    if entry is None:
                        raise ValueError("indexed row no longer parses")
                    messages.append(entry)
        except (OSError, ValueError, KeyError, TypeError):
            # The file may have been replaced/truncated while we read it.
            with _LOCK:
                if _CACHE.get(key) is entry:
                    _CACHE.pop(key, None)
            return {"messages": [], "before": None, "has_more": False, "available": False}
    has_more = len(messages) > limit
    if has_more:
        messages.pop(0)
    return {"messages": messages, "before": messages[0]["index"] if has_more else None,
            "has_more": has_more, "available": True}
