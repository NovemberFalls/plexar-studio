"""Tests for Plexar Mobile Stage 4 server-side additions.

Covers three independent pieces added to `remote_gateway.py`:
  * `branch` on a sessions-list row, derived via `RemoteBackend.git_branch`.
  * `effort` on a sessions-list row -- resolved by the gateway itself from the
    real session's `tracker.effort` (live) falling back to `TerminalSession.effort`
    (launch), since `pty_manager._session_to_dict` emits no `effort` key.
  * `<image name=[Image #N] path="...">...</image>` tags in a user message's
    text becoming `image` blocks, with the tag text removed from the bubble.

Deliberately unit-level (calls `remote_gateway._session_view` /
`_claude_message` / `_extract_image_tags` directly) rather than routed through
a TestClient -- these are pure functions of their inputs and do not need a
running app to prove.
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import remote_gateway  # noqa: E402
from remote_gateway import RemoteBackend  # noqa: E402


def _minimal_backend(**overrides) -> RemoteBackend:
    base = dict(
        settings=lambda: {},
        app_version=lambda: "test",
        list_sessions=lambda: [],
        get_session=lambda tid: None,
        create_session=None,
        submit=None,
        write_raw=None,
        interrupt=None,
    )
    base.update(overrides)
    return RemoteBackend(**base)


# -- branch ------------------------------------------------------------------


def test_session_view_derives_branch_via_backend_callable():
    backend = _minimal_backend(git_branch=lambda workdir: {"C:/repo": "lane/mobile"}.get(workdir))
    entry = {"id": "t1", "working_dir": "C:/repo"}
    view = remote_gateway._session_view(entry, backend)
    assert view["branch"] == "lane/mobile"


def test_session_view_branch_null_with_no_working_dir():
    backend = _minimal_backend(git_branch=lambda workdir: "should-not-be-called")
    view = remote_gateway._session_view({"id": "t1", "working_dir": None}, backend)
    assert view["branch"] is None


def test_session_view_branch_null_when_git_branch_not_wired():
    view = remote_gateway._session_view({"id": "t1", "working_dir": "C:/repo"})
    assert view["branch"] is None


def test_session_view_branch_null_when_backend_callable_raises():
    def _boom(_workdir):
        raise OSError("no such dir")

    backend = _minimal_backend(git_branch=_boom)
    view = remote_gateway._session_view({"id": "t1", "working_dir": "C:/repo"}, backend)
    assert view["branch"] is None


# -- effort --------------------------------------------------------------
#
# `effort` is resolved off the REAL session object (`backend.get_session`),
# never off the already-stripped list entry -- `pty_manager._session_to_dict`
# emits no `effort` key at all. Live (`tracker.effort`) wins over launch
# (`TerminalSession.effort`); an empty string is treated as unset at every
# step, including on a dict-shaped test double.


def _real_session(*, tracker_effort=None, session_effort=""):
    import pty_manager

    session = pty_manager.TerminalSession(
        id="t1", name="s", pty=None, created_at="now",
    )
    session.effort = session_effort
    session.tracker.effort = tracker_effort
    return session


def test_session_view_effort_prefers_live_tracker_over_launch():
    session = _real_session(tracker_effort="high", session_effort="low")
    backend = _minimal_backend(get_session=lambda tid: session)
    view = remote_gateway._session_view({"id": "t1"}, backend)
    assert view["effort"] == "high"


def test_session_view_effort_falls_back_to_launch_when_tracker_unset():
    session = _real_session(tracker_effort=None, session_effort="low")
    backend = _minimal_backend(get_session=lambda tid: session)
    view = remote_gateway._session_view({"id": "t1"}, backend)
    assert view["effort"] == "low"


def test_session_view_effort_null_when_both_empty():
    session = _real_session(tracker_effort=None, session_effort="")
    backend = _minimal_backend(get_session=lambda tid: session)
    view = remote_gateway._session_view({"id": "t1"}, backend)
    assert view["effort"] is None


def test_session_view_effort_dict_double_empty_string_becomes_none():
    backend = _minimal_backend(get_session=lambda tid: None)
    view = remote_gateway._session_view({"id": "t1", "effort": ""}, backend)
    assert view["effort"] is None


def test_session_view_effort_dict_double_passthrough_when_no_backend_session():
    backend = _minimal_backend(get_session=lambda tid: None)
    view = remote_gateway._session_view({"id": "t1", "effort": "high"}, backend)
    assert view["effort"] == "high"


def test_session_view_effort_null_when_absent():
    backend = _minimal_backend()
    view = remote_gateway._session_view({"id": "t1"}, backend)
    assert view["effort"] is None


def test_field_pin_is_thirteen_and_ordered():
    assert len(remote_gateway.SESSION_FIELDS) == 13
    assert remote_gateway.SESSION_FIELDS[-3:] == ("branch", "effort", "parent_id")


# -- parent_id -------------------------------------------------------------


def test_session_view_parent_id_passthrough_for_worker_and_null_for_top_level():
    backend = _minimal_backend()
    worker = remote_gateway._session_view({"id": "w1", "parent_id": "p1"}, backend)
    top = remote_gateway._session_view({"id": "p1", "parent_id": None}, backend)
    absent = remote_gateway._session_view({"id": "p2"}, backend)
    assert worker["parent_id"] == "p1"
    assert top["parent_id"] is None
    assert absent["parent_id"] is None


# -- image tags ------------------------------------------------------------


def test_extract_image_tags_open_close_with_whitespace():
    text = '<image name=[Image #1] path="C:\\shots\\one.png">  </image>'
    remaining, paths = remote_gateway._extract_image_tags(text)
    assert paths == ["C:\\shots\\one.png"]
    assert remaining == ""


def test_extract_image_tags_self_closing():
    text = '<image name=[Image #1] path="C:\\shots\\one.png"/>'
    remaining, paths = remote_gateway._extract_image_tags(text)
    assert paths == ["C:\\shots\\one.png"]
    assert remaining == ""


def test_extract_image_tags_multiline_whitespace_variant():
    text = '<image name=[Image #1] path="C:\\shots\\one.png">\n\n   </image>'
    remaining, paths = remote_gateway._extract_image_tags(text)
    assert paths == ["C:\\shots\\one.png"]
    assert remaining == ""


def test_extract_image_tags_preserves_surrounding_text_and_collapses_whitespace():
    text = 'check   this <image name=[Image #1] path="C:\\a.png"></image>   out'
    remaining, paths = remote_gateway._extract_image_tags(text)
    assert paths == ["C:\\a.png"]
    assert remaining == "check this out"


def test_extract_image_tags_multiple_tags_in_order():
    text = (
        '<image name=[Image #1] path="C:\\a.png"></image>'
        " and "
        '<image name=[Image #2] path="C:\\b.png"/>'
    )
    remaining, paths = remote_gateway._extract_image_tags(text)
    assert paths == ["C:\\a.png", "C:\\b.png"]
    assert remaining == "and"


def test_extract_image_tags_no_tag_returns_text_unchanged():
    remaining, paths = remote_gateway._extract_image_tags("plain text, no tags here")
    assert paths == []
    assert remaining == "plain text, no tags here"


def test_claude_message_turns_image_tag_into_image_block_and_drops_empty_text():
    entry = {
        "id": "u1",
        "type": "user",
        "role": "user",
        "timestamp": "2026-09-08T00:00:00Z",
        "content": [
            {
                "type": "text",
                "text": '<image name=[Image #1] path="C:\\shots\\one.png">  </image>',
            }
        ],
    }
    message = remote_gateway._claude_message(entry, roots=[])
    assert message is not None
    assert message["blocks"] == [{"type": "image", "path": "C:\\shots\\one.png"}]


def test_claude_message_keeps_remaining_text_alongside_image_block():
    entry = {
        "id": "u1",
        "type": "user",
        "role": "user",
        "timestamp": "2026-09-08T00:00:00Z",
        "content": [
            {
                "type": "text",
                "text": 'take a look <image name=[Image #1] path="C:\\a.png"></image> please',
            }
        ],
    }
    message = remote_gateway._claude_message(entry, roots=[])
    assert message["blocks"] == [
        {"type": "text", "text": "take a look please"},
        {"type": "image", "path": "C:\\a.png"},
    ]


def test_claude_message_assistant_role_does_not_get_tag_extraction():
    entry = {
        "id": "a1",
        "type": "assistant",
        "role": "assistant",
        "timestamp": "2026-09-08T00:00:00Z",
        "content": [
            {
                "type": "text",
                "text": '<image name=[Image #1] path="C:\\a.png"></image>',
            }
        ],
    }
    message = remote_gateway._claude_message(entry, roots=[])
    assert message["blocks"] == [
        {"type": "text", "text": '<image name=[Image #1] path="C:\\a.png"></image>'}
    ]


# -- the BARE tag form, which is the one real data actually uses (R-187) -------
#
# Every case above uses `/>` or `>...</image>`. MEASURED 2026-09-09: across 27
# Codex rollouts on the owner's machine there are 520 image tags and EVERY ONE
# is the bare `>` form -- zero self-closing, zero open/close. The old pattern
# therefore matched NOTHING in real data while all of its tests passed, because
# the tests invented a shape the harnesses do not write. These cases pin the
# real one.


def test_extract_image_tags_bare_form_is_the_real_shape():
    text = '<image name=[Image #1] path="C:\\shots\\one.png">'
    remaining, paths = remote_gateway._extract_image_tags(text)
    assert paths == ["C:\\shots\\one.png"]
    assert remaining == ""


def test_extract_image_tags_bare_form_keeps_surrounding_prose():
    text = 'look <image name=[Image #1] path="C:\\a.png"> at this'
    remaining, paths = remote_gateway._extract_image_tags(text)
    assert paths == ["C:\\a.png"]
    assert remaining == "look at this"


def test_extract_image_tags_bare_and_closed_forms_mix():
    text = (
        '<image name=[Image #1] path="C:\\a.png">'
        " then "
        '<image name=[Image #2] path="C:\\b.png"></image>'
    )
    remaining, paths = remote_gateway._extract_image_tags(text)
    assert paths == ["C:\\a.png", "C:\\b.png"]
    assert remaining == "then"


def test_codex_user_message_yields_an_image_block():
    """A Codex row carrying an attachment renders as an image on the phone.

    `_codex_message` used to emit text only, so under Codex an attachment could
    never render and the raw tag showed as literal markup in the bubble.
    """
    row = {
        "index": 7,
        "role": "user",
        "text": '<image name=[Image #1] path="C:\\shots\\one.png">',
        "timestamp": "2026-09-09T18:05:00Z",
    }
    out = remote_gateway._codex_message(row)
    assert out["blocks"] == [{"type": "image", "path": "C:\\shots\\one.png"}]


def test_codex_user_message_keeps_prose_beside_the_image():
    row = {"index": 8, "role": "user", "text": 'see <image name=[Image #1] path="C:\\a.png"> here'}
    out = remote_gateway._codex_message(row)
    assert out["blocks"] == [
        {"type": "text", "text": "see here"},
        {"type": "image", "path": "C:\\a.png"},
    ]


def test_codex_assistant_message_is_left_text_only():
    """Only a USER row carries attachments; an assistant row must not be rewritten."""
    row = {"index": 9, "role": "assistant", "text": '<image name=[Image #1] path="C:\\a.png">'}
    out = remote_gateway._codex_message(row)
    assert [b["type"] for b in out["blocks"]] == ["text"]


def test_codex_plain_user_message_is_unchanged():
    row = {"index": 10, "role": "user", "text": "no attachment here"}
    out = remote_gateway._codex_message(row)
    assert out["blocks"] == [{"type": "text", "text": "no attachment here"}]
