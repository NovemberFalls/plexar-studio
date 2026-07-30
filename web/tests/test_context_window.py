"""Tests for the context ring: window resolution, percentage maths, and the
pty_manager wiring that replaced the PTY-text scrape as the primary source.

The bug under test: `context_percent` was derived ONLY by scraping the terminal
for "context ... NN%", which Claude Code does not routinely print, so the ring's
steady state was permanently None. These tests pin the derived path (latest
usage_events turn / model context window), the scrape's precedence over it, and
— most importantly — that an unknown model yields None instead of a guess.
"""

import json
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import context_window
from context_window import (
    ANTHROPIC_LONG_CONTEXT_TOKENS,
    ANTHROPIC_STANDARD_CONTEXT_TOKENS,
    context_percent,
    prompt_tokens_from_event,
    resolve_context_window,
    set_local_model_windows,
)
from usage_tracker import UsageTracker


@pytest.fixture(autouse=True)
def _clean_local_registry():
    context_window.clear_local_model_windows()
    yield
    context_window.clear_local_model_windows()


@pytest.fixture()
def tracker(tmp_path):
    t = UsageTracker(db_path=tmp_path / "usage.sqlite3")
    yield t
    t.close()


def _assistant_line(uuid, *, model="claude-opus-5", input_tokens=0, cache_read=0,
                    ts="2026-07-30T10:00:00Z"):
    return json.dumps({
        "type": "assistant",
        "uuid": uuid,
        "timestamp": ts,
        "message": {
            "model": model,
            "usage": {
                "input_tokens": input_tokens,
                "output_tokens": 10,
                "cache_creation_input_tokens": 0,
                "cache_read_input_tokens": cache_read,
            },
        },
    })


def _write_jsonl(tmp_path, lines, name="conv.jsonl"):
    path = tmp_path / name
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return str(path)


# -- window resolution ------------------------------------------------------


@pytest.mark.parametrize("model", ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5-20251001",
                                   "opus", "sonnet", "haiku"])
def test_standard_variants_are_200k(model):
    assert resolve_context_window(model) == ANTHROPIC_STANDARD_CONTEXT_TOKENS


@pytest.mark.parametrize("model", ["claude-opus-5[1m]", "claude-opus-4-8[1m]",
                                   "claude-sonnet-5[1m]", "claude-sonnet-4-6[1m]"])
def test_long_context_variants_are_1m(model):
    assert resolve_context_window(model) == ANTHROPIC_LONG_CONTEXT_TOKENS


def test_the_1m_ambiguity_same_jsonl_model_id_two_windows():
    """THE TRAP. The JSONL reports "claude-opus-5" for BOTH variants — the
    transcript does not encode the 1M tier. Only the session's configured model
    string carries "[1m]", so resolving from the JSONL id would divide the
    owner's real 552,884-token prompt by 200k and render 276%.
    """
    prompt = 552_884  # owner's live DB: input_tokens=2 + cache_read=552,882

    jsonl_id = "claude-opus-5"                # what the transcript says
    configured_1m = "claude-opus-5[1m]"       # what the session was launched as

    wrong = context_percent(prompt, resolve_context_window(jsonl_id))
    right = context_percent(prompt, resolve_context_window(configured_1m))

    assert wrong[1] > 100.0 and wrong[0] == 100      # what the naive path produces
    assert right[0] == 55 and right[1] == pytest.approx(55.2884)


@pytest.mark.parametrize("model", [
    "brand-new-model-9",
    "claude-fable-5",           # priced in this repo, but no window is published
    "claude-mythos",
    "",
    "   ",
    None,
])
def test_unknown_model_yields_none_never_a_default(model):
    assert resolve_context_window(model) is None


def test_openrouter_slug_yields_none():
    assert resolve_context_window("qwen/qwen3-coder-next", provider="openrouter") is None
    # And is not accidentally rescued by a family substring match.
    assert resolve_context_window("anthropic/claude-opus-5", provider="openrouter") is None


# -- local providers --------------------------------------------------------


def test_local_max_context_length_is_honoured():
    set_local_model_windows("lmstudio-local", [
        {"id": "qwen3-coder-30b", "max_context_length": 262144, "loaded_context_length": None},
    ])
    assert resolve_context_window("qwen3-coder-30b", provider="local") == 262144


def test_local_loaded_context_length_wins_over_max():
    """`loaded` is the window the running instance actually has. Using `max`
    while a smaller window is loaded understates the fill — reporting 25% for a
    session that is at 100% and about to fail.
    """
    set_local_model_windows("lmstudio-local", [
        {"id": "qwen3-coder-30b", "max_context_length": 262144, "loaded_context_length": 49152},
    ])
    assert resolve_context_window("qwen3-coder-30b", provider="local") == 49152


def test_local_model_with_no_published_window_yields_none():
    set_local_model_windows("vllm-local", [{"id": "mystery", "max_context_length": None}])
    assert resolve_context_window("mystery", provider="local") is None
    # Unregistered model, and a provider that never reported at all.
    assert resolve_context_window("never-seen", provider="local") is None


def test_local_registry_replaces_rather_than_merges():
    set_local_model_windows("p", [{"id": "a", "max_context_length": 8192}])
    set_local_model_windows("p", [{"id": "b", "max_context_length": 4096}])
    assert resolve_context_window("a", provider="local") is None
    assert resolve_context_window("b", provider="local") == 4096


@pytest.mark.parametrize("bad", [0, -1, "nope", True, None])
def test_local_rejects_non_positive_windows(bad):
    set_local_model_windows("p", [{"id": "m", "max_context_length": bad}])
    assert resolve_context_window("m", provider="local") is None


# -- percentage maths -------------------------------------------------------


def test_prompt_size_is_input_plus_cache_read():
    assert prompt_tokens_from_event(2, 552_882) == 552_884
    assert prompt_tokens_from_event(None, None) == 0


def test_percent_maths():
    assert context_percent(100_000, 200_000) == (50, pytest.approx(50.0))
    assert context_percent(0, 200_000) == (0, pytest.approx(0.0))


def test_percent_is_none_when_window_unknown():
    assert context_percent(100_000, None) is None
    assert context_percent(100_000, 0) is None
    assert context_percent(None, 200_000) is None


def test_over_100_is_clamped_for_display_but_raw_is_flagged():
    display, raw = context_percent(552_884, ANTHROPIC_STANDARD_CONTEXT_TOKENS)
    assert display == 100                      # the ring cannot draw more
    assert raw == pytest.approx(276.442)       # caller logs this: wrong window


# -- latest-turn query ------------------------------------------------------


def test_latest_turn_is_the_latest_not_a_sum(tracker, tmp_path):
    path = _write_jsonl(tmp_path, [
        _assistant_line("u1", input_tokens=10, cache_read=90_000, ts="2026-07-30T10:00:00Z"),
        _assistant_line("u2", input_tokens=20, cache_read=120_000, ts="2026-07-30T11:00:00Z"),
        _assistant_line("u3", input_tokens=2, cache_read=50_000, ts="2026-07-30T12:00:00Z"),
    ])
    tracker.ingest_jsonl("term-1", path)

    turn = tracker.latest_turn("term-1")
    assert turn["input_tokens"] == 2 and turn["cache_read_tokens"] == 50_000

    prompt = prompt_tokens_from_event(turn["input_tokens"], turn["cache_read_tokens"])
    assert prompt == 50_002
    # The sum across turns would be 260,032 -> 130% of a 200k window, i.e.
    # meaningless. Context is occupancy, not cumulative traffic.
    assert context_percent(prompt, 200_000)[0] == 25


def test_latest_turn_is_none_with_no_events(tracker):
    assert tracker.latest_turn("nobody") is None


# -- pty_manager wiring -----------------------------------------------------


class _FakePty:
    def isalive(self):
        return True


def _session(model="claude-opus-5[1m]", provider="anthropic", tid="term-1"):
    from pty_manager import TerminalSession
    return TerminalSession(
        id=tid, name="s", pty=_FakePty(), created_at="2026-07-30T00:00:00Z",
        model=model, provider=provider,
    )


@pytest.fixture()
def manager(tracker, monkeypatch):
    """A PtyManager with no sessions, wired to a temp usage DB.

    refresh_derived_context imports the usage_tracker singleton lazily, so the
    singleton's module attribute is what has to be swapped.
    """
    import pty_manager as pm
    import usage_tracker as ut
    monkeypatch.setattr(ut, "usage_tracker", tracker)
    m = pm.PtyManager()
    return m


def test_derived_percent_lands_on_the_tracker(manager, tracker, tmp_path):
    session = _session(model="claude-opus-5[1m]")
    manager.sessions[session.id] = session
    tracker.ingest_jsonl(session.id, _write_jsonl(tmp_path, [
        _assistant_line("u1", input_tokens=2, cache_read=552_882),
    ]))

    manager.refresh_derived_context()

    assert session.tracker.derived_context_percent == 55
    assert session.tracker.context_percent == 55


def test_derived_percent_uses_configured_model_not_jsonl_model(manager, tracker, tmp_path):
    """Same JSONL (model id "claude-opus-5"), two sessions — one launched as the
    1M variant, one standard. They must NOT resolve to the same percentage.
    """
    long_ctx = _session(model="claude-opus-5[1m]", tid="term-1m")
    standard = _session(model="claude-opus-5", tid="term-std")
    manager.sessions[long_ctx.id] = long_ctx
    manager.sessions[standard.id] = standard
    for tid in (long_ctx.id, standard.id):
        tracker.ingest_jsonl(tid, _write_jsonl(tmp_path, [
            _assistant_line(f"u-{tid}", model="claude-opus-5", input_tokens=2,
                            cache_read=552_882),
        ], name=f"{tid}.jsonl"))

    manager.refresh_derived_context()

    assert long_ctx.tracker.derived_context_percent == 55
    assert standard.tracker.derived_context_percent == 100  # clamped, flagged in the log


def test_unknown_model_leaves_context_percent_none(manager, tracker, tmp_path):
    session = _session(model="some-unreleased-model")
    manager.sessions[session.id] = session
    tracker.ingest_jsonl(session.id, _write_jsonl(tmp_path, [
        _assistant_line("u1", input_tokens=2, cache_read=100_000),
    ]))

    manager.refresh_derived_context()

    assert session.tracker.derived_context_percent is None
    assert session.tracker.context_percent is None


def test_zero_turns_yields_none_not_zero(manager):
    """Matches Inspector.jsx's three states: it derives "true 0% / no turns yet"
    from the usage payload's `last_event_ts`, and reads a null context_percent as
    "not reported". A 0 from the backend would be read as a MEASURED zero.
    """
    session = _session(model="claude-opus-5")
    manager.sessions[session.id] = session

    manager.refresh_derived_context()

    assert session.tracker.context_percent is None


def test_scraped_percentage_wins_over_derived(manager, tracker, tmp_path):
    session = _session(model="claude-opus-5[1m]")
    manager.sessions[session.id] = session
    tracker.ingest_jsonl(session.id, _write_jsonl(tmp_path, [
        _assistant_line("u1", input_tokens=2, cache_read=552_882),
    ]))
    manager.refresh_derived_context()
    assert session.tracker.context_percent == 55

    session.tracker.feed("Context window is 73% full\n")

    assert session.tracker.reported_context_percent == 73
    assert session.tracker.derived_context_percent == 55  # still computed
    assert session.tracker.context_percent == 73          # but reported wins


def test_scrape_alone_still_works_with_an_unknown_model(manager):
    session = _session(model="some-unreleased-model")
    manager.sessions[session.id] = session
    session.tracker.feed("context: 42% used\n")

    manager.refresh_derived_context()

    assert session.tracker.context_percent == 42


def test_context_percent_is_read_only():
    from pty_manager import SessionStateTracker
    with pytest.raises(AttributeError):
        SessionStateTracker().context_percent = 50


def test_refresh_never_raises_when_the_usage_db_fails(manager, monkeypatch):
    session = _session()
    manager.sessions[session.id] = session
    import usage_tracker as ut

    class _Boom:
        def latest_turn(self, _tid):
            raise RuntimeError("db gone")

    monkeypatch.setattr(ut, "usage_tracker", _Boom())
    manager.refresh_derived_context()  # must not raise
    assert session.tracker.context_percent is None


def test_session_dict_serialises_the_derived_value(manager, tracker, tmp_path):
    session = _session(model="claude-sonnet-5")
    manager.sessions[session.id] = session
    tracker.ingest_jsonl(session.id, _write_jsonl(tmp_path, [
        _assistant_line("u1", model="claude-sonnet-5", input_tokens=1_000,
                        cache_read=99_000),
    ]))
    manager.refresh_derived_context()

    payload = manager._session_to_dict(session)
    assert payload["context_percent"] == 50
