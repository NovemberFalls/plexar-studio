"""Native Codex rollout usage; identity comes from metadata, not from a guess.

Discovery scans the sessions tree by spawn time and ``session_meta`` contents —
it never enumerates process handles (see ``discover_rollout``), and it falls back
to recency only inside the narrow, already-filtered case documented there.

Only numeric/accounting metadata is retained. Cumulative totals are snapshots,
cached input is a subset of input, and reasoning is a subset of output.
"""
from __future__ import annotations

import json
import logging
import math
import os
import time
from pathlib import Path
from datetime import datetime, timedelta, timezone

logger = logging.getLogger("cockpit.codex_usage")


def _subscription_limits(snapshots):
    """Native observed windows, not a live account query or token estimate."""
    limits, expired = [], False
    now = datetime.now(timezone.utc).timestamp()
    observed = None
    for identifier, snapshot in snapshots.items():
        timestamp = snapshot.get("observed_at")
        if isinstance(timestamp, str) and (observed is None or timestamp > observed):
            observed = timestamp
        name = snapshot.get("limit_name") or ("Codex" if identifier == "codex" else identifier)
        for kind in ("primary", "secondary"):
            window = snapshot.get(kind)
            if not isinstance(window, dict):
                continue
            percent = window.get("used_percent")
            minutes = window.get("window_minutes")
            if (not isinstance(percent, (int, float)) or isinstance(percent, bool)
                    or not math.isfinite(percent) or not 0 <= percent <= 100
                    or _integer(minutes) is None or minutes <= 0):
                continue
            reset = window.get("resets_at")
            reset_iso = None
            if isinstance(reset, (int, float)) and not isinstance(reset, bool) and math.isfinite(reset):
                if reset <= now:
                    expired = True
                    continue
                try:
                    reset_iso = datetime.fromtimestamp(reset, timezone.utc).isoformat()
                except (ValueError, OverflowError, OSError):
                    continue
            if minutes % 1440 == 0:
                amount, unit = minutes // 1440, "day"
            elif minutes % 60 == 0:
                amount, unit = minutes // 60, "hour"
            else:
                amount, unit = minutes, "minute"
            limits.append({"kind": f"{identifier}:{kind}",
                           "label": f"{name} · {amount} {unit}{'s' if amount != 1 else ''}",
                           "percent": percent, "resets_at": reset_iso,
                           "severity": "critical" if percent >= 90 else "warning" if percent >= 75 else "normal"})
    detail = "Observed in this Codex session; may lag account usage."
    if expired:
        detail = "Expired observations are omitted; waiting for updated Codex limits."
    elif not limits:
        detail = "No subscription limits have been observed in this Codex session."
    return {"available": bool(limits), "limits": limits, "detail": detail, "observed_at": observed}


class ReferencePricing:
    def __init__(self):
        try:
            self.data = json.loads(Path(__file__).with_name("codex_pricing.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            logger.warning("Codex reference pricing unavailable", exc_info=True)
            self.data = {}

    def price_for(self, model, timestamp):
        row = self.data.get("models", {}).get(model)
        if row is None:
            return None
        return {**row, "long_context_threshold": self.data["long_context_threshold"],
                "source": self.data["source"]}


def reference_pricing():
    return ReferencePricing()


def _integer(value):
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None


def _usage(value):
    if not isinstance(value, dict):
        return None
    keys = ("input_tokens", "cached_input_tokens", "output_tokens", "total_tokens")
    result = {key: _integer(value.get(key)) for key in keys}
    result["cache_write_input_tokens"] = _integer(value.get("cache_write_input_tokens", 0))
    if any(value is None for value in result.values()):
        return None
    if result["cached_input_tokens"] + result["cache_write_input_tokens"] > result["input_tokens"]:
        return None
    if result["total_tokens"] != result["input_tokens"] + result["output_tokens"]:
        return None
    return result


def _same_directory(a, b):
    return os.path.normcase(os.path.abspath(a)) == os.path.normcase(os.path.abspath(b))


# Discovery is a DIRECTORY SCAN, never a handle enumeration (R-194).
# `psutil.Process.open_files()` enumerates every handle on the machine on
# Windows and holds the GIL for the whole call: measured 2.9 s per scan against
# a live nine-process Codex tree, with a competing Python thread reduced to 38%
# of its rate. It ran every 10-30 s per Codex session from the default executor
# and from the sync usage route, starving the event loop until the Tauri
# watchdog gave up on /api/version and killed the sidecar with every session in
# it. No periodic path may call it again.
_DISCOVER_SLACK_S = 60.0            # clock skew between created_at and the CLI's first write
_DISCOVER_FALLBACK_WINDOW_S = 24 * 60 * 60
_DISCOVER_MAX_DAYS = 31
# Only the expected-id search walks history: `codex resume <id>` attaches to a
# rollout written days ago and untouched until the first turn, so the spawn
# window cannot see it, and an EXACT id match carries no mis-attribution risk.
# Bounded to the newest day directories, newest first, stopping at the match.
_DISCOVER_MAX_HISTORY_DAYS = 120


def _creation_time(info):
    """Birth time where the platform records one, else mtime.

    Windows' ``st_ctime`` IS creation time; on POSIX it is inode-change time,
    which a chmod or a rename moves, so it is never used here.
    """
    birth = getattr(info, "st_birthtime", None)
    if isinstance(birth, (int, float)) and birth > 0:
        return float(birth)
    return float(info.st_ctime if os.name == "nt" else info.st_mtime)


def _candidate_files(root, since, history=False):
    """Rollout files in the day directories that can hold one, never the tree.

    The CLI writes ``<root>/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl``; ``root``
    itself is also listed because older layouts (and tests) keep them flat.
    The day window runs from the day before ``since`` to tomorrow, so a
    local/UTC or DST disagreement cannot hide the right directory.

    ``history=True`` (the expected-id search only) instead lists the newest
    ``_DISCOVER_MAX_HISTORY_DAYS`` existing day directories, newest first, so a
    resumed rollout older than the window is still reachable — still a listing
    of day directories, never a walk of the whole tree.
    """
    directories = [root]
    if history:
        try:
            days = [path for path in root.glob("*/*/*") if path.is_dir()]
        except (OSError, ValueError):
            days = []
        days.sort(key=lambda path: str(path), reverse=True)
        directories.extend(days[:_DISCOVER_MAX_HISTORY_DAYS])
    else:
        try:
            start = datetime.fromtimestamp(since) - timedelta(days=1)
        except (ValueError, OSError, OverflowError):
            start = datetime.now() - timedelta(days=1)
        day = datetime(start.year, start.month, start.day)
        end = datetime.now() + timedelta(days=1)
        for _ in range(_DISCOVER_MAX_DAYS):
            if day > end:
                break
            directories.append(root / f"{day.year:04d}" / f"{day.month:02d}" / f"{day.day:02d}")
            day += timedelta(days=1)
    for directory in directories:
        try:
            entries = list(directory.iterdir())
        except (OSError, ValueError):
            continue
        for entry in entries:
            if entry.name.startswith("rollout-") and entry.suffix == ".jsonl":
                yield entry


def discover_rollout(pid: int, cwd: str, claimed_paths=(), sessions_root=None,
                     expected_session_id=None, spawned_at=None):
    """Return this pane's root CLI rollout, found by scanning the sessions tree.

    A candidate is a ``rollout-*.jsonl`` whose first record is a ``session_meta``
    for a user (not subagent) CLI thread in ``cwd``, which no other live pane has
    claimed, and which was created or last written at or after ``spawned_at``
    (epoch seconds) less a minute of slack. With no ``spawned_at`` the window is
    the last 24 hours.

    ``expected_session_id`` wins outright when given, **including outside that
    window**: a `codex resume <id>` pane attaches to a rollout written days ago
    and untouched until its first turn, and an exact id match is unique, so
    there is nothing for recency or a spawn time to protect against. Every other
    filter (cli/user thread, cwd, claimed, inside the root) still applies, and
    the search is bounded to the newest ``_DISCOVER_MAX_HISTORY_DAYS`` day
    directories, newest first, stopping at the match. Otherwise a single
    unclaimed candidate binds, and when several remain the most recently CREATED
    one is preferred — **the one deliberate departure from the old "never search
    by recency" rule**, and safe here only because the alternatives are already
    excluded: every other Studio pane's rollout is in ``claimed_paths``, files
    predating this pane's spawn are outside the window, and a native ``/new`` or
    ``/resume`` inside the pane is exactly the newer file we want. The backstop
    is unchanged: ``refresh_codex_usage`` compares the reader's ``session_id``
    against ``session.codex_session_id`` and unbinds with a warning on mismatch.
    Without a spawn time there is no recency to trust, so ambiguity stays unknown.

    ``pid`` is retained for the call signature and validated, but no handle of
    that process is inspected — see the note above this function.
    """
    if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
        return None
    root = Path(sessions_root or Path(os.environ.get("CODEX_HOME", Path.home() / ".codex")) / "sessions").resolve()
    claimed = {os.path.normcase(str(Path(path).resolve())) for path in claimed_paths}
    timed = (isinstance(spawned_at, (int, float)) and not isinstance(spawned_at, bool)
             and math.isfinite(spawned_at) and spawned_at > 0)
    since = (spawned_at - _DISCOVER_SLACK_S) if timed else (time.time() - _DISCOVER_FALLBACK_WINDOW_S)
    wanted = expected_session_id is not None
    files = list(_candidate_files(root, since, history=wanted))
    if wanted:
        # The id is usually the filename's uuid; looking at those first turns the
        # common case into one open, without relying on that naming holding.
        files.sort(key=lambda path: str(expected_session_id) not in path.name)
    candidates = []
    for candidate in files:
        try:
            path = candidate.resolve()
            if not path.is_relative_to(root) or os.path.normcase(str(path)) in claimed:
                continue
            info = path.stat()
            # An exact id match is unique, so the spawn window does not apply to
            # it: a `codex resume <id>` rollout predates the pane and is not
            # written to until the first turn.
            if not wanted and max(_creation_time(info), info.st_mtime) < since:
                continue
            with path.open("rb") as stream:
                entry = json.loads(stream.readline(2 * 1024 * 1024))
            meta = entry.get("payload") or {}
            identity = meta.get("id") or meta.get("session_id")
            if not (entry.get("type") == "session_meta" and meta.get("source") == "cli"
                    and meta.get("thread_source", "user") == "user"
                    and isinstance(meta.get("cwd"), str) and _same_directory(meta["cwd"], cwd)
                    and identity):
                continue
            if wanted:
                if identity == expected_session_id:
                    return path
                continue
            candidates.append((_creation_time(info), path))
        except (OSError, ValueError, TypeError, AttributeError):
            continue
    if not candidates or (len(candidates) > 1 and not timed):
        return None
    return max(candidates, key=lambda item: item[0])[1]


def spawn_epoch(created_at):
    """Epoch seconds for a ``TerminalSession.created_at`` (an ISO-8601 UTC string)."""
    if isinstance(created_at, (int, float)) and not isinstance(created_at, bool):
        return float(created_at)
    if not isinstance(created_at, str) or not created_at:
        return None
    try:
        parsed = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
    except ValueError:
        logger.debug("Unparsable session created_at: %r", created_at, exc_info=True)
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.timestamp()


def _estimate(usage, rate):
    if not isinstance(rate, dict):
        return None
    values = [rate.get(key) for key in ("input_per_mtok", "output_per_mtok", "cache_read_per_mtok")]
    if any(not isinstance(value, (int, float)) or isinstance(value, bool)
           or not math.isfinite(value) or value < 0 for value in values):
        return None
    inp, out, cached = values
    writes = usage.get("cache_write_input_tokens", 0)
    write_rate = rate.get("cache_write_per_mtok", 0 if not writes else None)
    if not isinstance(write_rate, (int, float)) or not math.isfinite(write_rate) or write_rate < 0:
        return None
    if rate.get("long_context_threshold") and usage["input_tokens"] > rate["long_context_threshold"]:
        inp, cached, write_rate, out = inp * 2, cached * 2, write_rate * 2, out * 1.5
    return ((usage["input_tokens"] - usage["cached_input_tokens"] - writes) * inp
            + usage["cached_input_tokens"] * cached + writes * write_rate + usage["output_tokens"] * out) / 1_000_000


class CodexUsageReader:
    """Incrementally read complete lines. ``pricing`` implements price_for(model, timestamp).

    Unknown rates yield None, never Claude fallback prices or a fake zero bill.
    Cost is API-equivalent estimation, not the ChatGPT subscription charge.
    """
    def __init__(self):
        self._files = {}

    @staticmethod
    def _new():
        return {"offset": 0, "session_id": None, "model": None, "totals": None,
                "last": None, "context_window": None, "cost": 0.0, "priced": True,
                "last_event_ts": None, "events": [], "epoch": 0,
                "record_totals": None, "responses": set(), "expects_records": False,
                "subscription_snapshots": {}}

    def forget(self, path):
        self._files.pop(str(Path(path).resolve()), None)

    def take_events(self, path):
        state = self._files.get(str(Path(path).resolve()))
        if state is None:
            return []
        events, state["events"] = state["events"], []
        return events

    def restore_events(self, path, events):
        """Put a failed database batch back before newly observed events."""
        state = self._files.get(str(Path(path).resolve()))
        if state is not None:
            state["events"] = list(events) + state["events"]

    def read(self, path, pricing=None):
        path = Path(path).resolve()
        key = str(path)
        state = self._files.setdefault(key, self._new())
        try:
            if path.stat().st_size < state["offset"]:
                state = self._files[key] = self._new()
            with path.open("rb") as stream:
                stream.seek(state["offset"])
                while True:
                    line = stream.readline()
                    if not line or not line.endswith(b"\n"):
                        break
                    state["offset"] = stream.tell()
                    try:
                        entry = json.loads(line)
                        self._consume(state, entry, pricing)
                    except (ValueError, TypeError, AttributeError):
                        continue
        except OSError:
            logger.debug("Codex rollout unavailable: %s", path.name, exc_info=True)
        totals = state["record_totals"] if state["record_totals"] is not None else (state["totals"] or {})
        last = state["last"] or {}
        window = state["context_window"]
        context_tokens = last.get("total_tokens")
        return {"session_id": state["session_id"], "model": state["model"],
                **{key: totals.get(key) for key in ("total_tokens", "input_tokens", "cached_input_tokens", "output_tokens")},
                "context_tokens": context_tokens, "context_window": window,
                "context_percent": (min(100, round(context_tokens * 100 / window))
                                    if window and context_tokens is not None else None),
                "estimated_cost_usd": state["cost"] if state["priced"] and totals else None,
                "price_source": "configured" if state["priced"] and totals else "unpriced",
                "usage_available": bool(totals), "last_event_ts": state["last_event_ts"],
                "subscription_limits": _subscription_limits(state["subscription_snapshots"])}

    @staticmethod
    def _consume(state, entry, pricing):
        payload = entry.get("payload")
        if not isinstance(payload, dict):
            return
        if entry.get("type") == "session_meta":
            state["session_id"] = payload.get("id") or payload.get("session_id")
            version = payload.get("cli_version", "")
            try:
                state["expects_records"] = tuple(int(part) for part in version.split(".")[:3]) >= (0, 153, 0)
            except (ValueError, AttributeError):
                state["expects_records"] = False
        elif entry.get("type") == "compacted":
            state["last"] = None
        elif entry.get("type") == "turn_context":
            model = payload.get("model")
            if isinstance(model, str):
                state["model"] = model
        elif entry.get("type") == "token_usage_record":
            response = payload.get("response_id")
            values = _usage(payload.get("usage"))
            if not isinstance(response, str) or not response or values is None:
                return
            if payload.get("thread_id") and payload["thread_id"] != state["session_id"]:
                return
            if response in state["responses"]:
                return
            if state["record_totals"] is None:
                # Per-response accounting is authoritative when available;
                # token_count snapshots can reset after resume/compaction.
                state["record_totals"] = dict.fromkeys(values, 0)
                state["cost"], state["priced"], state["events"] = 0.0, True, []
            state["responses"].add(response)
            for key, value in values.items():
                state["record_totals"][key] += value
            rate = pricing.price_for(state["model"], entry.get("timestamp")) if pricing else None
            estimate = _estimate(values, rate)
            if estimate is None:
                state["priced"] = False
            else:
                state["cost"] += estimate
            state["last_event_ts"] = entry.get("timestamp")
            if state["session_id"] and state["model"] and isinstance(entry.get("timestamp"), str):
                state["events"].append({
                    "session_id": state["session_id"], "uuid": f'codex:{state["session_id"]}:response:{response}',
                    "timestamp": entry["timestamp"], "model": state["model"],
                    "input_tokens": values["input_tokens"] - values["cached_input_tokens"] - values["cache_write_input_tokens"],
                    "cache_read_tokens": values["cached_input_tokens"],
                    "cache_creation_tokens": values["cache_write_input_tokens"],
                    "output_tokens": values["output_tokens"], "estimated_cost_usd": estimate,
                })
        elif entry.get("type") == "event_msg" and payload.get("type") == "token_count":
            limits = payload.get("rate_limits")
            if isinstance(limits, dict):
                identifier = limits.get("limit_id") or "codex"
                if isinstance(identifier, str):
                    # Only accounting fields; never retain arbitrary payload data.
                    state["subscription_snapshots"][identifier] = {
                        "limit_name": limits.get("limit_name") if isinstance(limits.get("limit_name"), str) else None,
                        **{kind: {key: limits[kind].get(key) for key in ("used_percent", "window_minutes", "resets_at")}
                           if isinstance(limits.get(kind), dict) else None for kind in ("primary", "secondary")},
                        "observed_at": entry.get("timestamp"),
                    }
            info = payload.get("info")
            if not isinstance(info, dict):
                return
            window = _integer(info.get("model_context_window"))
            state["context_window"] = window if window else None
            state["last"] = _usage(info.get("last_token_usage"))
            if state["record_totals"] is not None:
                return
            totals = _usage(info.get("total_token_usage"))
            if totals is None:
                return
            prior = state["totals"] or dict.fromkeys(totals, 0)
            delta = {key: totals[key] - prior[key] for key in totals}
            if (any(value < 0 for value in delta.values())
                    or delta["cached_input_tokens"] + delta["cache_write_input_tokens"] > delta["input_tokens"]):
                state["priced"] = False
                state["epoch"] += 1
            elif delta["total_tokens"]:
                rate = pricing.price_for(state["model"], entry.get("timestamp")) if pricing else None
                estimate = _estimate(delta, rate)
                if estimate is None:
                    state["priced"] = False
                else:
                    state["cost"] += estimate
                if (not state["expects_records"] and state["session_id"] and state["model"]
                        and isinstance(entry.get("timestamp"), str)):
                    state["events"].append({
                        "session_id": state["session_id"],
                        "uuid": (f'codex:{state["session_id"]}:{state["epoch"]}:'
                                 f'{totals["input_tokens"]}:{totals["output_tokens"]}'),
                        "timestamp": entry["timestamp"], "model": state["model"],
                        "input_tokens": delta["input_tokens"] - delta["cached_input_tokens"] - delta["cache_write_input_tokens"],
                        "cache_read_tokens": delta["cached_input_tokens"],
                        "cache_creation_tokens": delta["cache_write_input_tokens"],
                        "output_tokens": delta["output_tokens"], "estimated_cost_usd": estimate,
                    })
            state["totals"] = totals
            state["last_event_ts"] = entry.get("timestamp")
