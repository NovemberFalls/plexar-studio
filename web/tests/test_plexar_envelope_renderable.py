"""Every field a renderer will stringify must leave this module as prose.

WHY THIS FILE EXISTS, AND IT IS A CORRECTION.
-------------------------------------------
The 1.29 crash (``Minified React error #31 ... object with keys {message, type,
param, code}``) was root-caused, fixed at the producer, and reported as *"one
bug, four exposures"* -- LocalEnginePanel, ProvidersSettings, EngineView,
TopBar. **That enumeration was produced by grepping consumers for ``.detail``,
and the method is wrong twice over:**

  * It OVERCOUNTED. Three of those four (ProvidersSettings, EngineView, TopBar)
    render ``GET /api/local/status``, whose ``detail`` is a prose string written
    by ``server.py``'s identity fingerprint. They never touched this module's
    envelope and were never at risk. This module's envelope has exactly ONE
    renderer today.
  * It UNDERCOUNTED the thing that actually matters. The owner then hit the same
    error class on a surface the list did not contain -- found by USING the
    product, not by searching it. A count arrived at by grep is a claim about
    what someone thought to search for.

So the enumeration moved to the only place it can be complete: **the producer.**
A renderer can only stringify what the wire delivers. If every dict this module
can return carries renderable values, the number of consumers stops mattering --
present, future, and the ones nobody remembered.

THE METHOD IS REFLECTIVE, WHICH IS THE POINT.
--------------------------------------------
The functions under test are discovered with ``inspect``, not listed. A new
``fetch_whatever()`` added tomorrow is covered the day it is written, by a test
nobody edits. A hand-maintained list would reproduce the exact failure this file
was written to stop: it would cover what its author remembered.

The check is likewise recursive over the whole returned structure rather than
over a named field, because ``detail`` is not special -- it is simply the first
object-valued field that reached a ``<p>``. ``reason`` and ``action`` are
rendered the same way on the same panels and would fail identically.
"""

from __future__ import annotations

import inspect
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import plexar_client as pc  # noqa: E402


# The exact shape Plexar refuses with, measured at the wire 2026-08-03 against
# the live rig. This is not an invented worst case -- it is the payload that
# blanked the app.
OPENAI_ERROR_BODY = {
    "detail": {
        "message": "This key is a guest key. It can call the models that are "
                   "currently serving and read its own usage, but it cannot "
                   "change anything on this rig.",
        "type": "permission_error",
        "param": None,
        "code": "forbidden",
    }
}

# A second shape with NO recognised prose key anywhere. This is the arm that
# catches a "fix" that only special-cases `.message`: an unknown error format
# must be stringified, never passed through as an object and never dropped.
ALIEN_ERROR_BODY = {"error": {"nested": {"who": "knows"}, "digits": [1, 2, 3]}}

# The keys a renderer puts straight into JSX today. Kept as data so the failure
# message can name which one broke.
RENDERED_KEYS = ("detail", "reason", "action", "message")


def _make_server(status: int, body: dict):
    class Handler(BaseHTTPRequestHandler):
        def _respond(self):
            payload = json.dumps(body).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        do_GET = _respond
        do_POST = _respond

        def log_message(self, *_a):  # keep pytest output readable
            pass

    srv = HTTPServer(("127.0.0.1", 0), Handler)
    t = threading.Thread(target=srv.serve_forever, daemon=True)
    t.start()
    return srv, f"http://127.0.0.1:{srv.server_port}"


def _renderable_violations(node, path="<root>"):
    """Every value stored under a rendered key must be a str or None.

    Recursive because the defect was a nested object in the first place: a check
    that only looked at the top level of the envelope would have passed the
    original crash payload if it had been one level deeper.
    """
    bad = []
    if isinstance(node, dict):
        for key, value in node.items():
            here = f"{path}.{key}"
            if key in RENDERED_KEYS and not isinstance(value, (str, type(None))):
                bad.append((here, type(value).__name__, value))
            bad.extend(_renderable_violations(value, here))
    elif isinstance(node, list):
        for i, value in enumerate(node):
            bad.extend(_renderable_violations(value, f"{path}[{i}]"))
    return bad


def _wire_functions():
    """Discover, do not list.

    A public function of this module that takes ``base_url`` is a function that
    talks to Plexar and therefore a function whose refusals reach a screen.
    """
    found = []
    for name, fn in inspect.getmembers(pc, inspect.isfunction):
        if name.startswith("_"):
            continue
        if fn.__module__ != pc.__name__:
            continue
        params = inspect.signature(fn).parameters
        if "base_url" not in params:
            continue
        found.append((name, fn))
    return sorted(found)


def _call(fn, base_url):
    """Supply the required non-default arguments positionally, generically."""
    sig = inspect.signature(fn)
    args = []
    for name, param in sig.parameters.items():
        if param.default is not inspect.Parameter.empty:
            break
        args.append(base_url if name == "base_url" else _stub_arg(name))
    return fn(*args)


def _stub_arg(name):
    # control_instance is the only function needing more than base_url; its
    # `action` must be one this module accepts, or it short-circuits on
    # `bad_action` and never reaches the wire -- which would make this test
    # pass without testing anything.
    return {"instance_id": "inst-1", "action": "unload"}.get(name, "x")


def test_the_wire_surface_is_not_empty():
    """Guard the guard.

    Reflection that finds nothing produces a suite of zero parametrised cases
    and a green run -- the shape of failure this whole file is arguing against.
    """
    names = [n for n, _ in _wire_functions()]
    assert len(names) >= 5, f"reflection found too few wire functions: {names}"
    assert "fetch_reports" in names, "the function that produced the 1.29 crash is missing"


@pytest.mark.parametrize("status", [400, 401, 403, 404, 500, 503])
@pytest.mark.parametrize("body,label", [
    (OPENAI_ERROR_BODY, "openai-shaped"),
    (ALIEN_ERROR_BODY, "unrecognised-shape"),
])
def test_every_refusal_is_renderable(status, body, label):
    srv, base = _make_server(status, body)
    try:
        for name, fn in _wire_functions():
            result = _call(fn, base)
            bad = _renderable_violations(result, name)
            assert not bad, (
                f"{name}() returned a value React cannot render "
                f"({label}, HTTP {status}): "
                + "; ".join(f"{p} is {t}: {v!r}" for p, t, v in bad)
            )
    finally:
        srv.shutdown()


@pytest.mark.parametrize("status", [401, 403, 500])
def test_a_refusal_still_says_something(status):
    """Renderable is necessary and not sufficient.

    Dropping the field would satisfy every assertion above while making the
    panel read "nothing was wrong" -- the opposite claim, and a worse one than a
    clumsy message. So the reason must survive too.
    """
    srv, base = _make_server(status, OPENAI_ERROR_BODY)
    try:
        for name, fn in _wire_functions():
            result = _call(fn, base)
            if not isinstance(result, dict):
                continue
            if result.get("available") is False or result.get("ok") is False:
                assert result.get("detail"), f"{name}() refused with an empty detail"
    finally:
        srv.shutdown()
