"""N04 — nothing blocking runs on the event loop, and converting a handler to
``async def`` + ``asyncio.to_thread`` must not change what it returns.

Measured (py-spy, 2.1.23, six sessions): a plain ``def`` FastAPI route runs in
anyio's threadpool (40 tokens), and ``Thread.start()`` there blocked the loop
for the whole time a GIL-holding worker ran elsewhere. server.py had exactly
four sync route handlers left, plus remote_gateway.py's ``require_device``
dependency (used by every phone route via ``Depends``, and the phone polls
the session list every 3s). All were converted to ``async def`` with the
blocking body moved to ``asyncio.to_thread``.

Two arms:
  (a) structural -- every ``@app.<method>`` handler in server.py, and every
      ``@router.``/``@admin_router.`` handler in remote_gateway.py (bar the
      one deliberate, already-threadpooled exception), must be an
      ``AsyncFunctionDef``. This is the guard that stops a fifth sync handler
      from creeping back in.
  (b) behavioural -- the converted routes must answer with the same shape
      they had before, checked by equivalence against the untouched
      lower-level call rather than frozen literals (usage figures are not
      deterministic across environments/runs) -- same spirit as
      tests/test_workflows_incremental.py's ``_reference``.
"""

import ast
from pathlib import Path

import pytest
from httpx import AsyncClient, ASGITransport

import logging_config
logging_config.setup("WARNING")

from server import app
from usage_tracker import usage_tracker

_WEB_DIR = Path(__file__).resolve().parent.parent


def _decorator_targets(node: ast.FunctionDef | ast.AsyncFunctionDef, roots: set[str]) -> bool:
    """True if any decorator on *node* is a call like ``app.get(...)`` where
    the attribute's value name is in *roots* (e.g. {"app"} or
    {"router", "admin_router"})."""
    for dec in node.decorator_list:
        if not isinstance(dec, ast.Call):
            continue
        func = dec.func
        if isinstance(func, ast.Attribute) and isinstance(func.value, ast.Name):
            if func.value.id in roots:
                return True
    return False


def _route_handlers(path: Path, roots: set[str]):
    """Yield (name, is_async) for every top-level function decorated with one
    of *roots* (e.g. @app.get, @router.post) in the module at *path*."""
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            if _decorator_targets(node, roots):
                yield node.name, isinstance(node, ast.AsyncFunctionDef)


def test_server_route_handlers_are_all_async():
    """No @app.<method> handler in server.py may be a plain `def`.

    WATCH-TO-FAIL: adding a new sync route handler to server.py (the exact
    mistake this test exists to catch -- get_workflows/get_terminal_usage/
    get_daily_usage/get_codex_transcript were all sync before N04) must fail
    this test. A handler list of length zero would mean the AST walk found
    nothing and the assertion below is vacuous, so that is asserted too.
    """
    handlers = list(_route_handlers(_WEB_DIR / "server.py", {"app"}))
    assert len(handlers) > 50, "route discovery found suspiciously few @app.* handlers"
    sync_handlers = [name for name, is_async in handlers if not is_async]
    assert sync_handlers == [], f"sync route handlers found (must be async): {sync_handlers}"


def test_remote_gateway_route_handlers_are_all_async_except_known_exception():
    """Same guard for remote_gateway.py's @router.*/@admin_router.* handlers.

    ``probe_public_url`` is the ONE deliberate exception: its own docstring
    says a plain `def` route already runs in FastAPI's threadpool, which is
    exactly right for its blocking urllib call, so it is not part of N04's
    scope (require_device is). Any OTHER sync handler appearing here is a new
    regression, not this known case, and must fail the test.
    """
    handlers = list(_route_handlers(_WEB_DIR / "remote_gateway.py", {"router", "admin_router"}))
    assert len(handlers) > 15, "route discovery found suspiciously few remote_gateway handlers"
    known_sync = {"probe_public_url"}
    sync_handlers = {name for name, is_async in handlers if not is_async}
    assert sync_handlers == known_sync, (
        f"unexpected sync remote_gateway handlers (expected only {known_sync}): {sync_handlers}"
    )


@pytest.fixture
def client():
    transport = ASGITransport(app=app)
    # Loopback base_url: the origin guard's anti-rebinding clause 403s a
    # non-loopback Host on every route.
    return AsyncClient(transport=transport, base_url="http://127.0.0.1:8420")


@pytest.mark.asyncio
async def test_daily_usage_route_matches_untouched_lower_level_call(client):
    """GET /api/usage/daily must still just be usage_tracker.daily_summary(day),
    now dispatched via asyncio.to_thread instead of being called directly on
    the loop -- the shape must be byte-identical either way.
    """
    reference = usage_tracker.daily_summary(None)
    res = await client.get("/api/usage/daily")
    assert res.status_code == 200
    assert res.json() == reference


@pytest.mark.asyncio
async def test_terminal_usage_route_404_shape_unchanged_for_missing_session(client):
    """GET /api/terminals/{id}/usage for a session that does not exist must
    still answer the same 404 body it always did. This is the "keep the 404
    branch outside the to_thread hop" contract: a missing session must be
    answered without paying for a thread hop, and the wrong-shaped body a
    thread-hop refactor could accidentally introduce (e.g. by letting an
    exception from asyncio.to_thread surface as a 500) must not happen.
    """
    res = await client.get("/api/terminals/nonexistent-fake-id/usage")
    assert res.status_code == 404
    assert res.json() == {"error": "Terminal not found"}


@pytest.mark.asyncio
async def test_workflows_route_404_shape_unchanged_for_missing_session(client):
    res = await client.get("/api/terminals/nonexistent-fake-id/workflows")
    assert res.status_code == 404
    assert res.json() == {"error": "Terminal not found"}


@pytest.mark.asyncio
async def test_codex_transcript_route_404_shape_unchanged_for_missing_session(client):
    res = await client.get("/api/terminals/nonexistent-fake-id/transcript")
    assert res.status_code == 404
    assert res.json() == {"error": "Codex terminal not found"}
