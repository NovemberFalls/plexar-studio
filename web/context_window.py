"""Model → context-window resolution, and prompt-size → percentage maths.

WHY THIS MODULE EXISTS
----------------------
Cockpit's context ring (Inspector's 38px ring, TerminalPane's header ring) used
to be fed by a regex scrape of the terminal text
(``context\\D{0,30}?(\\d{1,3})\\s*%``). Claude Code does not routinely print that
string, so ``context_percent`` was ``None`` as its permanent steady state and
the ring never displayed a real number.

The data was already stored: ``usage_events`` records ``input_tokens`` and
``cache_read_tokens`` per assistant turn, and their SUM is the prompt actually
sent to the model on that turn — i.e. the context occupied. The only missing
term was the denominator, which is what this module supplies.

PUBLIC INTERFACE (the contract)
-------------------------------
``resolve_context_window(model, *, provider="anthropic") -> int | None``
    Total context window in tokens for a session's CONFIGURED model string, or
    ``None`` when it is genuinely unknown. NEVER guesses, NEVER falls back to a
    default window — a wrong denominator yields a confidently wrong percentage,
    which is worse than no ring at all.

``context_percent(prompt_tokens, window) -> tuple[int, float] | None``
    ``(clamped_int_percent, raw_float_percent)``; ``None`` when either input is
    unusable. The raw value is returned so the caller can log a >100% reading —
    that indicates a wrong window, not a real machine state.

``prompt_tokens_from_event(input_tokens, cache_read_tokens) -> int``
    The one place the "prompt size = input + cache_read" definition lives.

``set_local_model_windows(provider_id, models) -> None``
``clear_local_model_windows(provider_id=None) -> None``
    Registry for local providers, which publish their own window via
    ``GET /api/local/{id}/models`` (``max_context_length`` /
    ``loaded_context_length``). Whoever already holds that payload pushes it in
    here; the resolver then answers for local models WITHOUT any network call.

THIS MODULE DOES NOT:
  - make any network call (see the registry above — resolution must stay safe to
    call from the PTY/state-ticker path);
  - read the database (the caller supplies ``prompt_tokens``);
  - touch pricing, cost, or spend logic;
  - guess a window for an unrecognised model, or apply a default;
  - decide the ring's colour or formatting (frontend concern).

THREAD SAFETY
  ``_LOCAL_WINDOWS`` is the only mutable module state and is guarded by
  ``_LOCAL_LOCK`` (a ``threading.Lock``) on every read and write, because it is
  written from whichever thread polls ``/models`` and read from the state-ticker
  path. Everything else here is pure.
"""

from __future__ import annotations

import logging
import re
import threading
from typing import Any, Iterable, Mapping, Optional

logger = logging.getLogger("cockpit.context")

__all__ = [
    "ANTHROPIC_LONG_CONTEXT_TOKENS",
    "ANTHROPIC_STANDARD_CONTEXT_TOKENS",
    "clear_local_model_windows",
    "context_percent",
    "prompt_tokens_from_event",
    "resolve_context_window",
    "set_local_model_windows",
]


# ---------------------------------------------------------------------------
# The window table, with the source of each number.
# ---------------------------------------------------------------------------
# Anthropic ships each Opus/Sonnet generation in two context sizes. This repo
# encodes the long-context variant with a "[1m]" id suffix — see
# frontend/src/modelCatalog.js (`buildModelGroups` synthesizes `${model.id}[1m]`
# labelled "(1M)") and pty_manager._ANTHROPIC_MODEL_RE, which explicitly allows
# the optional "(?:\[1m\])?" tail. So the suffix IS the discriminator, and it is
# only present on the session's configured model string.
#
# 1,000,000 — the "(1M)" in the picker label is the number: the long-context
#   variants are one million tokens. Source: this repo's own naming convention
#   (modelCatalog.js labels them "(1M)"; the id suffix is literally "1m"), which
#   mirrors Anthropic's 1M-token long-context tier.
ANTHROPIC_LONG_CONTEXT_TOKENS = 1_000_000
# 200,000 — the standard Claude context window across the Opus / Sonnet / Haiku
#   families; it is the size the "(1M)" variants exist to extend. Source: the
#   same convention — a model is offered as a 1M variant precisely because its
#   base id is NOT 1M, and 200k is the standard tier for these families.
ANTHROPIC_STANDARD_CONTEXT_TOKENS = 200_000

# Families whose standard window is 200k AND which the repo offers a [1m]
# variant of (modelCatalog.supports1M matches /opus|sonnet/i). Haiku is included
# for the standard window only — the catalog never synthesizes a 1M Haiku, but a
# Haiku session still has a 200k window worth reporting.
_STANDARD_200K_FAMILIES = ("opus", "sonnet", "haiku")

# Families that are 1M at their BASE id — there is no smaller variant to extend,
# so they never carry a "[1m]" suffix and the suffix logic below does not apply.
# Fable and Mythos ship a single 1,000,000-token window (Anthropic's published
# figure for both; Mythos 5 is the same model surface as Fable 5). Until this was
# added they resolved to None and the pane rendered "not reported" for a live
# session whose window is in fact known — which is the same class of dishonesty
# as inventing one, in the other direction.
_LONG_CONTEXT_ONLY_FAMILIES = ("fable", "mythos")

# Deliberately absent, and therefore resolving to None:
#   - OpenRouter slugs (deepseek/*, qwen/*): per-model windows are not published
#     anywhere in this repo; OpenRouter's /models payload has them, but nothing
#     stores them yet. None until it does.

# "[1m]" long-context suffix, matched case-insensitively on the configured id.
_LONG_CONTEXT_SUFFIX_RE = re.compile(r"\[1m\]$", re.IGNORECASE)


# ---------------------------------------------------------------------------
# Local-provider window registry
# ---------------------------------------------------------------------------
# provider_id -> { model_id: {"max": int|None, "loaded": int|None} }
_LOCAL_WINDOWS: dict[str, dict[str, dict[str, Optional[int]]]] = {}
_LOCAL_LOCK = threading.Lock()


def _coerce_positive_int(value: Any) -> Optional[int]:
    """Return ``value`` as a positive int, or ``None``.

    A 0, a negative, a non-numeric, or a bool is not a context window. Rejecting
    them here is what keeps a bogus upstream field from becoming a denominator.
    """
    if isinstance(value, bool) or value is None:
        return None
    try:
        number = int(value)
    except (TypeError, ValueError):
        return None
    return number if number > 0 else None


def set_local_model_windows(provider_id: str, models: Iterable[Mapping[str, Any]]) -> None:
    """Record the windows a local provider publishes for its models.

    ``models`` is the ``models`` array from ``GET /api/local/{id}/models``: each
    entry needs ``id`` plus optionally ``max_context_length`` and
    ``loaded_context_length``. Entries with no usable window are stored as
    ``None`` rather than dropped, so a model that stops reporting a window stops
    resolving (instead of resolving stale).

    Replaces the whole per-provider map — the model list is expected to change
    shape as models load and unload, so merging would resurrect dead entries.
    """
    if not provider_id:
        return
    snapshot: dict[str, dict[str, Optional[int]]] = {}
    for entry in models or ():
        if not isinstance(entry, Mapping):
            continue
        model_id = entry.get("id")
        if not isinstance(model_id, str) or not model_id:
            continue
        snapshot[model_id] = {
            "max": _coerce_positive_int(entry.get("max_context_length")),
            "loaded": _coerce_positive_int(entry.get("loaded_context_length")),
        }
    with _LOCAL_LOCK:
        _LOCAL_WINDOWS[provider_id] = snapshot


def clear_local_model_windows(provider_id: Optional[str] = None) -> None:
    """Forget one provider's windows, or all of them when ``provider_id`` is None."""
    with _LOCAL_LOCK:
        if provider_id is None:
            _LOCAL_WINDOWS.clear()
        else:
            _LOCAL_WINDOWS.pop(provider_id, None)


def _local_window(model: str) -> Optional[int]:
    """Window for a local model id, searching every registered provider.

    ``loaded_context_length`` WINS over ``max_context_length``: the loaded value
    is the window the running instance actually has, which is what the current
    prompt is being measured against. ``max`` is only the ceiling the weights
    permit, and using it while a model is loaded at a smaller window understates
    the fill — reporting 25% when the session is at 100% and about to fail.
    """
    with _LOCAL_LOCK:
        providers = {pid: dict(models) for pid, models in _LOCAL_WINDOWS.items()}
    for models in providers.values():
        entry = models.get(model)
        if entry is None:
            continue
        return entry.get("loaded") or entry.get("max")
    return None


def resolve_context_window(model: str, *, provider: str = "anthropic") -> Optional[int]:
    """Total context window in tokens for a session's CONFIGURED model string.

    IMPORTANT — key this off ``TerminalSession.model`` (what was handed to
    ``claude --model`` / ``ANTHROPIC_MODEL``), NOT off the model id in the JSONL.
    The JSONL reports ``claude-opus-5`` even for a session launched as
    ``claude-opus-5[1m]``: the transcript does not encode the variant. Resolving
    from the JSONL id would divide a 552k-token 1M prompt by 200k and render
    276% — a confident, alarming, wrong number.

    Returns ``None`` for an unrecognised model. That is the intended outcome, not
    a failure: the frontend renders an em dash plus "not reported", which is the
    honest reading when the denominator is genuinely unknown.
    """
    if not model or not isinstance(model, str):
        return None
    name = model.strip()
    if not name:
        return None

    if provider == "local":
        # Local providers publish their own window; only the registry can answer,
        # and it stays None until someone pushes a /models payload in. Resolution
        # must never make a network call — it runs on the state-ticker path.
        return _local_window(name)

    if provider == "openrouter":
        # No per-slug windows are stored anywhere in this repo yet.
        return None

    lowered = name.lower()
    long_context = bool(_LONG_CONTEXT_SUFFIX_RE.search(lowered))
    base = _LONG_CONTEXT_SUFFIX_RE.sub("", lowered)

    # The bare aliases the CLI accepts ("sonnet", "opus", "haiku") name the
    # standard-window variant; the picker offers the 1M tier only as an explicit
    # "[1m]" id, so an alias with the suffix is still resolvable.
    # Checked BEFORE the 200k families: these are 1M at the base id, so the
    # suffix is not the discriminator for them and must not gate the answer.
    if any(family in base for family in _LONG_CONTEXT_ONLY_FAMILIES):
        return ANTHROPIC_LONG_CONTEXT_TOKENS

    if any(family in base for family in _STANDARD_200K_FAMILIES):
        return ANTHROPIC_LONG_CONTEXT_TOKENS if long_context else ANTHROPIC_STANDARD_CONTEXT_TOKENS

    # Recognised-family check failed. Do NOT fall back to a default window.
    logger.debug("No context window known for model %r (provider=%s)", model, provider)
    return None


def prompt_tokens_from_event(
    input_tokens: Optional[int], cache_read_tokens: Optional[int]
) -> int:
    """Prompt size (context occupied) for ONE assistant turn.

    ``input_tokens + cache_read_tokens``: a cached prefix is still part of the
    prompt sent to the model, it is merely billed differently. Ignoring the cache
    read is why a 552,884-token prompt looks like 2 tokens on the owner's DB.

    Note this is per-turn and must be read from the LATEST turn only. Summing
    across turns measures cumulative traffic, not occupancy, and climbs past
    100% forever.
    """
    return max(0, int(input_tokens or 0)) + max(0, int(cache_read_tokens or 0))


def context_percent(
    prompt_tokens: Optional[int], window: Optional[int]
) -> Optional[tuple[int, float]]:
    """``(display_percent, raw_percent)`` for a prompt size against a window.

    ``display_percent`` is an int clamped to 0..100 (the ring cannot draw more).
    ``raw_percent`` is unclamped, so the caller can log a >100% reading — which
    means the WINDOW is wrong (e.g. a 1M session resolved as 200k), not that the
    session is genuinely over-full.

    Returns ``None`` when the window is unknown/unusable or ``prompt_tokens`` is
    None — never 0%, which would claim an empty context we cannot vouch for.
    A prompt of exactly 0 tokens DOES resolve, to ``(0, 0.0)``: that is a real
    measurement of an empty context, not a missing one.
    """
    if prompt_tokens is None:
        return None
    usable_window = _coerce_positive_int(window)
    if usable_window is None:
        return None
    try:
        tokens = int(prompt_tokens)
    except (TypeError, ValueError):
        return None
    if tokens < 0:
        return None
    raw = (tokens / usable_window) * 100.0
    display = int(round(raw))
    if display < 0:
        display = 0
    elif display > 100:
        display = 100
    return display, raw
