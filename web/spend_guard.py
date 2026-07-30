"""Spend guardrails: the module that decides whether Cockpit refuses work.

Why this module exists
----------------------
``settings.json`` has carried a full ``spend.*`` tree (caps, alert threshold,
block switches, enforcement scope) since the Settings page shipped, and NOTHING
read it. A user could set a $20 cap, press Save, and be enforced by exactly
nothing. For a spend cap that is worse than having no feature at all: the
control invites the unattended overspend it appears to prevent. This module is
the single decision point that closes that gap, and ``server.py`` /
``bridge_manager.py`` are the only callers.

Three refusals are the POINT of this module, not incidental hardening:

1. **The UI interlock is not a security boundary.** ``SpendGuardrails.jsx``
   disables the equivalent-block switch under a subscription, but
   ``settings.json`` is a plain file that a user can edit, that a config export
   can carry between machines, and that can hold ``block.equivalent: true`` left
   over from an API-billing period. The server therefore refuses to enforce an
   equivalent block whenever ``mode == "subscription"``, whatever the flag says
   -- another Claude turn on a monthly plan has zero marginal cost, so stopping
   work there stops free work. A caveat records the refusal.

2. **Never hard-block on a number we made up.** Cost is only as trustworthy as
   the price it was frozen with. If the window's contributing events are
   predominantly not ``price_source == "exact"``, or the price store holds no
   OpenRouter snapshot at all (the poll may never have run), the block is
   DOWNGRADED to an alert: ``enforcement_available`` goes false for that class
   and ``blocking`` stays false. A hard stop computed from fallback rates is
   worse than no stop, because the user cannot tell which they got.

3. **A ``None`` cap never blocks.** ``block.real: true`` with
   ``caps.real_usd: null`` is incoherent rather than invalid -- it is treated as
   no block, with a caveat, instead of raising. A status read must never fail.

Cost classes
------------
* **real** -- money actually billed today. OpenRouter always (billed per token
  regardless of any subscription), plus native Anthropic usage when
  ``mode == "api"``, because on API billing that IS the invoice. Provider
  classification is NOT reinvented here: it comes from
  ``UsageTracker._classify_anthropic_side``, the same function
  ``model_report``/``range_report`` use, so the guard and the reports can never
  disagree about what OpenRouter is.
* **equivalent** -- every API-equivalent dollar in the window, including
  subscription-covered Claude turns. This is the figure Cockpit reports.
* **local** -- ``local_runs`` rows. $0, and counted toward NEITHER class.

Stdlib only. Every DB read is synchronous sqlite; async callers must hop a
thread (``asyncio.to_thread``) -- see ``server.py`` and ``bridge_manager.py``.
"""

from __future__ import annotations

import calendar
import logging
from datetime import datetime, timedelta, timezone

import settings_store

logger = logging.getLogger("cockpit.spend")

MODES = ("subscription", "api")
PERIODS = ("daily", "weekly", "monthly")

STATE_OK = "ok"
STATE_ALERT = "alert"
STATE_OVER = "over"

# Share of a window's contributing events that must be `exact`-priced before a
# hard block computed from that window is considered trustworthy. At or below
# this share the block downgrades to an alert (refusal rule 2).
_EXACT_SHARE_FLOOR = 0.5


# ---------------------------------------------------------------------------
# Lazy singletons
# ---------------------------------------------------------------------------
# usage_tracker and pricing_store both open sqlite files at import time. They
# are imported INSIDE the functions so that importing spend_guard (which
# bridge_manager does) never creates a DB as a side effect -- tests import
# bridge_manager without wanting ~/.claude-cockpit touched.


def _default_tracker():
    from usage_tracker import usage_tracker

    return usage_tracker


def _default_pricing():
    from pricing_store import pricing_store

    return pricing_store


# ---------------------------------------------------------------------------
# Settings access
# ---------------------------------------------------------------------------


def _spend_settings(settings: dict | None = None) -> dict:
    """The effective ``spend`` sub-tree, defaults filled in, never raising.

    ``read_settings`` already deep-merges DEFAULT_SETTINGS, but a hand-edited
    settings.json can put a non-dict at any of these paths, so every nested read
    is defensive: a malformed blob degrades to defaults rather than 500-ing a
    status read or, worse, silently disabling enforcement.
    """
    if settings is None:
        try:
            settings = settings_store.read_settings()
        except Exception:
            logger.error("Failed reading settings for spend guard", exc_info=True)
            settings = {}
    raw = settings.get("spend") if isinstance(settings, dict) else None
    defaults = settings_store.DEFAULT_SETTINGS["spend"]
    if not isinstance(raw, dict):
        raw = {}

    def _sub(key: str) -> dict:
        value = raw.get(key)
        base = dict(defaults[key])
        if isinstance(value, dict):
            base.update({k: v for k, v in value.items() if k in base})
        return base

    mode = raw.get("mode")
    if mode not in MODES:
        mode = defaults["mode"]
    period = raw.get("period")
    if period not in PERIODS:
        period = defaults["period"]

    reset_day = raw.get("monthly_reset_day", defaults["monthly_reset_day"])
    try:
        reset_day = int(reset_day)
    except (TypeError, ValueError):
        reset_day = defaults["monthly_reset_day"]
    reset_day = min(max(reset_day, 1), 28)

    alert = raw.get("alert_at_percent", defaults["alert_at_percent"])
    try:
        alert = float(alert)
    except (TypeError, ValueError):
        alert = defaults["alert_at_percent"]
    alert = min(max(alert, 1.0), 100.0)

    caps = _sub("caps")
    block = _sub("block")
    enforce_on = _sub("enforce_on")

    return {
        "mode": mode,
        "period": period,
        "monthly_reset_day": reset_day,
        "caps": {
            "real_usd": _cap(caps.get("real_usd")),
            "equivalent_usd": _cap(caps.get("equivalent_usd")),
        },
        "alert_at_percent": alert,
        "block": {
            "real": block.get("real") is True,
            "equivalent": block.get("equivalent") is True,
        },
        "enforce_on": {
            "bridges": enforce_on.get("bridges") is not False,
            "new_sessions": enforce_on.get("new_sessions") is True,
        },
    }


def _cap(value) -> float | None:
    """A cap as a positive float, or None for "no cap".

    Anything non-numeric or <= 0 becomes None. Validation already rejects those
    on the write path; this is the read path, which must survive a file edited
    by hand -- and "no cap" is the only safe interpretation of a nonsense cap.
    """
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if number <= 0:
        return None
    return number


def bridges_enforced(settings: dict | None = None) -> bool:
    """True when ``spend.enforce_on.bridges`` is on (the default)."""
    return _spend_settings(settings)["enforce_on"]["bridges"]


def new_sessions_enforced(settings: dict | None = None) -> bool:
    """True when ``spend.enforce_on.new_sessions`` is on (default OFF)."""
    return _spend_settings(settings)["enforce_on"]["new_sessions"]


# ---------------------------------------------------------------------------
# Period math
# ---------------------------------------------------------------------------


def resolve_period(period: str, monthly_reset_day: int, now: datetime) -> dict:
    """``{start, end, label}`` for *period*, as ISO8601 UTC strings.

    * ``daily``   -- the current UTC calendar day, midnight to midnight.
    * ``weekly``  -- the trailing 7 UTC days ending now (a rolling window, not
                     an ISO week: "the last 7 days" is what a spend question
                     actually means).
    * ``monthly`` -- from ``monthly_reset_day`` of this month if that day has
                     already arrived, otherwise the same day of the previous
                     month, through the same day of the following month. A Claude
                     subscription resets on the SIGNUP ANNIVERSARY, not the 1st,
                     which is exactly why the day is configurable. The day is
                     capped at 28 by validation so February can always honour it;
                     the clamp below is belt-and-braces for a hand-edited file.
    """
    now = now.astimezone(timezone.utc) if now.tzinfo else now.replace(tzinfo=timezone.utc)
    day = min(max(int(monthly_reset_day or 1), 1), 28)

    if period == "daily":
        start = now.replace(hour=0, minute=0, second=0, microsecond=0)
        end = start + timedelta(days=1)
        label = f"today ({start.date().isoformat()} UTC)"
    elif period == "weekly":
        end = now
        start = now - timedelta(days=7)
        label = "last 7 days (UTC)"
    else:
        anchor = now.replace(hour=0, minute=0, second=0, microsecond=0)
        if now.day >= day:
            start = anchor.replace(day=day)
        else:
            start = _same_day_previous_month(anchor, day)
        end = _same_day_next_month(start, day)
        label = f"{start.date().isoformat()} → {end.date().isoformat()} (resets day {day})"

    return {"start": start.isoformat(), "end": end.isoformat(), "label": label}


def _same_day_previous_month(reference: datetime, day: int) -> datetime:
    year = reference.year
    month = reference.month - 1
    if month == 0:
        month = 12
        year -= 1
    return reference.replace(
        year=year, month=month, day=min(day, calendar.monthrange(year, month)[1])
    )


def _same_day_next_month(reference: datetime, day: int) -> datetime:
    year = reference.year
    month = reference.month + 1
    if month == 13:
        month = 1
        year += 1
    return reference.replace(
        year=year, month=month, day=min(day, calendar.monthrange(year, month)[1])
    )


# ---------------------------------------------------------------------------
# Window spend, split by cost class
# ---------------------------------------------------------------------------


def _classify(tracker, model: str) -> str:
    """``"openrouter"`` or ``"anthropic"`` for a usage_events model id.

    Delegates to ``UsageTracker._classify_anthropic_side`` -- the SAME function
    ``model_report`` and ``range_report`` use. A second classification scheme
    here would eventually disagree with the reports the user is looking at, and
    a cap that disagrees with the dashboard is unexplainable.
    """
    try:
        provider, _family = tracker._classify_anthropic_side(model or "")
        return provider
    except Exception:
        logger.warning("Provider classification failed for model %r", model, exc_info=True)
        return "anthropic"


def window_spend(period: dict, mode: str, tracker=None) -> dict:
    """Split one window's frozen-at-ingest cost into the two cost classes.

    Returns ``{real, equivalent, real_events, equivalent_events, real_exact,
    equivalent_exact, local_runs, openrouter_events}``.

    Cost is the SUM of each row's ``cost_usd`` -- the value frozen at ingest with
    the rate then in effect. It is never recomputed here, so a vendor price
    change cannot move a cap that already tripped (or un-trip one that did).

    ``local_runs`` rows are read only to be reported as a count: local inference
    is $0 and contributes to NEITHER class.
    """
    tracker = tracker or _default_tracker()
    try:
        api_rows, local_rows, _tool_rows = tracker._window_rows(period["start"], period["end"])
    except Exception:
        logger.error("Failed reading usage rows for spend window", exc_info=True)
        return {
            "real": 0.0, "equivalent": 0.0,
            "real_events": 0, "equivalent_events": 0,
            "real_exact": 0, "equivalent_exact": 0,
            "local_runs": 0, "openrouter_events": 0,
            "unavailable": True,
        }

    real = equivalent = 0.0
    real_events = equivalent_events = 0
    real_exact = equivalent_exact = 0
    openrouter_events = 0

    for row in api_rows:
        cost = row["cost_usd"] or 0.0
        exact = (row["price_source"] or "") == "exact"
        provider = _classify(tracker, row["model"] or "")
        if provider == "openrouter":
            openrouter_events += 1

        # Equivalent is every API-equivalent dollar, subscription-covered or not.
        equivalent += cost
        equivalent_events += 1
        if exact:
            equivalent_exact += 1

        # Real is money billed TODAY: OpenRouter always; Anthropic only when the
        # user is on API billing, where the equivalent figure IS the invoice.
        billed = provider == "openrouter" or mode == "api"
        if billed:
            real += cost
            real_events += 1
            if exact:
                real_exact += 1

    return {
        "real": round(real, 4),
        "equivalent": round(equivalent, 4),
        "real_events": real_events,
        "equivalent_events": equivalent_events,
        "real_exact": real_exact,
        "equivalent_exact": equivalent_exact,
        "local_runs": len(local_rows),
        "openrouter_events": openrouter_events,
        "unavailable": False,
    }


def has_openrouter_snapshot(pricing=None) -> bool:
    """True when the price store holds at least one OpenRouter snapshot.

    Until the daily poll has run, every OpenRouter model prices from the seed
    (or not at all), so any real-spend total is provisional. Refusal rule 2
    keys off this: provisional totals may alert, never hard-block.
    """
    pricing = pricing or _default_pricing()
    try:
        from pricing_store import SOURCE_OPENROUTER

        for row in pricing.latest_prices():
            if row.get("source") == SOURCE_OPENROUTER:
                return True
    except Exception:
        logger.warning("Could not determine OpenRouter snapshot presence", exc_info=True)
        return False
    return False


# ---------------------------------------------------------------------------
# The decision
# ---------------------------------------------------------------------------


def _class_view(spent: float, cap: float | None, alert_at_percent: float) -> dict:
    """``{spent, cap, percent, state}`` for one cost class.

    ``percent`` is None -- not 0, not 100 -- when there is no cap. There is no
    denominator, so any number would be an assertion we cannot make; the UI
    renders a hatched bar for None.
    """
    if cap is None:
        return {"spent": round(spent, 4), "cap": None, "percent": None, "state": STATE_OK}
    percent = round((spent / cap) * 100.0, 2)
    if spent >= cap:
        state = STATE_OVER
    elif percent >= alert_at_percent:
        state = STATE_ALERT
    else:
        state = STATE_OK
    return {"spent": round(spent, 4), "cap": round(cap, 4), "percent": percent, "state": state}


def evaluate(now: datetime | None = None, settings: dict | None = None,
             tracker=None, pricing=None) -> dict:
    """Decide the current spend posture. Never raises.

    Returns::

        {"period": {"start","end","label"}, "mode": "...",
         "real": {"spent","cap","percent","state","enforcement_available"},
         "equivalent": {...},
         "blocking": bool, "reasons": [str],
         "enforcement_available": bool, "caveats": [str]}

    THE STANDING INVARIANT (pinned by a property test): if a class's
    ``enforcement_available`` is False, ``caveats`` ALWAYS contains a line naming
    that class and the reason it cannot enforce -- whether or not the cap has been
    exceeded, and whether or not ``blocking`` is True. The UI paints a "NOT
    ENFORCING" marker off that flag and points the user at the caveats for the
    reason; a false flag with nothing to read is a guardrail visibly not guarding
    with no way to find out why, which is strictly worse than either blocking or
    staying silent.

    ``blocking`` is the only field an enforcement point may act on. It is True
    only when ALL of these hold for at least one class: a cap is set, spend has
    reached it, the block switch for that class is on, the class is blockable in
    the current billing mode, and the window's pricing is trustworthy enough to
    hard-stop on. Any of those failing yields an alert, a caveat, or both --
    never a silent block and never a silent pass.
    """
    now = now or datetime.now(timezone.utc)
    cfg = _spend_settings(settings)
    period = resolve_period(cfg["period"], cfg["monthly_reset_day"], now)
    spend = window_spend(period, cfg["mode"], tracker=tracker)

    caveats: list[str] = []
    reasons: list[str] = []

    if spend.get("unavailable"):
        caveats.append(
            "Usage data could not be read, so this window's spend is unknown. "
            "Nothing is being blocked on an unknown number."
        )

    real = _class_view(spend["real"], cfg["caps"]["real_usd"], cfg["alert_at_percent"])
    equivalent = _class_view(
        spend["equivalent"], cfg["caps"]["equivalent_usd"], cfg["alert_at_percent"]
    )

    or_snapshot = has_openrouter_snapshot(pricing)

    # -- per-class trust in the numbers (refusal rule 2) ---------------------
    real_trusted, real_caveats = _pricing_trust(
        "real", spend["real_events"], spend["real_exact"], or_snapshot, spend.get("unavailable")
    )
    equivalent_trusted, equivalent_caveats = _pricing_trust(
        "equivalent", spend["equivalent_events"], spend["equivalent_exact"],
        # The equivalent class is dominated by native Anthropic turns priced from
        # the checked-in seed table; a missing OpenRouter poll says nothing about
        # its trustworthiness, so that condition is not applied here.
        True, spend.get("unavailable"),
    )

    # -- which blocks are even permitted -----------------------------------
    real_block_wanted = cfg["block"]["real"]
    equivalent_block_wanted = cfg["block"]["equivalent"]

    # REFUSAL 1: the server independently refuses an equivalent block under a
    # subscription. The UI disables the switch, but settings.json is a file.
    equivalent_blockable = True
    if equivalent_block_wanted and cfg["mode"] == "subscription":
        equivalent_blockable = False
        caveats.append(
            "Blocking on API-equivalent spend is refused while the billing mode is "
            "\"subscription\": another Claude turn on a monthly plan costs nothing "
            "extra, so a hard stop there would refuse free work. The cap still "
            "alerts. Switch the mode to \"api\" to make it enforceable."
        )

    # REFUSAL 3: block switch on with no cap is incoherent, not an error.
    if real_block_wanted and real["cap"] is None:
        caveats.append(
            "Real-spend blocking is switched on but no real cap is set, so nothing "
            "can be blocked. Set a cap or turn the switch off."
        )
    if equivalent_block_wanted and equivalent["cap"] is None:
        caveats.append(
            "API-equivalent blocking is switched on but no equivalent cap is set, so "
            "nothing can be blocked. Set a cap or turn the switch off."
        )

    # -- pricing-trust caveats (THE INVARIANT) ------------------------------
    #
    # INVARIANT: if a class's ``enforcement_available`` is False AND that class's
    # block switch is on, ``caveats`` MUST carry a line naming the class and the
    # reason. Independent of whether the cap is currently exceeded, and
    # independent of ``blocking``.
    #
    # The bug this replaces: the trust notes were appended only inside the
    # "a block would have tripped" branches, while enforcement_available was set
    # unconditionally. With spend UNDER the cap, the UI's "NOT ENFORCING" marker
    # therefore appeared pointing at an empty explanation -- a guardrail visibly
    # not guarding with no way for the user to learn why. That is the precise
    # failure the downgrade-instead-of-block rule exists to prevent, so the
    # explanation is now emitted from the same condition that sets the flag.
    #
    # The switch being OFF stays silent on purpose: nothing is configured, so
    # there is nothing to correct and a warning would be noise.
    if real_block_wanted and not real_trusted:
        caveats.extend(real_caveats)
        caveats.append(_unenforceable_caveat("real", real))
    if equivalent_block_wanted and equivalent_blockable and not equivalent_trusted:
        # Under a subscription the interlock above has already explained (in
        # stronger terms) why this class cannot enforce; a second, weaker reason
        # would only dilute it, so the pricing note is skipped in that case.
        caveats.extend(equivalent_caveats)
        caveats.append(_unenforceable_caveat("equivalent", equivalent))

    # -- assemble the blocking decision -----------------------------------
    blocking = False

    real_would_block = real_block_wanted and real["cap"] is not None and real["state"] == STATE_OVER
    if real_would_block and real_trusted:
        blocking = True
        reasons.append(
            f"Real spend ${real['spent']:.2f} has reached the "
            f"${real['cap']:.2f} cap for {period['label']}."
        )

    equivalent_would_block = (
        equivalent_block_wanted
        and equivalent_blockable
        and equivalent["cap"] is not None
        and equivalent["state"] == STATE_OVER
    )
    if equivalent_would_block and equivalent_trusted:
        blocking = True
        reasons.append(
            f"API-equivalent spend ${equivalent['spent']:.2f} has reached the "
            f"${equivalent['cap']:.2f} cap for {period['label']}."
        )

    # Per-class availability means "a block the user CONFIGURED cannot fire". With
    # the switch off there is nothing to enforce, so the flag stays True: the UI
    # paints its "NOT ENFORCING" marker off this field, and a false here with no
    # configured block would be a warning about a setting the user never made --
    # the same pointing-at-nothing defect in a different disguise. Whether the
    # numbers would support a block regardless is reported separately as
    # ``pricing_trusted``, which carries no marker.
    real_available = real_trusted or not real_block_wanted
    equivalent_available = (equivalent_blockable and equivalent_trusted) or not equivalent_block_wanted
    real = {**real, "enforcement_available": real_available, "pricing_trusted": real_trusted}
    equivalent = {
        **equivalent,
        "enforcement_available": equivalent_available,
        "pricing_trusted": equivalent_trusted,
    }

    # Top-level: false when a block the user asked for cannot be honoured.
    enforcement_available = True
    if real_block_wanted and not real_available:
        enforcement_available = False
    if equivalent_block_wanted and not equivalent_available:
        enforcement_available = False

    if spend["local_runs"]:
        caveats.append(
            f"{spend['local_runs']} local model run(s) in this window are $0 and count "
            "toward neither cap."
        )

    return {
        "period": period,
        "mode": cfg["mode"],
        "real": real,
        "equivalent": equivalent,
        "blocking": blocking,
        "reasons": reasons,
        "enforcement_available": enforcement_available,
        "caveats": caveats,
        "enforce_on": dict(cfg["enforce_on"]),
    }


def _unenforceable_caveat(kind: str, view: dict) -> str:
    """The line that closes the invariant: this class cannot hard-stop, and why.

    Two wordings for one fact. When the cap is already exceeded the honest word
    is DOWNGRADED (an enforcement decision was made and softened); when it is not
    yet exceeded the honest statement is that the stop will not fire when the cap
    is eventually reached. Both name the class so the UI's per-class marker has
    something concrete to point at.
    """
    noun = "Real spend" if kind == "real" else "API-equivalent spend"
    word = "real" if kind == "real" else "equivalent"
    cap = view.get("cap")
    if cap is not None and view.get("state") == STATE_OVER:
        return (
            f"{noun} (${view['spent']:.2f}) has passed its ${cap:.2f} cap, but the "
            f"{word} block was DOWNGRADED TO AN ALERT because that figure does not rest "
            "on trustworthy prices. A hard stop computed from fallback rates is worse "
            "than no stop."
        )
    return (
        f"The {word} hard stop is switched on but CANNOT FIRE: {noun.lower()} for this "
        "window does not rest on trustworthy prices, so reaching the cap will raise an "
        "alert instead of blocking. Cockpit will not hard-stop on a number it had to "
        "estimate."
    )


def _pricing_trust(
    label: str, events: int, exact_events: int, openrouter_snapshot: bool, unavailable
) -> tuple[bool, list[str]]:
    """Whether a hard block on *label*'s figure is defensible, plus the why-not.

    Untrustworthy when: the rows could not be read at all; no OpenRouter
    snapshot exists (real class only -- the caller passes True to opt out); or
    ``exact``-priced events are not a majority of the window's contributing
    events.

    Every note names *label* so the caller can attribute it to a class, and is
    emitted whenever the class's block switch is on and this returns False --
    NOT only when a cap has already tripped. A "not enforcing" flag with no
    stated reason is the one outcome this module must never produce.
    """
    notes: list[str] = []
    if unavailable:
        notes.append(f"The window's {label} usage rows could not be read.")
        return False, notes
    if not openrouter_snapshot:
        notes.append(
            "No OpenRouter price snapshot has been recorded yet, so real-spend figures "
            "cannot be trusted for a hard stop: OpenRouter is the main real-money path "
            "and its rates have never been polled, leaving every real total provisional. "
            "The first successful price refresh (the daily pricing poll, or Refresh "
            "prices in Settings) makes this cap enforceable."
        )
        return False, notes
    if events == 0:
        # No events means this class's spend is 0, which cannot exceed a positive
        # cap -- there is no figure to distrust, so the class stays enforceable
        # and silent. Reporting "cannot fire" on a fresh window would attach a
        # warning to a perfectly healthy configuration, and it also guards the
        # division below.
        return True, notes
    if (exact_events / events) <= _EXACT_SHARE_FLOOR:
        notes.append(
            f"Only {exact_events} of {events} {label} events in this window were priced "
            "at ingest with the rate then in effect; the rest were backfilled or "
            "unpriced, so the total is an estimate."
        )
        return False, notes
    return True, notes


# ---------------------------------------------------------------------------
# Enforcement-point helpers
# ---------------------------------------------------------------------------


def check_start(scope: str, now: datetime | None = None) -> dict | None:
    """The evaluate() payload IF *scope* must be refused, else None.

    *scope* is ``"bridges"`` or ``"new_sessions"``; when the matching
    ``enforce_on`` flag is off this returns None without touching the DB, so an
    opted-out user pays nothing. Interactive typing is never a scope here -- it
    is out of scope by design and has no enforcement point.

    Best-effort by contract: any unexpected failure returns None (allow). A
    guardrail that fails closed would make a transient sqlite error look like a
    spend cap, which is a worse outcome than one missed block.
    """
    try:
        cfg = _spend_settings()
        if not cfg["enforce_on"].get(scope, False):
            return None
        result = evaluate(now=now)
        return result if result.get("blocking") else None
    except Exception:
        logger.error("Spend guard check failed for scope=%s -- allowing", scope, exc_info=True)
        return None


def block_reason(scope: str, now: datetime | None = None) -> str | None:
    """A one-line reason string if *scope* is blocked, else None."""
    result = check_start(scope, now=now)
    if result is None:
        return None
    reasons = result.get("reasons") or []
    return "; ".join(str(r) for r in reasons) or "spend cap reached"
