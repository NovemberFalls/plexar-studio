"""S11 guard — the broker address has THREE owners, and they must agree.

WHY THIS FILE EXISTS. Board row S11 proposed wiring the Settings field
`providers.lane_broker.base_url` to the endpoint setter that already exists
(`POST /api/local/{id}/endpoint`). That looked like a small wiring job: the
mechanism validates, persists, and is re-applied at startup. It is not, and
these tests are the reason, pinned so the next attempt fails loudly instead of
silently misrouting inference.

BLOCKER 1 — THE ROUTE WRITES BOTH URLS.
`set_provider_endpoint` does `provider["management_url"] = url` AND
`provider["broker_url"] = url`, and `apply_persisted_endpoints()` does the same
at startup. But `lmstudio-local` deliberately holds TWO DIFFERENT addresses:
`broker_url` is the lane broker (:1235) and `management_url` is LM Studio
itself (:1234). They are different services speaking different dialects --
`_models_path()` sends LM Studio's `/api/v0/models` to the management URL, and
the broker does not serve it. Collapsing them points the management plane at the
broker and the model list quietly empties.

BLOCKER 2 — THE ROUTE WOULD CHANGE ONLY ONE OF THREE OWNERS.
The broker's address is read from three places:
  * `_LOCAL_BROKER_URL`  -> what `GET /api/local/status` REPORTS as `url`
  * `_broker_port()`     -> the port the managed broker actually BINDS,
                            parsed from `_LOCAL_BROKER_URL`
  * `_PROVIDERS["lmstudio-local"]["broker_url"]`
                         -> where `lmstudio_proxy` sends SESSION INFERENCE
The endpoint route changes only the third. So a user who set a custom address
would get: the managed broker still binding the OLD port, the card still
REPORTING the old port, and inference alone sent to the NEW one -- where nothing
is listening. That is strictly worse than today's honest-inert control, because
it looks like it worked.

WHAT THESE TESTS PIN. Not the bug -- the INVARIANT. All three owners agree, and
the two lmstudio-local URLs stay distinct. Any future wiring that moves one
owner without the others, or collapses the pair, turns this file red.
"""
import sys
import urllib.parse
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import server as server_module  # noqa: E402


def _port_of(url: str) -> int | None:
    try:
        return urllib.parse.urlsplit(url).port
    except ValueError:
        return None


def test_lmstudio_broker_and_management_are_different_services():
    """The pair the endpoint route would collapse.

    If these are ever equal by default, either the registry changed or someone
    pointed a persisted endpoint at this provider -- and the management plane is
    now aimed at the broker.
    """
    p = server_module._PROVIDERS["lmstudio-local"]
    broker, mgmt = p["broker_url"], p["management_url"]
    assert broker != mgmt, (
        "lmstudio-local's broker_url and management_url collapsed to one address. "
        "The broker (:1235) and LM Studio (:1234) are different services; "
        "_models_path() sends /api/v0/models to the MANAGEMENT url and the broker "
        "does not serve it."
    )
    assert _port_of(broker) != _port_of(mgmt)


def test_all_three_broker_address_owners_agree():
    """The guard S11 actually needs.

    Wire the settings control to the provider registry alone and this goes red:
    the bind port and the reported url would still come from _LOCAL_BROKER_URL.
    """
    module_url = server_module._LOCAL_BROKER_URL
    bind_port = server_module._broker_port()
    provider_url = server_module._PROVIDERS["lmstudio-local"]["broker_url"]

    assert _port_of(module_url) == bind_port, (
        "the managed broker binds a port that _LOCAL_BROKER_URL does not name"
    )
    assert provider_url == module_url, (
        "session inference (lmstudio_proxy reads provider['broker_url']) and the "
        "managed broker's own bind address (_LOCAL_BROKER_URL) have diverged. "
        "Whoever lands S11 must move ALL THREE owners or none."
    )


def test_status_reports_the_address_the_broker_binds():
    """`/api/local/status` is what the Settings card shows as 'In use right now'.

    It must not be able to report an address the broker is not on -- that is the
    S8 defect (a field displaying an address nothing listens on) reappearing on
    the honest side of the card.
    """
    assert _port_of(server_module._LOCAL_BROKER_URL) == server_module._broker_port()


def test_persisted_endpoint_would_collapse_the_pair(monkeypatch):
    """CHARACTERISATION, not an endorsement -- this documents the hazard.

    `apply_persisted_endpoints()` sets management_url AND broker_url from one
    stored value. Run against lmstudio-local it destroys the distinction
    test_lmstudio_broker_and_management_are_different_services protects.

    WHEN S11 LANDS, THIS TEST SHOULD CHANGE. If the endpoint setter grows a
    notion of WHICH url it is setting, update this to assert the management url
    survived. A future reader finding this red has not broken anything -- they
    have done the work.
    """
    original = dict(server_module._PROVIDERS["lmstudio-local"])
    try:
        monkeypatch.setattr(
            server_module, "_load_provider_endpoints",
            lambda: {"lmstudio-local": "http://127.0.0.1:9999"},
        )
        server_module.apply_persisted_endpoints()
        p = server_module._PROVIDERS["lmstudio-local"]
        assert p["broker_url"] == "http://127.0.0.1:9999"
        # THE HAZARD, stated as an assertion so it cannot be overlooked:
        assert p["management_url"] == "http://127.0.0.1:9999", (
            "if this now differs, the endpoint setter learned to distinguish the "
            "two urls -- good; update this test to assert LM Studio's management "
            "url survived."
        )
    finally:
        server_module._PROVIDERS["lmstudio-local"].clear()
        server_module._PROVIDERS["lmstudio-local"].update(original)


def test_the_restore_in_the_previous_test_actually_restored():
    """A fixture that silently fails to clean up would make the whole file lie.

    Ordered after the mutating test on purpose: pytest runs top to bottom in a
    module, so this is the cheapest possible check that the registry is intact
    for every other suite in the run.
    """
    p = server_module._PROVIDERS["lmstudio-local"]
    assert p["broker_url"] != "http://127.0.0.1:9999"
    assert p["broker_url"] != p["management_url"]
