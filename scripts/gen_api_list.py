"""Generate docs/API.md from the live FastAPI app.

Walks app.routes, descending into included routers (newer FastAPI keeps them
as `_IncludedRouter` wrappers rather than flattening them), so every
registered route appears -- nothing is hand-listed.

    cd web && python ../scripts/gen_api_list.py
"""
import inspect
import logging
import os
import re
import sys

logging.disable(logging.CRITICAL)
WEB = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "web")
sys.path.insert(0, WEB)

import server  # noqa: E402
from fastapi.routing import APIRoute, APIWebSocketRoute  # noqa: E402


def walk(routes, prefix=""):
    for r in routes:
        inner = getattr(r, "original_router", None)
        if inner is not None:
            # Some FastAPI versions store child paths already prefixed; only
            # add the router prefix when the children do not carry it.
            carried = any(getattr(x, "path", "").startswith(inner.prefix) for x in inner.routes)
            yield from walk(inner.routes, prefix + ("" if carried else inner.prefix))
        elif isinstance(r, (APIRoute, APIWebSocketRoute)):
            yield prefix + r.path, r


def group(path):
    s = path.strip("/").split("/")
    if s[0] == "remote":
        return "/" + "/".join(s[:2])
    if s[0] == "api" and len(s) > 1:
        return "/api/" + s[1]
    return "/" + s[0]


rows = []
for path, r in walk(server.app.routes):
    ep = r.endpoint
    if isinstance(r, APIRoute):
        methods = ",".join(sorted(set(r.methods) - {"HEAD"}))
    else:
        methods = "WS"
    doc = (inspect.getdoc(ep) or "").strip().split("\n\n")[0]
    doc = re.sub(r"\s+", " ", doc)[:200].replace("|", r"\|")
    rows.append((path, methods, ep.__module__, ep.__name__, doc))
rows = sorted(set(rows))

out = [
    "# Plexar Studio — API reference", "",
    "Generated from the live FastAPI app by `scripts/gen_api_list.py`; do not hand-edit.",
    "Regenerate: `cd web && python ../scripts/gen_api_list.py`.", "",
    f"**{len(rows)} routes.**", "",
    "Trust boundaries (details in CLAUDE.md):", "",
    "- `/api/*`, `/ws/*` — loopback only, origin-guarded (`origin_guard.py`); no auth.",
    "- `/remote/v1/*` — paired-device bearer token; every route 404s unless `remote.enabled`.",
    "- `/.well-known/plexar` — unauthenticated estate handshake, always 200.",
    "- `/shim/*`, `/v1/*` — for the local `claude` CLI via `ANTHROPIC_BASE_URL`.",
]
cur = None
for path, m, mod, fn, doc in rows:
    g = group(path)
    if g != cur:
        out += ["", f"## `{g}`", "", "| Method | Path | Handler | Purpose |", "|---|---|---|---|"]
        cur = g
    out.append(f"| {m} | `{path}` | `{mod}.{fn}` | {doc or '—'} |")

dst = os.path.join(WEB, "..", "docs", "API.md")
with open(dst, "w", encoding="utf-8", newline="\n") as f:
    f.write("\n".join(out) + "\n")
print(f"{len(rows)} routes -> docs/API.md")
