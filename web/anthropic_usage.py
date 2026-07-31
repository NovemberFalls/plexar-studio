"""Anthropic subscription usage limits (the 5-hour / weekly bars from `/status`).

Cockpit shows the SAME numbers the `claude` CLI shows under `/status` ▸ Usage.
They are real, server-reported utilization — not an estimate derived from
locally-tracked tokens. That distinction matters: this module must never
manufacture a percentage. If the real one cannot be fetched it reports
``available: false`` with a reason, and the UI renders nothing rather than a
plausible-looking guess. (Same stance as ``pricing_store``: a number we made up
is worse than no number.)

Where the data comes from
-------------------------
The CLI authenticates with an OAuth token it stores in
``~/.claude/.credentials.json`` and reads limits from
``GET https://api.anthropic.com/api/oauth/usage``. Cockpit runs on the same
machine as that CLI, so it reads the same file and calls the same endpoint.
This is deliberately NOT derived from session JSONL — the JSONL carries token
counts only, no quota information at all.

Two hard rules
--------------
1. **The token never reaches the browser.** Same stance as the local-provider
   registry: the server holds the credential, the client gets only derived
   numbers. ``/api/anthropic/usage`` returns percentages and reset times.

2. **Never refresh the token.** The credentials file holds a refresh token that
   belongs to the CLI. Refreshing rotates it, which would invalidate the copy
   the CLI is holding and log the user out of their own terminal. On a 401 this
   module reports "expired" and tells the user to run any `claude` command,
   letting the CLI refresh through its own flow.
"""

from __future__ import annotations

import json
import logging
import os
import pathlib
import time
from typing import Any, Optional

import httpx

logger = logging.getLogger("cockpit.anthropic")

# The endpoint the CLI itself uses for the /status ▸ Usage panel.
_USAGE_URL = "https://api.anthropic.com/api/oauth/usage"

# OAuth beta header the CLI sends; the endpoint rejects the token without it.
_OAUTH_BETA = "oauth-2025-04-20"

_HTTP_TIMEOUT = httpx.Timeout(connect=5.0, read=10.0, write=5.0, pool=10.0)

# Cache TTL. Utilization moves slowly and this is a remote authenticated call
# on the user's own quota, so polling it hard would be rude and pointless.
_CACHE_TTL = 300.0

# How long a FAILURE is cached. Failures were originally not cached at all, so a
# transient blip could not pin the panel to "unavailable" for a whole minute.
# That reasoning is still right for one-off errors, but it made rate-limiting
# self-perpetuating: every poll re-hit the API, which is what earned the 429 in
# the first place. A short failure cache keeps the transient-blip property
# (30s, not 5min) while removing the hammering.
_FAILURE_CACHE_TTL = 30.0

# Backoff after a 429. The upstream endpoint is built for a human running
# /status occasionally, not for a poller. When it says slow down, slow down --
# and honour Retry-After when it sends one.
_RATE_LIMIT_BACKOFF = 900.0

# Env override, mainly for tests and non-default CLI installs.
_CREDENTIALS_ENV = "COCKPIT_CLAUDE_CREDENTIALS"

# Human labels for the limit kinds the endpoint reports. Unknown kinds are
# passed through with a derived label rather than dropped — a new limit class
# appearing upstream should show up, not silently vanish.
_KIND_LABELS = {
    "session": "Current session",
    "weekly_all": "Current week (all models)",
    "weekly_scoped": "Current week (scoped)",
    "weekly_opus": "Current week (Opus)",
    "weekly_sonnet": "Current week (Sonnet)",
    "weekly_fable": "Current week (Fable)",
}

_cache: dict[str, Any] = {"at": 0.0, "payload": None, "ttl": _CACHE_TTL}

# Monotonic time before which no request may be made at all, set by a 429.
# Enforced even against force=True: a manual refresh must not be a way to keep
# hammering an endpoint that has explicitly asked us to stop.
_blocked_until: float = 0.0


def _credentials_path() -> pathlib.Path:
    override = os.getenv(_CREDENTIALS_ENV)
    if override:
        return pathlib.Path(override)
    return pathlib.Path.home() / ".claude" / ".credentials.json"


def read_access_token() -> Optional[str]:
    """Return the CLI's Claude OAuth access token, or None if unavailable.

    Never logs the token. A missing or malformed file is an expected state
    (the user may be on API-key auth, or may never have logged in), so it is
    reported as None rather than raised.
    """
    path = _credentials_path()
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
    except FileNotFoundError:
        logger.debug("No Claude credentials file at %s", path)
        return None
    except (OSError, json.JSONDecodeError):
        logger.warning("Could not read Claude credentials at %s", path, exc_info=True)
        return None

    oauth = data.get("claudeAiOauth")
    if not isinstance(oauth, dict):
        return None
    token = oauth.get("accessToken")
    return token if isinstance(token, str) and token else None


def _unavailable(reason: str, detail: str) -> dict:
    return {
        "available": False,
        "reason": reason,
        "detail": detail,
        "limits": [],
        "fetched_at": None,
    }


def _retry_after_seconds(resp) -> Optional[float]:
    """Seconds from a Retry-After header, if it carries a usable delta."""
    raw = resp.headers.get("retry-after")
    if not raw:
        return None
    try:
        # Only the delta-seconds form is handled; an HTTP-date is rare here and
        # falling back to the fixed backoff is safer than mis-parsing one.
        return max(0.0, float(raw.strip()))
    except (TypeError, ValueError):
        return None


def _cache_failure(reason: str, detail: str) -> dict:
    """Return an unavailable payload AND cache it briefly.

    Caching failures stops a persistent error (an expired login, a down
    network) from producing one upstream request per poll forever.
    """
    payload = _unavailable(reason, detail)
    _cache["at"] = time.monotonic()
    _cache["payload"] = payload
    _cache["ttl"] = _FAILURE_CACHE_TTL
    return payload


def _label_for(kind: str) -> str:
    if kind in _KIND_LABELS:
        return _KIND_LABELS[kind]
    # e.g. "weekly_cowork" -> "Current week (Cowork)"
    if kind.startswith("weekly_"):
        return f"Current week ({kind[len('weekly_'):].replace('_', ' ').title()})"
    return kind.replace("_", " ").capitalize()


def _normalize(raw: dict) -> dict:
    """Reduce the upstream payload to what the UI renders.

    Only limits that upstream marks with a usable percent are kept. A limit
    whose ``percent`` is None is NOT coerced to 0 — "not reported" and "zero
    used" are different claims, and rendering an empty bar for the former
    would assert something we were not told.
    """
    limits: list[dict] = []
    for entry in raw.get("limits") or []:
        if not isinstance(entry, dict):
            continue
        percent = entry.get("percent")
        if not isinstance(percent, (int, float)):
            continue
        kind = str(entry.get("kind") or "unknown")
        limits.append(
            {
                "kind": kind,
                "label": _label_for(kind),
                "group": entry.get("group"),
                "percent": float(percent),
                "severity": entry.get("severity") or "normal",
                "resets_at": entry.get("resets_at"),
                "is_active": bool(entry.get("is_active")),
            }
        )

    # Stable, meaningful order: session first, then weekly, then anything new.
    group_rank = {"session": 0, "weekly": 1}
    limits.sort(key=lambda e: (group_rank.get(e.get("group"), 2), e["kind"]))

    extra = raw.get("extra_usage")
    extra_usage = None
    if isinstance(extra, dict) and extra.get("is_enabled"):
        extra_usage = {
            "utilization": extra.get("utilization"),
            "monthly_limit": extra.get("monthly_limit"),
            "used_credits": extra.get("used_credits"),
            "currency": extra.get("currency"),
            "spend_limit_reached": bool(extra.get("spend_limit_reached")),
        }

    return {
        "available": True,
        "reason": None,
        "detail": None,
        "limits": limits,
        "extra_usage": extra_usage,
        "fetched_at": time.time(),
    }


async def fetch_usage(force: bool = False) -> dict:
    """Fetch (and cache) the account's real utilization limits.

    Always returns a dict; never raises. ``available`` is False with a
    machine-readable ``reason`` whenever the real numbers could not be read:

        no_credentials  — no OAuth token on this machine (API-key auth, or
                          never logged in). Not an error.
        expired         — token rejected. The CLI must refresh it; see the
                          module docstring for why Cockpit will not.
        unreachable     — network/DNS/timeout.
        bad_response    — 200 with a payload that is not usage-shaped.
    """
    global _blocked_until

    now = time.monotonic()
    if not force and _cache["payload"] is not None and (now - _cache["at"]) < _cache["ttl"]:
        return _cache["payload"]

    # A 429 backoff outranks force= — see _blocked_until.
    if now < _blocked_until:
        if _cache["payload"] is not None:
            return _cache["payload"]
        return _unavailable(
            "rate_limited",
            "Anthropic is rate-limiting usage checks. Retrying shortly.",
        )

    token = read_access_token()
    if not token:
        # Not cached: if the user logs in, the next call should pick it up.
        return _unavailable(
            "no_credentials",
            "No Claude subscription login found on this machine.",
        )

    try:
        async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT) as client:
            resp = await client.get(
                _USAGE_URL,
                headers={
                    "Authorization": f"Bearer {token}",
                    "anthropic-beta": _OAUTH_BETA,
                    "Accept": "application/json",
                },
            )
    except httpx.HTTPError as exc:
        logger.warning("Anthropic usage fetch failed: %s", exc)
        return _cache_failure("unreachable", "Could not reach the Anthropic usage API.")

    if resp.status_code in (401, 403):
        # Deliberately not refreshing — see module docstring.
        return _cache_failure(
            "expired",
            "Claude login has expired. Run any `claude` command to refresh it.",
        )

    if resp.status_code == 429:
        retry_after = _retry_after_seconds(resp) or _RATE_LIMIT_BACKOFF
        _blocked_until = time.monotonic() + retry_after
        logger.warning(
            "Anthropic usage rate-limited (429) — backing off %.0fs", retry_after
        )
        # Keep showing the last good reading rather than replacing real numbers
        # with an error: being throttled says nothing about the user's quota.
        if _cache["payload"] is not None:
            return _cache["payload"]
        return _unavailable(
            "rate_limited",
            "Anthropic is rate-limiting usage checks. Retrying shortly.",
        )

    if resp.status_code >= 400:
        logger.warning("Anthropic usage returned HTTP %s", resp.status_code)
        return _cache_failure("bad_response", f"Usage API returned HTTP {resp.status_code}.")

    try:
        raw = resp.json()
    except ValueError:
        return _cache_failure("bad_response", "Usage API returned a non-JSON body.")

    if not isinstance(raw, dict) or "limits" not in raw:
        return _cache_failure("bad_response", "Usage API response was not usage-shaped.")

    payload = _normalize(raw)
    _cache["at"] = time.monotonic()
    _cache["payload"] = payload
    _cache["ttl"] = _CACHE_TTL
    return payload


def reset_cache() -> None:
    """Drop the cached payload and any rate-limit backoff (tests / refresh)."""
    global _blocked_until
    _cache["at"] = 0.0
    _cache["payload"] = None
    _cache["ttl"] = _CACHE_TTL
    _blocked_until = 0.0
