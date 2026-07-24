#!/usr/bin/env python3
"""lane-broker: queue-owning API gateway in front of a single-slot local
inference server (LM Studio at 127.0.0.1:1234, max_concurrent=1 by law).

- Explicit priority queue (interactive > worker > batch, FIFO within class).
- Forwards EXACTLY ONE request at a time upstream; responses are relayed
  byte-verbatim (no body translation, SSE preserved).
- ETA from rolling median wall per prompt-size bucket, logged to jobs.jsonl.
- Load-aware spill: 503 {spill:true,...} when predicted wait exceeds the
  class threshold at enqueue time. The broker never calls any external API.
- --shadow: observe + log only, no queueing (safe first deploy).

stdlib only. Python 3.12. Windows-first.
"""
from __future__ import annotations

import argparse
import asyncio
import collections
import heapq
import html
import itertools
import json
import os
import statistics
import sys
import time
from datetime import datetime, timezone

CLASS_RANK = {"interactive": 0, "worker": 1, "batch": 2}
DEFAULT_CLASS = "worker"
QUEUED_PATHS = {"/v1/chat/completions", "/v1/completions", "/v1/messages"}
BUCKETS = [(4_000, "<4K"), (16_000, "4-16K"), (48_000, "16-48K"), (float("inf"), ">48K")]
HISTORY_PER_BUCKET = 50
DEFAULT_WALL_S = 120.0
MIN_REMAINING_S = 5.0


def now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def bucket_of(prompt_chars: int) -> str:
    for limit, name in BUCKETS:
        if prompt_chars < limit:
            return name
    return BUCKETS[-1][1]


class EtaModel:
    """Rolling median wall-clock per prompt-size bucket, seeded from jobs.jsonl.
    Also retains the full record list in memory for /metrics aggregation."""

    def __init__(self, log_path: str):
        self.log_path = log_path
        self.hist: dict[str, collections.deque] = {
            name: collections.deque(maxlen=HISTORY_PER_BUCKET) for _, name in BUCKETS
        }
        self.records: list[dict] = []
        self._load()
        self.session_start_idx = len(self.records)
        self.session_start_ts = now_iso()

    def _load(self) -> None:
        try:
            with open(self.log_path, "r", encoding="utf-8") as f:
                for line in f:
                    try:
                        rec = json.loads(line)
                        self.hist[bucket_of(int(rec["prompt_chars"]))].append(
                            float(rec["wall_ms"]) / 1000.0
                        )
                        self.records.append(rec)
                    except (KeyError, ValueError, TypeError):
                        continue
        except OSError:
            pass

    def record(self, rec: dict) -> None:
        self.hist[bucket_of(rec["prompt_chars"])].append(rec["wall_ms"] / 1000.0)
        self.records.append(rec)
        os.makedirs(os.path.dirname(self.log_path) or ".", exist_ok=True)
        with open(self.log_path, "a", encoding="utf-8") as f:
            f.write(json.dumps(rec, separators=(",", ":")) + "\n")

    def predict(self, prompt_chars: int) -> float:
        name = bucket_of(prompt_chars)
        if self.hist[name]:
            return statistics.median(self.hist[name])
        # fall back to any populated bucket, nearest first
        order = [n for _, n in BUCKETS]
        i = order.index(name)
        for dist in range(1, len(order)):
            for j in (i - dist, i + dist):
                if 0 <= j < len(order) and self.hist[order[j]]:
                    return statistics.median(self.hist[order[j]])
        return DEFAULT_WALL_S


class Job:
    def __init__(self, lane_class: str, prompt_chars: int, meta: dict):
        self.lane_class = lane_class
        self.prompt_chars = prompt_chars
        self.meta = meta  # model, client_id, trace_id, trace_parent, path
        self.enqueued_at = time.monotonic()
        self.started_at: float | None = None
        self.granted = asyncio.Event()
        self.done = asyncio.Event()
        self.cancelled = False


class Broker:
    def __init__(self, upstream_host: str, upstream_port: int, eta: EtaModel,
                 spill: dict[str, float | None], shadow: bool):
        self.upstream = (upstream_host, upstream_port)
        self.eta = eta
        self.spill = spill
        self.shadow = shadow
        self._heap: list[tuple[int, int, Job]] = []
        self._seq = itertools.count()
        self._kick = asyncio.Event()
        self.inflight: Job | None = None
        self.spilled: collections.Counter = collections.Counter()

    # ---- queue state -----------------------------------------------------
    def queued_jobs(self) -> list[Job]:
        return [j for _, _, j in sorted(self._heap) if not j.cancelled]

    def inflight_remaining(self) -> float:
        j = self.inflight
        if j is None or j.started_at is None:
            return 0.0
        pred = self.eta.predict(j.prompt_chars)
        return max(pred - (time.monotonic() - j.started_at), MIN_REMAINING_S)

    def predicted_wait(self, lane_class: str) -> float:
        """Wait a new job of lane_class would see before starting."""
        rank = CLASS_RANK[lane_class]
        wait = self.inflight_remaining()
        for j in self.queued_jobs():
            if CLASS_RANK[j.lane_class] <= rank:
                wait += self.eta.predict(j.prompt_chars)
        return wait

    # ---- dispatcher ------------------------------------------------------
    async def dispatcher(self) -> None:
        while True:
            while True:
                job = None
                while self._heap:
                    _, _, j = heapq.heappop(self._heap)
                    if not j.cancelled:
                        job = j
                        break
                if job is not None:
                    break
                self._kick.clear()
                await self._kick.wait()
            self.inflight = job
            job.started_at = time.monotonic()
            job.granted.set()
            await job.done.wait()
            self.inflight = None

    def enqueue(self, job: Job) -> None:
        heapq.heappush(self._heap, (CLASS_RANK[job.lane_class], next(self._seq), job))
        self._kick.set()

    def position_of(self, job: Job) -> int:
        for i, j in enumerate(self.queued_jobs()):
            if j is job:
                return i
        return -1


# ---- HTTP plumbing -------------------------------------------------------

async def read_http_head(reader: asyncio.StreamReader) -> tuple[bytes, dict[str, str]] | None:
    try:
        head = await reader.readuntil(b"\r\n\r\n")
    except (asyncio.IncompleteReadError, asyncio.LimitOverrunError, ConnectionError):
        return None
    lines = head.split(b"\r\n")
    headers: dict[str, str] = {}
    for line in lines[1:]:
        if b":" in line:
            k, _, v = line.partition(b":")
            headers[k.decode("latin-1").strip().lower()] = v.decode("latin-1").strip()
    return lines[0], headers


async def read_body(reader: asyncio.StreamReader, headers: dict[str, str]) -> bytes:
    if headers.get("transfer-encoding", "").lower() == "chunked":
        out = bytearray()
        while True:
            size_line = await reader.readuntil(b"\r\n")
            size = int(size_line.strip().split(b";")[0], 16)
            chunk = await reader.readexactly(size + 2)
            if size == 0:
                break
            out += chunk[:-2]
        return bytes(out)
    n = int(headers.get("content-length", "0") or "0")
    return await reader.readexactly(n) if n else b""


CAPTURE_CAP = 4 * 1024 * 1024  # observe at most this much response for usage sniffing


def extract_usage(raw: bytes) -> dict:
    """Passively pull token usage out of a COPY of the relayed response bytes.
    Handles OpenAI + Anthropic shapes, plain JSON and SSE. Never touches the
    bytes the client received — observation only. Returns {} when unknown."""
    head, _, body = raw.partition(b"\r\n\r\n")
    if not body:
        return {}
    hl = head.lower()
    if b"transfer-encoding: chunked" in hl:
        out, rest = bytearray(), body
        try:
            while rest:
                size_line, _, rest = rest.partition(b"\r\n")
                size = int(size_line.split(b";")[0], 16)
                if size == 0:
                    break
                out += rest[:size]
                rest = rest[size + 2:]
        except (ValueError, IndexError):
            pass
        body = bytes(out)
    p = c = None
    if b"text/event-stream" in hl or body.lstrip().startswith(b"data:") or b"\ndata:" in body[:200]:
        for line in body.split(b"\n"):
            line = line.strip()
            if not line.startswith(b"data:"):
                continue
            payload = line[5:].strip()
            if payload == b"[DONE]":
                continue
            try:
                d = json.loads(payload)
            except ValueError:
                continue
            u = d.get("usage") or d.get("message", {}).get("usage") or {}
            if "prompt_tokens" in u or "input_tokens" in u:
                p = u.get("prompt_tokens", u.get("input_tokens"))
            if "completion_tokens" in u or "output_tokens" in u:
                c = u.get("completion_tokens", u.get("output_tokens"))
    else:
        try:
            u = json.loads(body).get("usage", {})
            p = u.get("prompt_tokens", u.get("input_tokens"))
            c = u.get("completion_tokens", u.get("output_tokens"))
        except (ValueError, AttributeError):
            pass
    out = {}
    if isinstance(p, int):
        out["prompt_tokens"] = p
    if isinstance(c, int):
        out["completion_tokens"] = c
    return out


def prompt_chars_of(body: bytes) -> int:
    """Sum of message-content chars if parseable; else raw body length."""
    try:
        data = json.loads(body)
        total = len(str(data.get("system", "")))
        for m in data.get("messages", []):
            c = m.get("content", "")
            total += len(c) if isinstance(c, str) else len(json.dumps(c))
        return total if total else len(body)
    except (ValueError, AttributeError, TypeError):
        return len(body)


class Server:
    def __init__(self, broker: Broker, port: int):
        self.broker = broker
        self.port = port

    async def handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            await self._handle(reader, writer)
        except (ConnectionError, asyncio.IncompleteReadError):
            pass
        finally:
            try:
                writer.close()
                await writer.wait_closed()
            except (ConnectionError, OSError):
                pass

    async def _handle(self, reader, writer) -> None:
        parsed = await read_http_head(reader)
        if parsed is None:
            return
        request_line, headers = parsed
        parts = request_line.decode("latin-1").split(" ")
        if len(parts) < 3:
            return
        method, target = parts[0], parts[1]
        path = target.split("?", 1)[0]

        if path == "/queue":
            await self._serve_queue(writer, target)
            return
        if path == "/metrics":
            await self._serve_metrics(writer, target)
            return
        if path == "/config/spill":
            body = await read_body(reader, headers)
            await self._serve_spill_config(writer, method, body)
            return
        if path == "/traces":
            await self._serve_traces(writer, target)
            return
        if path.startswith("/trace/"):
            await self._serve_trace(writer, path[len("/trace/"):])
            return

        body = await read_body(reader, headers)

        if method == "POST" and path in QUEUED_PATHS and not self.broker.shadow:
            await self._queued_forward(writer, method, target, headers, body)
        else:
            # pass-through (GET /v1/models, shadow mode, anything else)
            await self._forward(writer, method, target, headers, body,
                               log_class=self._lane_class(headers)
                               if method == "POST" and path in QUEUED_PATHS else None)

    @staticmethod
    def _lane_class(headers: dict[str, str]) -> str:
        c = headers.get("x-lane-class", DEFAULT_CLASS).lower()
        return c if c in CLASS_RANK else DEFAULT_CLASS

    def _job_meta(self, headers: dict[str, str], body: bytes, path: str, writer) -> dict:
        try:
            model = json.loads(body).get("model", "")
        except (ValueError, AttributeError):
            model = ""
        peer = writer.get_extra_info("peername")
        return {
            "model": model,
            "client_id": headers.get("x-client-id", f"{peer[0]}:{peer[1]}" if peer else "?"),
            "agent": headers.get("x-agent-id", ""),
            "trace_id": headers.get("x-trace-id", ""),
            "trace_parent": headers.get("x-trace-parent", ""),
            "path": path,
        }

    async def _queued_forward(self, writer, method, target, headers, body) -> None:
        broker = self.broker
        lane_class = self._lane_class(headers)
        pchars = prompt_chars_of(body)
        threshold = broker.spill.get(lane_class)
        predicted = broker.predicted_wait(lane_class)
        if threshold is not None and predicted > threshold:
            broker.spilled[lane_class] += 1
            payload = json.dumps({
                "spill": True,
                "predicted_wait_s": round(predicted, 1),
                "hint": "escalate-to-api",
            }).encode()
            await send_simple(writer, 503, payload)
            return

        job = Job(lane_class, pchars, self._job_meta(headers, body, target.split("?")[0], writer))
        broker.enqueue(job)
        try:
            await job.granted.wait()
            t0 = time.monotonic()
            status, raw = await self._forward(writer, method, target, headers, body,
                                              relay_only=True)
            wall_ms = int((time.monotonic() - t0) * 1000)
            rec = {
                "ts": now_iso(), "class": lane_class, "prompt_chars": pchars,
                "wall_ms": wall_ms, "status": status, **job.meta,
            }
            usage = extract_usage(raw)
            rec.update(usage)
            if usage.get("completion_tokens") and wall_ms > 0:
                rec["tokens_per_sec"] = round(usage["completion_tokens"] / (wall_ms / 1000.0), 2)
            broker.eta.record(rec)
        finally:
            job.cancelled = True
            job.done.set()

    async def _forward(self, writer, method, target, headers, body,
                       relay_only: bool = False, log_class: str | None = None
                       ) -> tuple[int, bytes]:
        """Open upstream, send the request, relay the response byte-verbatim.
        Returns (status, captured response copy) — capture is observation only
        and never alters what the client receives."""
        host, port = self.broker.upstream
        t0 = time.monotonic()
        try:
            up_r, up_w = await asyncio.open_connection(host, port)
        except OSError:
            await send_simple(writer, 502, b'{"error":"upstream unreachable"}')
            return 502, b""
        try:
            out = [f"{method} {target} HTTP/1.1\r\n".encode("latin-1")]
            sent_host = False
            for k, v in headers.items():
                if k in ("host", "connection", "content-length", "transfer-encoding"):
                    continue
                out.append(f"{k}: {v}\r\n".encode("latin-1"))
            out.append(f"host: {host}:{port}\r\n".encode("latin-1"))
            out.append(b"connection: close\r\n")
            if body or method in ("POST", "PUT"):
                out.append(f"content-length: {len(body)}\r\n".encode("latin-1"))
            out.append(b"\r\n")
            up_w.write(b"".join(out) + body)
            await up_w.drain()

            status = 0
            captured = bytearray()
            first = await up_r.read(65536)
            if first:
                try:
                    status = int(first.split(b" ", 2)[1])
                except (IndexError, ValueError):
                    status = 0
                writer.write(first)
                await writer.drain()
                captured += first
            while True:
                chunk = await up_r.read(65536)
                if not chunk:
                    break
                writer.write(chunk)
                await writer.drain()
                if len(captured) < CAPTURE_CAP:
                    captured += chunk
            if log_class is not None:  # shadow-mode observation logging
                rec = {
                    "ts": now_iso(), "class": log_class,
                    "prompt_chars": prompt_chars_of(body),
                    "wall_ms": int((time.monotonic() - t0) * 1000),
                    "status": status, "shadow": True,
                    **self._job_meta(headers, body, target.split("?")[0], writer),
                }
                usage = extract_usage(bytes(captured))
                rec.update(usage)
                if usage.get("completion_tokens") and rec["wall_ms"] > 0:
                    rec["tokens_per_sec"] = round(
                        usage["completion_tokens"] / (rec["wall_ms"] / 1000.0), 2)
                self.broker.eta.record(rec)
            return status, bytes(captured)
        finally:
            try:
                up_w.close()
                await up_w.wait_closed()
            except (ConnectionError, OSError):
                pass

    # ---- /metrics ----------------------------------------------------------
    # Definitions (contract with Cockpit): a RUN = one completion call forwarded
    # to the lane (= one jobs.jsonl record). A PROMPT = one client dispatch,
    # identified by distinct X-Trace-Id; runs without a trace id count as one
    # prompt each. SESSION = X-Client-Id. AGENT = X-Agent-Id.

    @staticmethod
    def _aggregate(recs: list[dict]) -> dict:
        walls = sorted(int(r.get("wall_ms", 0)) for r in recs)
        n = len(walls)

        def pct(p: float) -> int:
            return walls[min(n - 1, int(p * (n - 1) + 0.5))] if n else 0

        pt = sum(r.get("prompt_tokens", 0) or 0 for r in recs)
        ct = sum(r.get("completion_tokens", 0) or 0 for r in recs)
        tok_walls = sum(r["wall_ms"] for r in recs if r.get("completion_tokens"))
        tps_avg = round(ct / (tok_walls / 1000.0), 2) if tok_walls else None
        tps_cur = next((r["tokens_per_sec"] for r in reversed(recs)
                        if r.get("tokens_per_sec")), None)
        traces = [r.get("trace_id", "") for r in recs]
        prompts = len({t for t in traces if t}) + sum(1 for t in traces if not t)
        return {
            "runs_total": n,
            "prompts_total": prompts,
            "tokens_total": {"prompt": pt, "completion": ct},
            "tokens_per_sec": {"current": tps_cur, "avg": tps_avg},
            "run_time_ms": {
                "min": walls[0] if n else 0, "max": walls[-1] if n else 0,
                "avg": int(sum(walls) / n) if n else 0,
                "p50": pct(0.50), "p95": pct(0.95),
            },
        }

    def _metrics_state(self, window: str) -> dict:
        eta = self.broker.eta
        if window == "session":
            recs = eta.records[eta.session_start_idx:]
            window_start, persisted = eta.session_start_ts, False
        elif window == "24h":
            from datetime import timedelta
            cutoff = (datetime.now(timezone.utc) - timedelta(hours=24)
                      ).strftime("%Y-%m-%dT%H:%M:%SZ")
            recs = [r for r in eta.records if r.get("ts", "") >= cutoff]
            window_start, persisted = cutoff, True
        else:
            window = "lifetime"
            recs = eta.records
            window_start = recs[0].get("ts", "") if recs else eta.session_start_ts
            persisted = True

        def breakdown(key: str) -> list[dict]:
            groups: dict[str, list[dict]] = {}
            for r in recs:
                k = r.get(key) or ("(untagged)" if key != "class" else DEFAULT_CLASS)
                groups.setdefault(k, []).append(r)
            return sorted(
                ({"key": k, **self._aggregate(v)} for k, v in groups.items()),
                key=lambda d: -d["runs_total"])

        return {
            "window": window, "window_start": window_start, "persisted": persisted,
            **self._aggregate(recs),
            "by_session": breakdown("client_id"),
            "by_agent": breakdown("agent"),
            "by_lane_class": breakdown("class"),
        }

    async def _serve_metrics(self, writer, target: str) -> None:
        qs = (target.split("?", 1) + [""])[1]
        params = dict(kv.split("=", 1) for kv in qs.split("&") if "=" in kv)
        state = self._metrics_state(params.get("window", "lifetime"))
        if params.get("html") == "1":
            rows = "".join(
                f"<tr><td>{html.escape(str(b['key']))}</td><td>{b['runs_total']}</td>"
                f"<td>{b['prompts_total']}</td><td>{b['tokens_total']['completion']}</td>"
                f"<td>{b['run_time_ms']['p50']}</td></tr>"
                for b in state["by_lane_class"])
            page = ("<meta http-equiv='refresh' content='5'><title>lane-broker metrics</title>"
                    "<style>body{font-family:monospace}td,th{padding:2px 10px}</style>"
                    f"<h3>lane-broker metrics — {state['window']}</h3>"
                    f"<p>runs {state['runs_total']} · prompts {state['prompts_total']} · "
                    f"tokens {state['tokens_total']['prompt']}p/"
                    f"{state['tokens_total']['completion']}c · "
                    f"tps avg {state['tokens_per_sec']['avg']}</p>"
                    "<table border=1><tr><th>class</th><th>runs</th><th>prompts</th>"
                    f"<th>c-tokens</th><th>p50 ms</th></tr>{rows}</table>").encode()
            await send_simple(writer, 200, page, ctype="text/html")
        else:
            await send_simple(writer, 200, json.dumps(state, indent=1).encode())

    # ---- /config/spill -----------------------------------------------------
    # Spill semantics: threshold is SECONDS OF PREDICTED WAIT per lane class
    # (not queue depth). null disables spill for that class. Changes are
    # session-only (persisted: false) — restart restores CLI/default values.

    async def _serve_spill_config(self, writer, method: str, body: bytes) -> None:
        b = self.broker
        if method in ("PUT", "POST"):
            try:
                changes = json.loads(body)
                if not isinstance(changes, dict):
                    raise ValueError("body must be an object")
                for cls, val in changes.items():
                    if cls not in CLASS_RANK:
                        raise ValueError(f"unknown class {cls!r}")
                    if val is not None and not (
                            isinstance(val, (int, float)) and 0 <= val <= 86_400):
                        raise ValueError(f"{cls}: threshold must be null or 0..86400 s")
                for cls, val in changes.items():
                    b.spill[cls] = float(val) if val is not None else None
            except ValueError as e:
                await send_simple(writer, 400, json.dumps({"error": str(e)}).encode())
                return
        elif method != "GET":
            await send_simple(writer, 400, b'{"error":"use GET or PUT"}')
            return
        await send_simple(writer, 200, json.dumps({
            "spill_thresholds_s": b.spill,
            "spilled_total": sum(b.spilled.values()),
            "spilled_by_class": dict(b.spilled),
            "persisted": False,
        }).encode())

    # ---- /traces & /trace/{id} ---------------------------------------------
    # Definitions (contract with Cockpit): a ROOT is a trace_id whose runs'
    # trace_parent is empty OR references a trace_id absent from the data.
    # descendant_runs = runs of all trace_ids reachable via trace_parent edges
    # from a root, excluding the root's own runs. Runs with empty trace_id are
    # excluded entirely from traces.

    def _traced_records(self) -> list[dict]:
        return [r for r in self.broker.eta.records if r.get("trace_id")]

    @staticmethod
    def _trace_index(recs: list[dict]):
        by_id: dict[str, list[dict]] = {}
        for r in recs:
            by_id.setdefault(r["trace_id"], []).append(r)
        ids = set(by_id)
        parent_of: dict[str, str] = {
            tid: runs[0].get("trace_parent", "") for tid, runs in by_id.items()
        }
        children: dict[str, list[str]] = collections.defaultdict(list)
        for tid, tp in parent_of.items():
            if tp and tp in ids:
                children[tp].append(tid)
        roots = [tid for tid in ids if not parent_of[tid] or parent_of[tid] not in ids]
        return by_id, ids, children, parent_of, roots

    @staticmethod
    def _downward_closure(root: str, children: dict[str, list[str]]) -> set[str]:
        closure = {root}
        stack = list(children.get(root, []))
        while stack:
            t = stack.pop()
            if t in closure:
                continue
            closure.add(t)
            stack.extend(children.get(t, []))
        return closure

    async def _serve_traces(self, writer, target: str) -> None:
        qs = (target.split("?", 1) + [""])[1]
        params = dict(kv.split("=", 1) for kv in qs.split("&") if "=" in kv)
        try:
            limit = int(params.get("limit", 20))
        except ValueError:
            limit = 20
        limit = max(1, min(100, limit))

        recs = self._traced_records()
        by_id, ids, children, parent_of, roots = self._trace_index(recs)

        items = []
        for tid in roots:
            runs = sorted(by_id[tid], key=lambda r: r.get("ts", ""))
            descendant_runs = sum(
                len(by_id[t]) for t in self._downward_closure(tid, children) if t != tid
            )
            lane_classes: collections.Counter = collections.Counter(
                r.get("class", DEFAULT_CLASS) for r in runs
            )
            items.append({
                "trace_id": tid,
                "agent": runs[0].get("agent", "") if runs else "",
                "runs_total": len(runs),
                "descendant_runs": descendant_runs,
                "first_ts": runs[0]["ts"] if runs else "",
                "last_ts": runs[-1]["ts"] if runs else "",
                "wall_ms_total": sum(int(r.get("wall_ms", 0)) for r in runs),
                "lane_classes": dict(lane_classes),
            })
        items.sort(key=lambda d: d["last_ts"], reverse=True)
        items = items[:limit]
        await send_simple(writer, 200, json.dumps({
            "traces": items, "count": len(items),
        }).encode())

    async def _serve_trace(self, writer, trace_id: str) -> None:
        recs = self._traced_records()
        by_id, ids, children, parent_of, roots = self._trace_index(recs)
        if trace_id not in ids:
            await send_simple(writer, 404, json.dumps({"error": "unknown trace"}).encode())
            return

        cur = trace_id
        seen: set[str] = set()
        while parent_of.get(cur) and parent_of[cur] in ids and parent_of[cur] not in seen:
            seen.add(cur)
            cur = parent_of[cur]
        root = cur

        closure = self._downward_closure(root, children)
        nodes = []
        for t in closure:
            for r in by_id[t]:
                nodes.append({
                    "trace_id": t,
                    "trace_parent": r.get("trace_parent", ""),
                    "agent": r.get("agent", ""),
                    "client_id": r.get("client_id", ""),
                    "model": r.get("model", ""),
                    "lane_class": r.get("class", DEFAULT_CLASS),
                    "ts": r.get("ts", ""),
                    "wall_ms": r.get("wall_ms", 0),
                    "prompt_chars": r.get("prompt_chars", 0),
                    "tokens": {
                        "prompt": r.get("prompt_tokens"),
                        "completion": r.get("completion_tokens"),
                    },
                })
        nodes.sort(key=lambda n: n["ts"])
        edges = []
        for t in closure:
            p = parent_of.get(t, "")
            if p and p in closure:
                edges.append([p, t])

        await send_simple(writer, 200, json.dumps({
            "trace_id": trace_id, "nodes": nodes, "edges": edges,
        }).encode())

    # ---- /queue ----------------------------------------------------------
    def _queue_state(self) -> dict:
        b = self.broker
        state: dict = {"shadow": b.shadow, "in_flight": None, "queued": [],
                       "estimated_clear_seconds": 0.0}
        total = 0.0
        if b.inflight is not None and b.inflight.started_at is not None:
            j = b.inflight
            rem = b.inflight_remaining()
            state["in_flight"] = {
                "class": j.lane_class,
                "elapsed_s": round(time.monotonic() - j.started_at, 1),
                "predicted_remaining_s": round(rem, 1),
                "model": j.meta.get("model", ""),
                "client_id": j.meta.get("client_id", ""),
            }
            total += rem
        for i, j in enumerate(b.queued_jobs()):
            wall = b.eta.predict(j.prompt_chars)
            state["queued"].append({
                "class": j.lane_class, "position": i,
                "predicted_wall_s": round(wall, 1),
                "waiting_s": round(time.monotonic() - j.enqueued_at, 1),
                "model": j.meta.get("model", ""),
                "client_id": j.meta.get("client_id", ""),
            })
            total += wall
        state["estimated_clear_seconds"] = round(total, 1)
        return state

    async def _serve_queue(self, writer, target: str) -> None:
        state = self._queue_state()
        if "html=1" in (target.split("?", 1) + [""])[1]:
            rows = ""
            inf = state["in_flight"]
            if inf:
                rows += (f"<tr><td>IN-FLIGHT</td><td>{html.escape(inf['class'])}</td>"
                         f"<td>{inf['elapsed_s']}s elapsed</td>"
                         f"<td>~{inf['predicted_remaining_s']}s left</td></tr>")
            for q in state["queued"]:
                rows += (f"<tr><td>#{q['position']}</td><td>{html.escape(q['class'])}</td>"
                         f"<td>{q['waiting_s']}s waiting</td>"
                         f"<td>~{q['predicted_wall_s']}s wall</td></tr>")
            page = ("<meta http-equiv='refresh' content='3'><title>lane-broker</title>"
                    "<style>body{font-family:monospace}td{padding:2px 10px}</style>"
                    f"<h3>lane-broker queue{' (SHADOW)' if state['shadow'] else ''}</h3>"
                    f"<p>estimated clear: {state['estimated_clear_seconds']}s</p>"
                    f"<table border=1>{rows or '<tr><td>empty</td></tr>'}</table>").encode()
            await send_simple(writer, 200, page, ctype="text/html")
        else:
            await send_simple(writer, 200, json.dumps(state, indent=1).encode())


async def send_simple(writer, status: int, body: bytes, ctype: str = "application/json") -> None:
    reason = {200: "OK", 400: "Bad Request", 404: "Not Found", 502: "Bad Gateway",
              503: "Service Unavailable"}.get(status, "X")
    writer.write((f"HTTP/1.1 {status} {reason}\r\ncontent-type: {ctype}\r\n"
                  f"content-length: {len(body)}\r\nconnection: close\r\n\r\n").encode() + body)
    await writer.drain()


async def amain(args) -> None:
    log_path = args.log_file or os.path.join(os.path.dirname(os.path.abspath(__file__)), "jobs.jsonl")
    eta = EtaModel(log_path)
    spill = {"interactive": args.spill_interactive, "worker": args.spill_worker, "batch": None}
    host, _, port = args.upstream.rpartition(":")
    broker = Broker(host.replace("http://", "").strip("/"), int(port), eta, spill, args.shadow)
    srv = Server(broker, args.port)
    dispatcher = asyncio.create_task(broker.dispatcher())
    server = await asyncio.start_server(srv.handle, "127.0.0.1", args.port)
    mode = "SHADOW (observe+log only)" if args.shadow else "QUEUE"
    print(f"lane-broker on 127.0.0.1:{args.port} -> {broker.upstream[0]}:{broker.upstream[1]} "
          f"[{mode}] log={log_path}", flush=True)
    async with server:
        try:
            await server.serve_forever()
        finally:
            dispatcher.cancel()


def main() -> None:
    p = argparse.ArgumentParser(description="lane-broker: single-flight priority gateway")
    p.add_argument("--port", type=int, default=1235)
    p.add_argument("--upstream", default="http://127.0.0.1:1234")
    p.add_argument("--shadow", action="store_true", help="observe+log only, no queueing")
    p.add_argument("--log-file", default=None, help="jobs.jsonl path (default: alongside broker.py)")
    p.add_argument("--spill-interactive", type=float, default=30.0)
    p.add_argument("--spill-worker", type=float, default=300.0)
    args = p.parse_args()
    try:
        asyncio.run(amain(args))
    except KeyboardInterrupt:
        print("lane-broker: stopped", file=sys.stderr)


if __name__ == "__main__":
    main()
