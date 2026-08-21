"""Tests for the V4 mailbox bridge protocol.

The behaviours pinned here are the ones the old V2/V3 relay could not express,
so a regression would silently return the bridge to its previous shape:

    * one participant declaring done does NOT end the bridge
    * an unacknowledged message blocks completion even when everyone is done
    * a substantive post AFTER a done-declaration withdraws it
    * the round cap PAUSES (``awaiting_human``) instead of terminating
    * ``extend`` resumes the same conversation rather than starting a new one
    * every control line is addressed to nobody, so every watcher sees it
"""

import asyncio
import json

import pytest

import mailbox_bridge
from mailbox_bridge import MailboxManager


# ---------------------------------------------------------------------------
# Fakes
# ---------------------------------------------------------------------------

class _FakeTracker:
    def __init__(self, state="idle"):
        self.state = state


class _FakeSession:
    def __init__(self, name, alive=True):
        self.name = name
        self.alive = alive
        self.tracker = _FakeTracker()


class _FakePtyManager:
    def __init__(self):
        self.sessions = {}

    def get_terminal(self, tid):
        return self.sessions.get(tid)


@pytest.fixture
def pty(monkeypatch):
    fake = _FakePtyManager()
    fake.sessions["t-lead"] = _FakeSession("Alpha")
    fake.sessions["t-w1"] = _FakeSession("Beta")
    fake.sessions["t-w2"] = _FakeSession("Gamma")
    monkeypatch.setattr(mailbox_bridge, "pty_manager", fake)
    return fake


@pytest.fixture
def writes(monkeypatch):
    """Capture every PTY write instead of performing one.

    Returns the list of ``(terminal_id, text)`` tuples. Its LENGTH is the
    assertion that matters most: after kickoff, a relayed turn must cost zero
    PTY writes.
    """
    captured = []

    async def _fake_paste(terminal_id, text):
        captured.append((terminal_id, text))
        return True

    monkeypatch.setattr(mailbox_bridge, "_paste_and_submit", _fake_paste)
    return captured


@pytest.fixture
def mgr(tmp_path, monkeypatch, pty, writes):
    monkeypatch.setattr(mailbox_bridge, "_MAILBOX_ROOT", tmp_path)
    m = MailboxManager()
    # The background tasks need a running loop and are irrelevant to protocol
    # assertions; the two tests that exercise them start them explicitly.
    monkeypatch.setattr(m, "_ensure_background", lambda: None)
    return m


async def _start(mgr, workers=("t-w1",), rounds=12):
    return await mgr.start("t-lead", list(workers), "Ship the thing.", rounds)


def _lines(mgr, mid):
    record = mgr.get(mid)
    return [
        json.loads(line)
        for line in record.mailbox_path.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]


# ---------------------------------------------------------------------------
# Start
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_start_creates_mailbox_and_briefs(mgr, writes):
    res = await _start(mgr, ("t-w1", "t-w2"))
    assert res["ok"] is True
    record = mgr.get(res["mailbox_id"])

    assert record.mailbox_path.exists()
    assert sorted(record.participants) == ["lead", "w1", "w2"]
    for handle in ("lead", "w1", "w2"):
        assert (record.directory / f"brief-{handle}.md").exists()


@pytest.mark.asyncio
async def test_kickoff_is_one_tiny_write_per_session(mgr, writes):
    """The whole point: the PTY payload is a pointer, not the payload.

    The old bridge injected the framed prompt itself and switched to a
    file-handoff prompt past 2 KB, which made message size a correctness
    concern on ConPTY. Here it is constant and small regardless of the brief.
    """
    await _start(mgr, ("t-w1", "t-w2"))
    assert len(writes) == 3
    for _tid, text in writes:
        assert len(text.encode()) < 512
        assert "PEER BRIDGE" in text


@pytest.mark.asyncio
async def test_brief_monitor_filter_matches_broadcast_and_control(mgr):
    """A worker's grep must match its own mail, broadcasts, AND control lines.

    Monitor's contract is explicit that silence is not success: a filter that
    only matched direct messages would leave a worker unaware of `paused` and
    `end`, which is exactly a session that hangs forever.
    """
    res = await _start(mgr, ("t-w1",))
    record = mgr.get(res["mailbox_id"])
    brief = (record.directory / "brief-w1.md").read_text(encoding="utf-8")

    cmd = mailbox_bridge._monitor_command(record.mailbox_path, "w1")
    assert cmd in brief
    assert "--line-buffered" in cmd
    assert '"to":"(w1|\\*)"' in cmd
    assert '"type":"control"' in cmd


@pytest.mark.asyncio
async def test_start_rejects_dead_session(mgr, pty):
    pty.sessions["t-w1"].alive = False
    res = await _start(mgr, ("t-w1",))
    assert res["ok"] is False
    assert "not found or dead" in res["error"]


@pytest.mark.asyncio
async def test_failed_kickoff_ends_the_bridge(mgr, monkeypatch, pty):
    async def _fail(terminal_id, text):
        return terminal_id != "t-w1"

    monkeypatch.setattr(mailbox_bridge, "_paste_and_submit", _fail)
    res = await _start(mgr, ("t-w1",))
    assert res["ok"] is False
    assert "Beta" in res["error"]
    # A half-enrolled bridge must not sit around holding its sessions hostage.
    assert mgr.member_ids() == set()


# ---------------------------------------------------------------------------
# Posting
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_post_appends_and_costs_no_pty_write(mgr, writes):
    res = await _start(mgr, ("t-w1",))
    mid = res["mailbox_id"]
    writes.clear()

    posted = await mgr.post(mid, "lead", "w1", "Do the thing.")
    assert posted["ok"] is True
    assert posted["seq"] == 1
    assert writes == []  # <- the entire thesis of this design

    lines = _lines(mgr, mid)
    assert lines[-1]["from"] == "lead"
    assert lines[-1]["to"] == "w1"
    assert lines[-1]["body"] == "Do the thing."


@pytest.mark.asyncio
async def test_broadcast_owes_every_worker_an_ack(mgr):
    res = await _start(mgr, ("t-w1", "t-w2"))
    mid = res["mailbox_id"]
    await mgr.post(mid, "lead", "*", "Both of you, start.")

    record = mgr.get(mid)
    assert record.unacked_for("w1") == [1]
    assert record.unacked_for("w2") == [1]
    assert record.unacked_for("lead") == []


@pytest.mark.asyncio
async def test_ack_clears_only_the_senders_debt(mgr):
    res = await _start(mgr, ("t-w1", "t-w2"))
    mid = res["mailbox_id"]
    await mgr.post(mid, "lead", "*", "Both of you, start.")
    await mgr.post(mid, "w1", "lead", "On it.", ack=1)

    record = mgr.get(mid)
    assert record.unacked_for("w1") == []
    assert record.unacked_for("w2") == [1]


@pytest.mark.asyncio
async def test_post_rejects_unknown_and_self_addressed(mgr):
    mid = (await _start(mgr, ("t-w1",)))["mailbox_id"]

    assert (await mgr.post(mid, "nobody", "w1", "hi"))["status"] == 400
    assert (await mgr.post(mid, "lead", "w9", "hi"))["status"] == 400
    assert (await mgr.post(mid, "lead", "lead", "hi"))["status"] == 400
    assert (await mgr.post(mid, "lead", "w1", "   "))["status"] == 400
    assert (await mgr.post("no-such-bridge", "lead", "w1", "hi"))["status"] == 404


# ---------------------------------------------------------------------------
# Done semantics — the behaviour V2/V3 got wrong
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_one_side_declaring_done_does_not_end_the_bridge(mgr):
    """V2 ended on the FIRST ``BRIDGE-DONE`` from either side. This must not."""
    mid = (await _start(mgr, ("t-w1",)))["mailbox_id"]
    await mgr.post(mid, "lead", "w1", "Do the thing.")
    res = await mgr.post(mid, "w1", "lead", "Finished my part.", ack=1, done=True)

    assert res["state"] == "active"
    assert mgr.get(mid).state == "active"


@pytest.mark.asyncio
async def test_bridge_ends_when_all_done_and_nothing_unacked(mgr):
    mid = (await _start(mgr, ("t-w1",)))["mailbox_id"]
    await mgr.post(mid, "lead", "w1", "Do the thing.")
    await mgr.post(mid, "w1", "lead", "Done my part.", ack=1, done=True)
    res = await mgr.post(mid, "lead", "w1", "Agreed, we're finished.", ack=2, done=True)

    assert res["state"] == "ended_agreed"
    assert mgr.get(mid).state == "ended_agreed"
    assert _lines(mgr, mid)[-1] == {
        **_lines(mgr, mid)[-1],
        "type": "control",
        "event": "end",
    }


@pytest.mark.asyncio
async def test_unacked_message_blocks_completion(mgr):
    """Everyone done, but a question is still hanging — that is not finished.

    Without this clause two agents can converge on "sounds good, done" while a
    real question sits unanswered in the mailbox: the old bridge's failure mode
    wearing a new hat.
    """
    mid = (await _start(mgr, ("t-w1",)))["mailbox_id"]
    await mgr.post(mid, "lead", "w1", "Do the thing.", done=True)
    # w1 replies done but never acks seq 1, and its own message is unacked.
    res = await mgr.post(mid, "w1", "lead", "One question first...", done=True)

    assert res["state"] == "active"
    record = mgr.get(mid)
    assert all(p.done for p in record.participants.values())
    assert record._unacked  # the reason it is still open


@pytest.mark.asyncio
async def test_posting_again_withdraws_a_done_declaration(mgr):
    mid = (await _start(mgr, ("t-w1",)))["mailbox_id"]
    await mgr.post(mid, "lead", "w1", "Go.")
    await mgr.post(mid, "w1", "lead", "Done.", ack=1, done=True)
    assert mgr.get(mid).participants["w1"].done is True

    await mgr.post(mid, "w1", "lead", "Actually, one more thing.", done=False)
    assert mgr.get(mid).participants["w1"].done is False
    assert mgr.get(mid).state == "active"


# ---------------------------------------------------------------------------
# Round cap — pauses, does not kill
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_round_cap_pauses_instead_of_ending(mgr):
    mid = (await _start(mgr, ("t-w1",), rounds=2))["mailbox_id"]
    await mgr.post(mid, "lead", "w1", "One.")
    res = await mgr.post(mid, "w1", "lead", "Two.", ack=1)

    assert res["state"] == "awaiting_human"
    record = mgr.get(mid)
    assert record.state == "awaiting_human"
    # Not terminal: the sessions are still enrolled and still watching.
    assert record.terminal_ids <= mgr.member_ids()

    control = _lines(mgr, mid)[-1]
    assert control["type"] == "control"
    assert control["event"] == "paused"
    assert "to" not in control  # every watcher sees it, addressed to nobody


@pytest.mark.asyncio
async def test_posting_while_paused_is_refused_with_409(mgr):
    mid = (await _start(mgr, ("t-w1",), rounds=1))["mailbox_id"]
    await mgr.post(mid, "lead", "w1", "One.")
    res = await mgr.post(mid, "w1", "lead", "Two.", ack=1)

    assert res["ok"] is False
    assert res["status"] == 409
    assert "awaiting a human" in res["error"]


@pytest.mark.asyncio
async def test_extend_resumes_the_same_conversation(mgr):
    mid = (await _start(mgr, ("t-w1",), rounds=1))["mailbox_id"]
    await mgr.post(mid, "lead", "w1", "One.")
    assert mgr.get(mid).state == "awaiting_human"

    res = await mgr.extend(mid, 4)
    assert res["ok"] is True
    assert res["state"] == "active"
    assert res["max_rounds"] == 5

    control = _lines(mgr, mid)[-1]
    assert control["event"] == "resumed"

    # Same mailbox, seq continues — not a new bridge.
    posted = await mgr.post(mid, "w1", "lead", "Two.", ack=1)
    assert posted["ok"] is True
    assert posted["seq"] > 1


@pytest.mark.asyncio
async def test_completion_beats_the_cap(mgr):
    """A final post that finishes the job ends cleanly, not as a pause."""
    mid = (await _start(mgr, ("t-w1",), rounds=2))["mailbox_id"]
    await mgr.post(mid, "lead", "w1", "Go.", done=True)
    res = await mgr.post(mid, "w1", "lead", "Done.", ack=1, done=True)

    assert res["state"] == "ended_agreed"


@pytest.mark.asyncio
async def test_extend_refused_after_the_bridge_ended(mgr):
    mid = (await _start(mgr, ("t-w1",)))["mailbox_id"]
    await mgr.stop(mid)
    res = await mgr.extend(mid, 4)
    assert res["ok"] is False
    assert res["status"] == 409


@pytest.mark.asyncio
async def test_extend_validates_its_argument(mgr):
    mid = (await _start(mgr, ("t-w1",)))["mailbox_id"]
    assert (await mgr.extend(mid, 0))["status"] == 400
    assert (await mgr.extend(mid, 10_000))["status"] == 400


@pytest.mark.asyncio
async def test_cap_is_not_overshot_by_simultaneous_posts(mgr):
    """The cap check and the seq assignment are one critical section.

    Checked outside the record lock, N concurrent posts all observe
    ``rounds_used < max_rounds`` and commit together.
    """
    mid = (await _start(mgr, ("t-w1", "t-w2"), rounds=3))["mailbox_id"]
    results = await asyncio.gather(
        *(mgr.post(mid, "lead", "*", f"burst {i}") for i in range(8))
    )
    accepted = [r for r in results if r.get("ok")]
    assert len(accepted) == 3
    assert mgr.get(mid).rounds_used == 3
    assert sorted(r["seq"] for r in accepted) == [1, 2, 3]


# ---------------------------------------------------------------------------
# Stop / lifecycle
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_stop_ends_and_releases_the_sessions(mgr):
    mid = (await _start(mgr, ("t-w1",)))["mailbox_id"]
    assert mgr.member_ids() == {"t-lead", "t-w1"}

    assert await mgr.stop(mid) is True
    assert mgr.get(mid).state == "ended_user"
    assert mgr.member_ids() == set()
    assert _lines(mgr, mid)[-1]["event"] == "end"


@pytest.mark.asyncio
async def test_stop_is_idempotent_and_reports_unknown(mgr):
    mid = (await _start(mgr, ("t-w1",)))["mailbox_id"]
    assert await mgr.stop(mid) is True
    assert await mgr.stop(mid) is True
    assert await mgr.stop("no-such-bridge") is False


@pytest.mark.asyncio
async def test_paused_bridge_still_holds_its_sessions(mgr):
    """A paused bridge is live. A second bridge must not claim its sessions."""
    mid = (await _start(mgr, ("t-w1",), rounds=1))["mailbox_id"]
    await mgr.post(mid, "lead", "w1", "One.")
    assert mgr.get(mid).state == "awaiting_human"
    assert mgr.member_ids() == {"t-lead", "t-w1"}


@pytest.mark.asyncio
async def test_dead_participant_ends_the_bridge(mgr, pty, monkeypatch):
    """A session that exits can never ack, so the rest must not wait forever."""
    monkeypatch.setattr(mailbox_bridge, "_WATCHDOG_INTERVAL", 0.01)
    mid = (await _start(mgr, ("t-w1",)))["mailbox_id"]
    pty.sessions["t-w1"].alive = False

    task = asyncio.create_task(mgr._watchdog_loop())
    for _ in range(50):
        await asyncio.sleep(0.01)
        if mgr.get(mid).state != "active":
            break
    task.cancel()

    record = mgr.get(mid)
    assert record.state == "errored"
    assert "Beta" in record.end_reason


@pytest.mark.asyncio
async def test_human_gate_expires_a_pause_that_nobody_answers(mgr, monkeypatch):
    monkeypatch.setattr(mailbox_bridge, "_WATCHDOG_INTERVAL", 0.01)
    monkeypatch.setattr(mailbox_bridge, "_HUMAN_GATE_MAX", 0.0)
    mid = (await _start(mgr, ("t-w1",), rounds=1))["mailbox_id"]
    await mgr.post(mid, "lead", "w1", "One.")
    assert mgr.get(mid).state == "awaiting_human"

    task = asyncio.create_task(mgr._watchdog_loop())
    for _ in range(50):
        await asyncio.sleep(0.01)
        if mgr.get(mid).state != "awaiting_human":
            break
    task.cancel()

    assert mgr.get(mid).state == "ended_capped"


# ---------------------------------------------------------------------------
# Transcript
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_transcript_skips_a_malformed_line_rather_than_failing(mgr):
    mid = (await _start(mgr, ("t-w1",)))["mailbox_id"]
    await mgr.post(mid, "lead", "w1", "One.")
    record = mgr.get(mid)
    with record.mailbox_path.open("a", encoding="utf-8") as fh:
        fh.write("{not json\n")
    await mgr.post(mid, "w1", "lead", "Two.", ack=1)

    messages = mailbox_bridge.read_mailbox(record)
    bodies = [m.get("body") for m in messages if m.get("type") == "msg"]
    assert bodies == ["One.", "Two."]


@pytest.mark.asyncio
async def test_handle_validation_rejects_regex_metacharacters(mgr):
    """Handles are interpolated into a grep pattern inside the brief."""
    assert mailbox_bridge._validate_handle("w1") is True
    assert mailbox_bridge._validate_handle("lead") is True
    assert mailbox_bridge._validate_handle("w1|.*") is False
    assert mailbox_bridge._validate_handle('w1"') is False
    assert mailbox_bridge._validate_handle("") is False
