"""Mailbox bridge (V4) — self-driving peer coordination via a shared file.

This replaces the V2 auto-bridge and V3 channel relay loops.  Those worked by
having the SERVER tail each session's JSONL, wait for the peer to go idle, and
inject the peer's reply into its PTY as bracketed paste.  Every hard problem in
``bridge_manager`` — ConPTY byte-drop, escape sequences bisected at a chunk
boundary, the paste-without-submit stall, the typing-quiet stutter, JSONL
mis-attribution, the 2 KB inline/file-handoff split — is a property of THAT
delivery path.

The mailbox protocol deletes the path rather than hardening it.

    * There is ONE shared append-only file per bridge, ``mailbox.jsonl``.
    * Each participating session arms its OWN ``Monitor`` on that file
      (``tail -f`` filtered to lines addressed to it).  Claude Code's Monitor
      tool streams each stdout line as an event that re-invokes the session, so
      a session is *pinged* by the file itself.  The server does not deliver.
    * A session SENDS by POSTing to ``/api/bridge/mb/{id}/post``.  The server is
      the single writer: it assigns the monotonic ``seq``, enforces the round
      cap, and appends the line.  Sessions never write the file directly, so
      two simultaneous replies cannot interleave a partial append.

After the kickoff, the number of PTY writes per relayed turn is **zero**.

Two behavioural changes the owner asked for, both of which the old design could
not express:

    * **Both sides must agree to finish.**  V2/V3 ended the moment EITHER side
      emitted ``BRIDGE-DONE``, so one agent could hang up mid-conversation.
      Here ``done`` is a per-participant flag; the bridge completes only when
      every participant has it set AND no message is still unacknowledged.
      Posting a normal message CLEARS the sender's flag — an agent that said it
      was finished and then kept talking is, observably, not finished.

    * **The round cap pauses; it does not kill.**  V2/V3 hit ``max_turns`` and
      terminated.  Here the bridge enters ``awaiting_human``: posting is
      refused, a ``paused`` control line tells every session to stand down, and
      the UI offers "grant N more rounds".  ``extend()`` appends a ``resumed``
      control line, which every Monitor sees, and work continues in the same
      conversation.  Ending on a cap is the LAST resort (the human never
      answered), not the normal exit.

This module does NOT:
    - Define FastAPI routes (server.py does)
    - Spawn or kill PTY sessions
    - Write to a session's PTY except for the one-shot kickoff and the
      liveness nudge (see ``_watchdog_loop``)
"""

from __future__ import annotations

import asyncio
import json
import logging
import pathlib
import re
import shutil
import tempfile
import time
import uuid
from dataclasses import dataclass, field
from typing import Optional

from bridge_manager import _paste_and_submit
from pty_manager import pty_manager

logger = logging.getLogger("cockpit.bridge")

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

# Root for per-bridge mailbox directories. One temp dir for the process; each
# bridge gets a subdirectory under it.
_MAILBOX_ROOT = pathlib.Path(tempfile.mkdtemp(prefix="cockpit_mailbox_"))

# How long a terminal record is kept in memory (and its directory on disk) so
# frontend pollers can read the final state and the user can still read the
# transcript.
_RECORD_TTL = 600.0

# How long the bridge will sit in ``awaiting_human`` before giving up. The whole
# point of the pause is to wait for a person, so this is generous — but it is
# finite, because a paused bridge pins its sessions against the conflict guard
# and a wedged bridge nobody ever answers is worse than one that ends.
_HUMAN_GATE_MAX = 1800.0  # 30 minutes

# A participant that has been sitting on an unacknowledged message for this long
# while its own PTY is idle probably never armed (or lost) its Monitor. The
# watchdog nudges it once via the PTY — the repair path, not the delivery path.
_NUDGE_AFTER = 90.0

# Cap on nudges per participant per bridge. A session that ignores two nudges is
# not going to answer a third, and repeated injection is exactly the PTY
# hammering this design exists to avoid.
_MAX_NUDGES = 2

_WATCHDOG_INTERVAL = 15.0
_GC_INTERVAL = 30.0

# Bounds accepted by start()/extend(). Rounds are messages, not round-trips.
MIN_ROUNDS = 1
MAX_ROUNDS = 200

MAILBOX_FILENAME = "mailbox.jsonl"

# Terminal states. ``awaiting_human`` is deliberately NOT one of them — a paused
# bridge is still live and resumable.
_TERMINAL_STATES = frozenset(
    {"ended_agreed", "ended_user", "ended_capped", "errored"}
)


# ---------------------------------------------------------------------------
# Participants
# ---------------------------------------------------------------------------

@dataclass
class _Participant:
    """One session enrolled in a mailbox bridge.

    ``handle`` is what appears in the mailbox file's ``from``/``to`` fields
    (``lead``, ``w1``, ``w2``, ...).  It is deliberately NOT the terminal id:
    the handle goes into a shell grep pattern inside the session's Monitor
    command, so it must be short, stable, and free of regex metacharacters.
    """

    handle: str
    terminal_id: str
    name: str
    role: str  # "lead" | "worker"

    done: bool = False
    posts: int = 0
    nudges: int = field(default=0, repr=False)
    last_post_at: Optional[float] = field(default=None, repr=False)

    def to_dict(self) -> dict:
        return {
            "handle": self.handle,
            "terminal_id": self.terminal_id,
            "name": self.name,
            "role": self.role,
            "done": self.done,
            "posts": self.posts,
        }


# ---------------------------------------------------------------------------
# Bridge record
# ---------------------------------------------------------------------------

@dataclass
class _MailboxRecord:
    """Server-side state for one mailbox bridge.

    The mailbox FILE is the conversation; this record is the state machine
    around it (who is enrolled, what is unacked, whether posting is currently
    allowed).  The two are written under the same lock so a post can never be
    appended to the file without its accounting landing, or vice versa.
    """

    mailbox_id: str
    directory: pathlib.Path
    participants: dict[str, _Participant]  # handle → participant
    max_rounds: int
    topic: str

    state: str = "active"
    end_reason: Optional[str] = None

    seq: int = 0
    rounds_used: int = 0

    # seq → handle of the participant expected to acknowledge it. A broadcast
    # from the lead lands one entry per worker, keyed (seq, handle).
    _unacked: set[tuple[int, str]] = field(default_factory=set, repr=False)

    _created_at: float = field(default_factory=time.monotonic, repr=False)
    _paused_at: Optional[float] = field(default=None, repr=False)
    _ended_at: Optional[float] = field(default=None, repr=False)
    _lock: asyncio.Lock = field(default_factory=asyncio.Lock, repr=False)

    # ---- derived -----------------------------------------------------

    @property
    def mailbox_path(self) -> pathlib.Path:
        return self.directory / MAILBOX_FILENAME

    @property
    def terminal_ids(self) -> set[str]:
        return {p.terminal_id for p in self.participants.values()}

    def by_terminal(self, terminal_id: str) -> Optional[_Participant]:
        for p in self.participants.values():
            if p.terminal_id == terminal_id:
                return p
        return None

    @property
    def lead(self) -> _Participant:
        return self.participants["lead"]

    def unacked_for(self, handle: str) -> list[int]:
        return sorted(s for (s, h) in self._unacked if h == handle)

    def to_dict(self) -> dict:
        return {
            "mailbox_id": self.mailbox_id,
            "kind": "mailbox",
            "topic": self.topic,
            "state": self.state,
            "end_reason": self.end_reason,
            "rounds_used": self.rounds_used,
            "max_rounds": self.max_rounds,
            "mailbox_path": str(self.mailbox_path),
            "participants": [p.to_dict() for p in self.participants.values()],
            "unacked": [
                {"seq": s, "handle": h} for (s, h) in sorted(self._unacked)
            ],
            # Convenience for the UI's pane overlays, which key on terminal id.
            "lead_id": self.lead.terminal_id,
            "worker_ids": [
                p.terminal_id
                for p in self.participants.values()
                if p.role == "worker"
            ],
        }


# ---------------------------------------------------------------------------
# Handles
# ---------------------------------------------------------------------------

_SAFE_HANDLE = re.compile(r"^[a-z][a-z0-9]{0,15}$")


def _validate_handle(handle: str) -> bool:
    """True if *handle* is safe to embed in a grep pattern and a JSON field.

    Handles are server-assigned (``lead``/``w1``/``w2``...), so this is a guard
    against a caller-supplied ``from``/``to`` rather than against our own
    generator — but it runs on every post, because the post body comes from a
    session, and a session is a language model that can and will typo.
    """
    return bool(_SAFE_HANDLE.match(handle))


# ---------------------------------------------------------------------------
# Mailbox file I/O
# ---------------------------------------------------------------------------

def _append_line(path: pathlib.Path, obj: dict) -> None:
    """Append one JSON object to the mailbox as a single line.

    Blocking; callers hop it to a thread. ``ensure_ascii=False`` keeps the
    transcript readable, and the newline is written in the SAME ``write`` call
    as the payload so a reader tailing the file never observes a line without
    its terminator.
    """
    with path.open("a", encoding="utf-8", newline="\n") as fh:
        fh.write(json.dumps(obj, ensure_ascii=False) + "\n")
        fh.flush()


def read_mailbox(record: _MailboxRecord, limit: int | None = None) -> list[dict]:
    """Return parsed mailbox lines, newest last.

    Malformed lines are SKIPPED rather than raising: the transcript is a UI
    convenience, and one bad line must not make the whole conversation
    unreadable. A skip is logged so it is not silent.
    """
    path = record.mailbox_path
    if not path.exists():
        return []
    out: list[dict] = []
    try:
        with path.open("r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    out.append(json.loads(line))
                except json.JSONDecodeError:
                    logger.warning(
                        "[mailbox %s] Skipping malformed transcript line",
                        record.mailbox_id,
                    )
    except OSError:
        logger.warning(
            "[mailbox %s] Could not read transcript", record.mailbox_id, exc_info=True
        )
        return []
    if limit is not None and len(out) > limit:
        return out[-limit:]
    return out


# ---------------------------------------------------------------------------
# The protocol brief — what each session is told at kickoff
# ---------------------------------------------------------------------------

def _monitor_command(mailbox_path: pathlib.Path, handle: str) -> str:
    """The shell command a participant passes to its Monitor tool.

    Two rules from Monitor's own contract are load-bearing here:

    * ``grep`` needs ``--line-buffered`` or matches sit in its pipe buffer and
      the session is never pinged.
    * The filter must match TERMINAL states, not just the happy path — "silence
      is not success".  Hence ``"type":"control"`` is in the alternation
      unconditionally: ``paused``, ``resumed`` and ``end`` reach every
      participant even though they are addressed to nobody.
    """
    return (
        f'tail -n 0 -F "{mailbox_path}" | '
        f"grep --line-buffered -E "
        f"'\"to\":\"({handle}|\\*)\"|\"type\":\"control\"'"
    )


def _post_snippet(base_url: str, mailbox_id: str, handle: str) -> str:
    return (
        f"  1. Write your message to a scratch file as JSON, e.g. `msg.json`:\n"
        f'       {{"from": "{handle}", "to": "<recipient handle or *>", '
        f'"ack": <seq you are replying to, or null>, '
        f'"done": false, "body": "<your message>"}}\n'
        f"  2. Send it:\n"
        f"       curl -sS -X POST {base_url}/api/bridge/mb/{mailbox_id}/post \\\n"
        f'         -H "Content-Type: application/json" --data-binary @msg.json\n'
    )


def _brief(
    record: _MailboxRecord,
    me: _Participant,
    base_url: str,
) -> str:
    """The full protocol contract written to disk for one participant."""
    peers = [p for p in record.participants.values() if p.handle != me.handle]
    peer_lines = "\n".join(
        f'  - `{p.handle}` — session "{p.name}" ({p.role})' for p in peers
    )

    if me.role == "lead":
        role_para = (
            "You are the **LEAD**. You own the objective: break it down, assign\n"
            "work to the workers, review what comes back, and decide when the job\n"
            "is actually finished. Address a single worker by its handle, or use\n"
            '`"to": "*"` to broadcast to all of them.'
        )
    else:
        role_para = (
            f'You are a **WORKER**. Your lead is `lead` (session "{record.lead.name}").\n'
            "Do the work it assigns, then report back. Ask the lead if you are\n"
            'blocked or the instruction is ambiguous — send to `"to": "lead"`.'
        )

    return f"""# Peer bridge — you are `{me.handle}`

{role_para}

## Objective

{record.topic}

## Participants

{peer_lines}

## How this works

You and the other sessions share one append-only file:

    {record.mailbox_path}

You do NOT poll it and you do NOT read it on a timer. **Arm a watcher once**,
right now, and the file will ping you whenever anyone posts:

    Monitor(
      command: {_monitor_command(record.mailbox_path, me.handle)},
      description: "peer bridge {record.mailbox_id} — messages for {me.handle}",
      persistent: true,
    )

Each new line addressed to you (or broadcast with `"to": "*"`) arrives as an
event. Read its `body`, do the work, then reply.

If your watcher ever exits, re-arm it with the exact command above.

## Sending

{_post_snippet(base_url, record.mailbox_id, me.handle)}
The server assigns the `seq`. A successful post returns the new `seq`, the
bridge `state`, and `rounds_used` / `max_rounds`.

## Acknowledging

Every message addressed to you must be acknowledged. Set `"ack": <seq>` on the
reply you send back — a reply IS the acknowledgement, there is no separate
step. If you have nothing to say but must acknowledge (e.g. "understood,
starting"), post a one-line body with the `ack` set.

**An unacknowledged message blocks completion.** The bridge cannot finish while
anyone is still owed a reply.

## Finishing

Set `"done": true` on a post when you believe the objective is met.

- The bridge ends only when **every** participant has `done: true` **and**
  nothing is unacknowledged. One session declaring done does not end it.
- Posting again with `"done": false` withdraws your declaration. If you said
  you were finished and then have more to say, just say it — that is handled.
- When the bridge ends you will receive a `{{"type":"control","event":"end"}}`
  line. Stop your watcher (`TaskStop`) when you see it.

## Control lines

Lines with `"type":"control"` are from the server, not a peer:

- `paused`  — the round cap was reached. **Stop posting.** A human has been
  asked whether to grant more rounds. Keep your watcher armed and wait.
- `resumed` — more rounds were granted. Continue where you left off.
- `end`     — the bridge is over. Stop your watcher and report to your user.

## Budget

{record.rounds_used}/{record.max_rounds} rounds used (one round = one posted
message, by anyone). At the cap the bridge pauses and asks the human — it does
not silently die — but be concise so you do not spend the budget on ceremony.
"""


def _kickoff_pointer(brief_path: pathlib.Path, handle: str) -> str:
    """The ONLY thing written into a session's PTY at start.

    Deliberately tiny and constant-size. The old bridge injected the whole
    framed prompt (and, past 2 KB, a file-handoff prompt instead) which is what
    made payload size a correctness concern on ConPTY. Here the payload is three
    lines regardless of how large the brief is.
    """
    return (
        f"[PEER BRIDGE] You have been enrolled in a peer bridge as `{handle}`.\n"
        f"Read {brief_path} in full, then follow it exactly — the first step is "
        f"arming the Monitor watcher it specifies.\n"
        f"Do not reply to this message; reply through the mailbox."
    )


# ---------------------------------------------------------------------------
# MailboxManager
# ---------------------------------------------------------------------------

class MailboxManager:
    """Owns every mailbox bridge in the process.

    Thread-safety: ``_bridges`` is only touched from the asyncio event loop.
    Each record additionally carries its own ``asyncio.Lock`` because a post
    mutates the accounting AND appends to the file, and two sessions replying at
    the same instant must not interleave those two steps.
    """

    def __init__(self) -> None:
        self._bridges: dict[str, _MailboxRecord] = {}
        self._gc_task: Optional[asyncio.Task] = None
        self._watchdog_task: Optional[asyncio.Task] = None

    # ------------------------------------------------------------------
    # Start
    # ------------------------------------------------------------------

    async def start(
        self,
        lead_id: str,
        worker_ids: list[str],
        topic: str,
        max_rounds: int = 12,
        base_url: str = "http://127.0.0.1:8420",
    ) -> dict:
        """Enrol one lead and N workers in a new mailbox bridge.

        Writes each participant's brief to disk, then injects a three-line
        pointer into each PTY. Returns ``{ok: True, mailbox_id, ...}`` or
        ``{ok: False, error}``.

        A kickoff write failure is fatal to the bridge: a session that never
        received its brief will never arm a watcher, and a bridge missing a
        participant would sit unacked until the human gate expires. We tear the
        whole thing down and say which session failed.
        """
        if not worker_ids:
            return {"ok": False, "error": "At least one worker is required"}
        if not topic.strip():
            return {"ok": False, "error": "A topic/objective is required"}
        if not MIN_ROUNDS <= max_rounds <= MAX_ROUNDS:
            return {
                "ok": False,
                "error": f"max_rounds must be between {MIN_ROUNDS} and {MAX_ROUNDS}",
            }

        all_ids = [lead_id] + list(worker_ids)
        if len(all_ids) != len(set(all_ids)):
            return {"ok": False, "error": "Duplicate terminal IDs among participants"}

        # Validate every session BEFORE creating anything on disk.
        sessions = {}
        for tid in all_ids:
            s = pty_manager.get_terminal(tid)
            if s is None or not s.alive:
                return {"ok": False, "error": f"Session {tid!r} not found or dead"}
            sessions[tid] = s

        mailbox_id = uuid.uuid4().hex[:12]
        directory = _MAILBOX_ROOT / f"bridge-{mailbox_id}"

        participants: dict[str, _Participant] = {
            "lead": _Participant(
                handle="lead",
                terminal_id=lead_id,
                name=sessions[lead_id].name,
                role="lead",
            )
        }
        for idx, wid in enumerate(worker_ids, start=1):
            handle = f"w{idx}"
            participants[handle] = _Participant(
                handle=handle,
                terminal_id=wid,
                name=sessions[wid].name,
                role="worker",
            )

        record = _MailboxRecord(
            mailbox_id=mailbox_id,
            directory=directory,
            participants=participants,
            max_rounds=max_rounds,
            topic=topic.strip(),
        )

        try:
            await asyncio.to_thread(directory.mkdir, parents=True, exist_ok=True)
            await asyncio.to_thread(record.mailbox_path.touch)
        except OSError as exc:
            logger.warning(
                "[mailbox %s] Could not create bridge directory", mailbox_id, exc_info=True
            )
            return {"ok": False, "error": f"Could not create mailbox directory: {exc}"}

        # Write each participant's brief, then inject its pointer.
        briefs: dict[str, pathlib.Path] = {}
        for handle, p in participants.items():
            brief_path = directory / f"brief-{handle}.md"
            try:
                await asyncio.to_thread(
                    brief_path.write_text, _brief(record, p, base_url), "utf-8"
                )
            except OSError as exc:
                await self._discard(record)
                return {"ok": False, "error": f"Could not write brief: {exc}"}
            briefs[handle] = brief_path

        self._bridges[mailbox_id] = record

        logger.info(
            "[mailbox %s] Starting: lead=%s (%s), workers=%s, max_rounds=%d, dir=%s",
            mailbox_id,
            lead_id,
            sessions[lead_id].name,
            [(p.handle, p.name) for p in participants.values() if p.role == "worker"],
            max_rounds,
            directory,
        )

        results = await asyncio.gather(
            *(
                _paste_and_submit(p.terminal_id, _kickoff_pointer(briefs[h], h))
                for h, p in participants.items()
            ),
            return_exceptions=True,
        )

        for (handle, p), result in zip(participants.items(), results):
            if isinstance(result, BaseException) or not result:
                logger.warning(
                    "[mailbox %s] Kickoff write failed for %s (%s) — aborting",
                    mailbox_id,
                    handle,
                    p.name,
                    exc_info=result if isinstance(result, BaseException) else None,
                )
                await self._end(
                    record,
                    "errored",
                    reason=f"Kickoff write failed for session {p.name!r}",
                )
                return {
                    "ok": False,
                    "error": f"Kickoff write failed for session {p.name!r}",
                }

        self._ensure_background()
        return {"ok": True, **record.to_dict()}

    # ------------------------------------------------------------------
    # Post
    # ------------------------------------------------------------------

    async def post(
        self,
        mailbox_id: str,
        sender: str,
        to: str,
        body: str,
        ack: int | None = None,
        done: bool = False,
    ) -> dict:
        """Append one participant message to the mailbox.

        This is the only way a session speaks. Returns ``{ok: True, seq, state,
        rounds_used, max_rounds}``; on refusal ``{ok: False, error, state}`` with
        a ``status`` hint the route turns into an HTTP code.

        Ordering matters and is enforced by the record lock: the round cap is
        checked, the seq is assigned, the accounting is updated and the line is
        appended as one indivisible step. Checking the cap outside the lock
        would let N simultaneous posts all observe ``rounds_used < max_rounds``
        and blow past it together.
        """
        record = self._bridges.get(mailbox_id)
        if record is None:
            return {"ok": False, "error": "Bridge not found", "status": 404}

        if not _validate_handle(sender):
            return {"ok": False, "error": f"Invalid sender handle {sender!r}", "status": 400}
        if sender not in record.participants:
            return {"ok": False, "error": f"Unknown sender handle {sender!r}", "status": 400}
        if to != "*" and to not in record.participants:
            return {"ok": False, "error": f"Unknown recipient {to!r}", "status": 400}
        if to == sender:
            return {"ok": False, "error": "Cannot address yourself", "status": 400}
        if not isinstance(body, str) or not body.strip():
            return {"ok": False, "error": "body must be a non-empty string", "status": 400}

        async with record._lock:
            if record.state in _TERMINAL_STATES:
                return {
                    "ok": False,
                    "error": f"Bridge has ended ({record.state})",
                    "state": record.state,
                    "status": 409,
                }
            if record.state == "awaiting_human":
                return {
                    "ok": False,
                    "error": (
                        "Round cap reached — the bridge is paused awaiting a human "
                        "decision. Keep your watcher armed and wait for a "
                        "'resumed' control line."
                    ),
                    "state": record.state,
                    "rounds_used": record.rounds_used,
                    "max_rounds": record.max_rounds,
                    "status": 409,
                }

            me = record.participants[sender]

            # Clear the acknowledgement this post answers. An ack for a seq the
            # sender was never owed is not an error — it is a model being
            # over-helpful — so it is ignored rather than refused.
            if ack is not None:
                record._unacked.discard((int(ack), sender))

            record.seq += 1
            record.rounds_used += 1
            seq = record.seq

            # `done` is recomputed on every post, so a substantive follow-up
            # after a done-declaration withdraws it. See module docstring.
            me.done = bool(done)
            me.posts += 1
            me.last_post_at = time.monotonic()

            # Agreement is evaluated against what was outstanding BEFORE this
            # post, and the post's own recipients are only put on the hook if
            # the bridge is still going.
            #
            # Otherwise the protocol cannot terminate: the message that
            # completes the agreement would itself be unacknowledged, requiring
            # an ack, whose message would itself be unacknowledged, forever. A
            # closing "agreed, we're done" is a closing statement, not a
            # question, and nobody owes it a reply.
            agreed = self._all_agreed(record)
            if not agreed:
                recipients = (
                    [h for h in record.participants if h != sender]
                    if to == "*"
                    else [to]
                )
                for h in recipients:
                    record._unacked.add((seq, h))

            line = {
                "seq": seq,
                "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "type": "msg",
                "from": sender,
                "from_name": me.name,
                "to": to,
                "ack": ack,
                "done": me.done,
                "body": body,
            }
            try:
                await asyncio.to_thread(_append_line, record.mailbox_path, line)
            except OSError as exc:
                logger.warning(
                    "[mailbox %s] Append failed", mailbox_id, exc_info=True
                )
                return {"ok": False, "error": f"Mailbox write failed: {exc}", "status": 500}

            # Completion beats the cap: a post that finishes the job should end
            # the bridge cleanly even if it happened to be the last round.
            if agreed:
                await self._end(record, "ended_agreed", locked=True)
            elif record.rounds_used >= record.max_rounds:
                await self._pause(record)

            return {
                "ok": True,
                "seq": seq,
                "state": record.state,
                "rounds_used": record.rounds_used,
                "max_rounds": record.max_rounds,
                "unacked": record.unacked_for(sender),
            }

    @staticmethod
    def _all_agreed(record: _MailboxRecord) -> bool:
        """True when every participant is done and nothing is owed a reply.

        BOTH clauses are required and the second is the one that matters. Agents
        converge on "sounds good, done" readily; without the unacked check a
        bridge could complete with a question still sitting unanswered in the
        mailbox, which is precisely the "lack lustre" outcome of the old design
        in a new costume.
        """
        return (
            all(p.done for p in record.participants.values())
            and not record._unacked
        )

    # ------------------------------------------------------------------
    # Pause / extend / end
    # ------------------------------------------------------------------

    async def _pause(self, record: _MailboxRecord) -> None:
        """Enter ``awaiting_human`` and tell every session to stand down."""
        if record.state != "active":
            return
        record.state = "awaiting_human"
        record._paused_at = time.monotonic()
        await self._control(
            record,
            "paused",
            (
                f"Round cap reached ({record.rounds_used}/{record.max_rounds}). "
                "Stop posting. A human has been asked whether to grant more "
                "rounds. Keep your watcher armed."
            ),
        )
        logger.info(
            "[mailbox %s] Paused at round cap %d — awaiting human",
            record.mailbox_id,
            record.max_rounds,
        )

    async def extend(self, mailbox_id: str, additional: int) -> dict:
        """Grant *additional* rounds and resume a paused bridge.

        Also accepted while ``active`` (raising the ceiling pre-emptively), but
        refused once the bridge has reached a terminal state — resurrecting a
        finished conversation would leave every session's watcher un-armed with
        no way to tell them to re-arm.
        """
        record = self._bridges.get(mailbox_id)
        if record is None:
            return {"ok": False, "error": "Bridge not found", "status": 404}
        if not isinstance(additional, int) or not MIN_ROUNDS <= additional <= MAX_ROUNDS:
            return {
                "ok": False,
                "error": f"additional must be between {MIN_ROUNDS} and {MAX_ROUNDS}",
                "status": 400,
            }

        async with record._lock:
            if record.state in _TERMINAL_STATES:
                return {
                    "ok": False,
                    "error": f"Bridge has ended ({record.state})",
                    "state": record.state,
                    "status": 409,
                }

            was_paused = record.state == "awaiting_human"
            record.max_rounds = min(record.max_rounds + additional, MAX_ROUNDS)
            record.state = "active"
            record._paused_at = None

            if was_paused:
                await self._control(
                    record,
                    "resumed",
                    (
                        f"{additional} more round(s) granted "
                        f"({record.rounds_used}/{record.max_rounds} used). "
                        "Continue where you left off."
                    ),
                )
            logger.info(
                "[mailbox %s] Extended by %d → max_rounds=%d",
                record.mailbox_id,
                additional,
                record.max_rounds,
            )
            return {"ok": True, **record.to_dict()}

    async def _control(self, record: _MailboxRecord, event: str, message: str) -> None:
        """Append a server control line.

        Control lines carry no ``to`` field on purpose: every participant's
        Monitor filter matches ``"type":"control"`` unconditionally, so pause,
        resume and end always reach everyone regardless of addressing.
        """
        record.seq += 1
        line = {
            "seq": record.seq,
            "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "type": "control",
            "event": event,
            "message": message,
        }
        try:
            await asyncio.to_thread(_append_line, record.mailbox_path, line)
        except OSError:
            logger.warning(
                "[mailbox %s] Could not append control line %r",
                record.mailbox_id,
                event,
                exc_info=True,
            )

    async def _end(
        self,
        record: _MailboxRecord,
        new_state: str,
        reason: str | None = None,
        locked: bool = False,
    ) -> None:
        """Move a bridge to a terminal state. Idempotent.

        *locked* says the caller already holds ``record._lock`` — ``post`` ends
        the bridge from inside its own critical section, and re-acquiring a
        non-reentrant ``asyncio.Lock`` there would deadlock.
        """
        async def _do() -> None:
            if record.state in _TERMINAL_STATES:
                return
            record.state = new_state
            record.end_reason = reason
            record._ended_at = time.monotonic()
            await self._control(
                record,
                "end",
                reason or f"Bridge ended ({new_state}). Stop your watcher.",
            )
            logger.info(
                "[mailbox %s] Ended state=%s rounds=%d/%d reason=%s",
                record.mailbox_id,
                new_state,
                record.rounds_used,
                record.max_rounds,
                reason,
            )

        if locked:
            await _do()
        else:
            async with record._lock:
                await _do()

    async def stop(self, mailbox_id: str, reason: str | None = None) -> bool:
        """User-initiated stop. True if the bridge exists."""
        record = self._bridges.get(mailbox_id)
        if record is None:
            return False
        await self._end(record, "ended_user", reason=reason or "Stopped by the user.")
        return True

    async def _discard(self, record: _MailboxRecord) -> None:
        """Remove a half-built bridge's directory (start() failure path only)."""
        self._bridges.pop(record.mailbox_id, None)
        try:
            await asyncio.to_thread(shutil.rmtree, record.directory, True)
        except Exception:
            logger.debug("Could not discard mailbox dir", exc_info=True)

    # ------------------------------------------------------------------
    # Reads
    # ------------------------------------------------------------------

    def get(self, mailbox_id: str) -> Optional[_MailboxRecord]:
        return self._bridges.get(mailbox_id)

    def list_active(self) -> list[dict]:
        """Every known bridge, live and recently ended."""
        return [r.to_dict() for r in self._bridges.values()]

    def member_ids(self) -> set[str]:
        """Terminal IDs enrolled in a bridge that is not finished.

        ``awaiting_human`` counts as enrolled — the sessions are still holding
        the conversation and a second bridge writing into them would corrupt it.
        """
        ids: set[str] = set()
        for record in self._bridges.values():
            if record.state not in _TERMINAL_STATES:
                ids |= record.terminal_ids
        return ids

    # ------------------------------------------------------------------
    # Background: watchdog + GC
    # ------------------------------------------------------------------

    def _ensure_background(self) -> None:
        if self._gc_task is None or self._gc_task.done():
            self._gc_task = asyncio.create_task(self._gc_loop(), name="mailbox-gc")
        if self._watchdog_task is None or self._watchdog_task.done():
            self._watchdog_task = asyncio.create_task(
                self._watchdog_loop(), name="mailbox-watchdog"
            )

    async def _watchdog_loop(self) -> None:
        """Nudge participants that appear to have lost their watcher.

        This is a REPAIR path, not the delivery path — the distinction is the
        whole point of the design. A nudge is one short line into the PTY, sent
        only when a participant owes a reply, its session is idle (so it is not
        merely busy working), and it has been that way for ``_NUDGE_AFTER``. It
        is capped at ``_MAX_NUDGES`` per participant because a session that
        ignored two nudges will ignore a third, and repeated injection is the
        PTY hammering this protocol exists to avoid.

        Also enforces the human gate: a bridge nobody answers cannot pause
        forever, because a paused bridge pins its sessions against the conflict
        guard.
        """
        while True:
            try:
                await asyncio.sleep(_WATCHDOG_INTERVAL)
                now = time.monotonic()
                for record in list(self._bridges.values()):
                    if record.state == "awaiting_human":
                        if (
                            record._paused_at is not None
                            # >= not >: time.monotonic() is coarse on Windows
                            # (GetTickCount64, ~15ms), so a zero gate — which
                            # the tests use — can measure an elapsed 0.0.
                            and (now - record._paused_at) >= _HUMAN_GATE_MAX
                        ):
                            await self._end(
                                record,
                                "ended_capped",
                                reason=(
                                    "Round cap reached and no one granted more "
                                    f"rounds within {int(_HUMAN_GATE_MAX / 60)} minutes."
                                ),
                            )
                        continue
                    if record.state != "active":
                        continue

                    # A dead participant is fatal — the remaining sessions would
                    # wait on an acknowledgement that can never arrive.
                    for p in record.participants.values():
                        session = pty_manager.get_terminal(p.terminal_id)
                        if session is None or not session.alive:
                            await self._end(
                                record,
                                "errored",
                                reason=f'Session "{p.name}" is no longer running.',
                            )
                            break
                    else:
                        await self._nudge_stalled(record, now)
            except asyncio.CancelledError:
                break
            except Exception:
                logger.warning("Mailbox watchdog error", exc_info=True)

    async def _nudge_stalled(self, record: _MailboxRecord, now: float) -> None:
        for p in record.participants.values():
            owed = record.unacked_for(p.handle)
            if not owed:
                continue
            if p.nudges >= _MAX_NUDGES:
                continue
            session = pty_manager.get_terminal(p.terminal_id)
            if session is None or session.tracker.state != "idle":
                # Busy means it is working on the reply — leave it alone.
                continue
            since = now - (p.last_post_at or record._created_at)
            if since < _NUDGE_AFTER:
                continue
            p.nudges += 1
            p.last_post_at = now
            logger.info(
                "[mailbox %s] Nudging %s (%s) — %d unacked, nudge %d/%d",
                record.mailbox_id,
                p.handle,
                p.name,
                len(owed),
                p.nudges,
                _MAX_NUDGES,
            )
            await _paste_and_submit(
                p.terminal_id,
                (
                    f"[PEER BRIDGE] You have unread message(s) "
                    f"(seq {', '.join(str(s) for s in owed)}) in "
                    f"{record.mailbox_path}. Your watcher may not be armed — "
                    f"re-read the brief at {record.directory / f'brief-{p.handle}.md'} "
                    f"and re-arm it, then reply."
                ),
            )

    async def _gc_loop(self) -> None:
        """Drop terminal records and their directories after ``_RECORD_TTL``."""
        while True:
            try:
                await asyncio.sleep(_GC_INTERVAL)
                now = time.monotonic()
                expired = [
                    mid
                    for mid, rec in self._bridges.items()
                    if rec.state in _TERMINAL_STATES
                    and rec._ended_at is not None
                    and (now - rec._ended_at) > _RECORD_TTL
                ]
                for mid in expired:
                    record = self._bridges.pop(mid)
                    await asyncio.to_thread(shutil.rmtree, record.directory, True)
                    logger.debug("[mailbox GC] Removed expired bridge %s", mid)
            except asyncio.CancelledError:
                break
            except Exception:
                logger.warning("Mailbox GC loop error", exc_info=True)


def cleanup_mailbox_root() -> None:
    """Remove every mailbox directory (graceful shutdown)."""
    shutil.rmtree(_MAILBOX_ROOT, ignore_errors=True)


mailbox_manager = MailboxManager()
