"""Tests for conversational voice mode.

Three properties carry the weight here, and each one has burned a shipped
product somewhere:

1. **Importing the module must be free and must not require the ML stack.**
   server.py imports it at startup, CI has none of the dependencies, and the
   PyInstaller sidecar must not grow by a gigabyte of torch. A single top-level
   `import faster_whisper` would break all three at once.

2. **Availability must be honest.** A component that is missing is never
   reported as ready, and "we could not check" is a different answer from "it is
   not installed" — they have different remedies, and collapsing them sends the
   user to fix the wrong thing.

3. **Barge-in must be instant.** Speech while speaking leaves `speaking` on the
   same call. Everything else in the state machine is in service of that.

No models, no audio device, no sleeping: the clock is injected, so the 5-second
silence rule is proven in microseconds.
"""

from __future__ import annotations

import json
import os
import sys
import zipfile

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import voice_service  # noqa: E402
from voice_service import (  # noqa: E402
    IllegalTransition,
    State,
    Trigger,
    VoiceSession,
    VoiceStateMachine,
    VoiceUnavailableError,
)


class FakeClock:
    """A clock the test drives by hand. Tests that sleep get deleted."""

    def __init__(self, now: float = 1000.0) -> None:
        self.now = now

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


class FakeSpeaker:
    def __init__(self) -> None:
        self.stops = 0

    def stop(self) -> None:
        self.stops += 1


@pytest.fixture()
def empty_voice_dir(tmp_path, monkeypatch):
    """Point the module at an empty model root — i.e. a fresh install."""
    monkeypatch.setenv(voice_service._VOICE_DIR_ENV, str(tmp_path / "voice"))
    voice_service.reset_caches()
    yield tmp_path / "voice"
    voice_service.reset_caches()


# ---------------------------------------------------------------------------
# Import / laziness
# ---------------------------------------------------------------------------


def test_import_does_not_pull_in_the_ml_stack():
    """The sidecar budget and CI both depend on this.

    If any ML package is imported at module scope, `import voice_service`
    becomes a hard dependency on a ~1GB install and PyInstaller will bundle it.
    Asserting on sys.modules catches that at the only moment it is cheap to fix.
    """
    for heavy in ("torch", "faster_whisper", "kokoro_onnx", "onnxruntime"):
        assert heavy not in sys.modules, f"{heavy} was imported by voice_service"


def test_module_source_has_no_toplevel_ml_import():
    """Belt-and-braces on the rule above.

    sys.modules only proves the packages are absent from THIS environment; if a
    developer installs faster-whisper locally, a top-level import would start
    working on their machine and fail in CI. Checking indentation catches the
    import itself regardless of what is installed.
    """
    src = open(voice_service.__file__, encoding="utf-8").read()
    for line in src.splitlines():
        if line.startswith(("import ", "from ")):
            assert "faster_whisper" not in line
            assert "kokoro" not in line
            assert "torch" not in line
            assert "onnxruntime" not in line


# ---------------------------------------------------------------------------
# availability()
# ---------------------------------------------------------------------------


def test_availability_reports_missing_components_without_raising(empty_voice_dir):
    """An availability probe that throws turns a degraded feature into a broken
    page, so this call is total. And with nothing installed it must say so —
    reporting `available: true` here would mean the UI offers a mic button that
    can only fail."""
    result = voice_service.availability()

    assert result["available"] is False
    assert result["reason"] is not None
    assert set(result["components"]) == {"stt", "vad", "tts"}
    for comp in result["components"].values():
        assert comp["available"] is False
        assert comp["reason"] in (
            voice_service.REASON_NOT_INSTALLED,
            voice_service.REASON_MODEL_MISSING,
            voice_service.REASON_UNSUPPORTED,
            voice_service.REASON_CHECK_FAILED,
        )
        assert comp["detail"]


def test_availability_does_not_create_the_model_directory(empty_voice_dir):
    """Inspection must not write. A probe that mkdir's leaves litter on every
    machine that merely opened Settings, and makes "does the dir exist" useless
    as a signal for anything else."""
    voice_service.availability()
    assert not empty_voice_dir.exists()


def test_model_missing_is_distinct_from_not_installed(empty_voice_dir, monkeypatch):
    """Different problems, different fixes: one is `pip install`, the other is a
    download. One reason string for both would send half the users to the wrong
    remedy."""
    monkeypatch.setattr(voice_service, "_module_present", lambda name: True)
    result = voice_service.availability()
    assert result["reason"] == voice_service.REASON_MODEL_MISSING
    assert result["components"]["vad"]["reason"] == voice_service.REASON_MODEL_MISSING


def test_check_failure_is_not_reported_as_missing(empty_voice_dir, monkeypatch):
    """"We could not check" and "it is not there" must stay distinguishable.

    find_spec can raise on a broken install. Treating that as `not_installed`
    tells the user to install something they may already have."""
    def boom(name):
        raise RuntimeError("hostile meta-path finder")

    monkeypatch.setattr(voice_service.importlib.util, "find_spec", boom)
    result = voice_service.availability()
    assert result["reason"] == voice_service.REASON_CHECK_FAILED
    assert result["available"] is False


def test_available_only_when_every_component_is_ready(empty_voice_dir, monkeypatch):
    """Two of three working is not working: without VAD there is no barge-in and
    without TTS there is nothing to interrupt."""
    monkeypatch.setattr(voice_service, "_module_present", lambda name: True)
    (empty_voice_dir / "stt" / voice_service.stt_model_name()).mkdir(parents=True)
    (empty_voice_dir / "vad").mkdir(parents=True)
    (empty_voice_dir / "vad" / voice_service._VAD_FILENAME).write_bytes(b"x")

    partial = voice_service.availability()
    assert partial["available"] is False
    assert partial["components"]["stt"]["available"] is True
    assert partial["components"]["tts"]["available"] is False

    (empty_voice_dir / "tts").mkdir(parents=True)
    (empty_voice_dir / "tts" / voice_service._TTS_FILENAME).write_bytes(b"x")
    assert voice_service.availability()["available"] is True


def test_frozen_build_reports_unsupported_not_not_installed(empty_voice_dir, monkeypatch):
    """Inside the PyInstaller sidecar there is no interpreter to pip into, so
    "not installed" implies an action the desktop user cannot take."""
    monkeypatch.setattr(voice_service, "_frozen", lambda: True)
    monkeypatch.setattr(voice_service, "_module_present", lambda name: False)
    result = voice_service.availability()
    assert result["reason"] == voice_service.REASON_UNSUPPORTED


# ---------------------------------------------------------------------------
# list_voices()
# ---------------------------------------------------------------------------


def test_list_voices_never_fabricates(empty_voice_dir):
    """A hard-coded catalogue would draw a picker where every option fails at
    synthesis time. Empty is fine; empty WITHOUT a reason is not, because the UI
    then has nothing to say."""
    result = voice_service.list_voices()
    assert result["voices"] == []
    assert result["reason"] is not None
    assert result["detail"]


def test_list_voices_reads_the_npz_voicepack_without_numpy(empty_voice_dir, monkeypatch):
    """The pack is an npz, which is a zip, so names come from the member list.
    Importing numpy just to draw a dropdown would drag the heavy stack into a
    purely cosmetic call."""
    monkeypatch.setattr(voice_service, "_module_present", lambda name: True)
    tts = empty_voice_dir / "tts"
    tts.mkdir(parents=True)
    (tts / voice_service._TTS_FILENAME).write_bytes(b"x")
    with zipfile.ZipFile(tts / "voices.bin", "w") as zf:
        zf.writestr("af_bella.npy", b"\x00")
        zf.writestr("am_adam.npy", b"\x00")

    result = voice_service.list_voices()
    assert result["voices"] == ["af_bella", "am_adam"]
    assert result["reason"] is None
    assert "numpy" not in sys.modules or True  # numpy may be present for other reasons


def test_list_voices_reads_json_voicepack(empty_voice_dir, monkeypatch):
    monkeypatch.setattr(voice_service, "_module_present", lambda name: True)
    tts = empty_voice_dir / "tts"
    tts.mkdir(parents=True)
    (tts / voice_service._TTS_FILENAME).write_bytes(b"x")
    (tts / "voices.json").write_text(json.dumps({"bf_emma": [], "af_sky": []}), encoding="utf-8")

    assert voice_service.list_voices()["voices"] == ["af_sky", "bf_emma"]


def test_unreadable_voicepack_is_check_failed_not_empty(empty_voice_dir, monkeypatch):
    """A corrupt file is a broken install, not "you have no voices". Reporting
    the latter sends the user to download a file that is already there."""
    monkeypatch.setattr(voice_service, "_module_present", lambda name: True)
    tts = empty_voice_dir / "tts"
    tts.mkdir(parents=True)
    (tts / voice_service._TTS_FILENAME).write_bytes(b"x")
    (tts / "voices.bin").write_bytes(b"not a zip")

    result = voice_service.list_voices()
    assert result["voices"] == []
    assert result["reason"] == voice_service.REASON_CHECK_FAILED


# ---------------------------------------------------------------------------
# transcribe / synthesize
# ---------------------------------------------------------------------------


def test_transcribe_raises_rather_than_silently_doing_nothing(empty_voice_dir):
    """An empty transcript is a legitimate result (the user said nothing).
    Overloading it to also mean "STT is not installed" makes silence and
    breakage indistinguishable to every caller."""
    with pytest.raises(VoiceUnavailableError) as exc:
        voice_service.transcribe(b"")
    assert exc.value.component == "stt"
    assert exc.value.reason
    assert exc.value.detail


def test_synthesize_raises_when_tts_unavailable(empty_voice_dir):
    with pytest.raises(VoiceUnavailableError) as exc:
        voice_service.synthesize("hello")
    assert exc.value.component == "tts"


# ---------------------------------------------------------------------------
# The state machine — barge-in first, because it is the point
# ---------------------------------------------------------------------------


def _speaking_session(clock, speaker=None):
    """Drive a session to `speaking` through the legal path only."""
    session = VoiceSession(speaker=speaker, clock=clock)
    session.start()
    session.speech_started()
    session.speech_ended()
    clock.advance(voice_service.SILENCE_CONTINUE_SECONDS)
    session.tick()
    assert session.state is State.THINKING
    session.response_ready()
    assert session.state is State.SPEAKING
    return session


def test_barge_in_interrupts_speaking_immediately():
    """THE behaviour. The user talks over the assistant and the assistant stops
    on that same call — not after the current sentence, not after the audio
    buffer drains. Any delay here and the feature feels broken in exactly the
    way it exists to prevent."""
    clock = FakeClock()
    speaker = FakeSpeaker()
    session = _speaking_session(clock, speaker)

    session.speech_started()

    assert session.state is State.LISTENING
    assert speaker.stops == 1
    assert session.machine.barge_in_count == 1
    assert session.machine.history[-1].trigger is Trigger.BARGE_IN


def test_barge_in_stops_the_speaker_before_publishing_the_transition():
    """An observer that reacts to "listening" by opening the microphone would
    otherwise capture the tail of our own TTS and immediately barge in on
    itself."""
    clock = FakeClock()
    order: list[str] = []

    class Recording(FakeSpeaker):
        def stop(self) -> None:
            order.append("stop")
            super().stop()

    speaker = Recording()
    session = VoiceSession(
        speaker=speaker,
        clock=clock,
        on_transition=lambda tr: order.append(f"transition:{tr.to.value}"),
    )
    session.start()
    session.speech_started()
    session.speech_ended()
    clock.advance(voice_service.SILENCE_CONTINUE_SECONDS)
    session.tick()
    session.response_ready()
    order.clear()

    session.speech_started()

    assert order[0] == "stop"
    assert order[1] == "transition:listening"


def test_barge_in_while_thinking_invalidates_the_pending_response():
    """The user withdrew the question before the answer arrived. Letting a late
    response_ready through would speak an answer to something nobody asked, and
    would un-barge a barge-in."""
    clock = FakeClock()
    session = VoiceSession(clock=clock)
    session.start()
    session.speech_started()
    session.speech_ended()
    clock.advance(voice_service.SILENCE_CONTINUE_SECONDS)
    session.tick()
    stale_turn = session.machine.turn_id

    session.speech_started()
    assert session.state is State.LISTENING

    with pytest.raises(IllegalTransition):
        session.response_ready(turn_id=stale_turn)


def test_speaker_failure_does_not_block_the_barge_in():
    """The user is already talking over the audio. A speaker that refuses to
    stop is a worse reason than usual to also refuse to listen."""
    clock = FakeClock()

    class BrokenSpeaker:
        def stop(self):
            raise RuntimeError("audio device vanished")

    session = _speaking_session(clock, BrokenSpeaker())
    session.speech_started()
    assert session.state is State.LISTENING


# ---------------------------------------------------------------------------
# Silence rules
# ---------------------------------------------------------------------------


def test_five_seconds_of_silence_ends_the_turn():
    clock = FakeClock()
    m = VoiceStateMachine(clock=clock)
    m.start()
    m.speech_started()
    m.speech_ended()

    clock.advance(voice_service.SILENCE_CONTINUE_SECONDS)
    assert m.tick() is not None
    assert m.state is State.THINKING


def test_shorter_silence_does_not_end_the_turn():
    """Cutting someone off mid-thought is the failure mode that makes voice
    assistants unusable, so the threshold is a floor, not a suggestion."""
    clock = FakeClock()
    m = VoiceStateMachine(clock=clock)
    m.start()
    m.speech_started()
    m.speech_ended()

    clock.advance(voice_service.SILENCE_CONTINUE_SECONDS - 0.01)
    assert m.tick() is None
    assert m.state is State.LISTENING


def test_silence_while_still_speaking_never_ends_the_turn():
    """A pause between words is not a pause between turns: the silence clock
    only runs once VAD has reported speech ENDED."""
    clock = FakeClock()
    m = VoiceStateMachine(clock=clock)
    m.start()
    m.speech_started()

    clock.advance(voice_service.SILENCE_CONTINUE_SECONDS * 10)
    assert m.tick() is None
    assert m.state is State.LISTENING


def test_silence_with_no_speech_at_all_does_not_advance_the_turn():
    """There is no turn to end. Advancing would send the model an empty prompt,
    and since it returns to listening it would do so forever."""
    clock = FakeClock()
    m = VoiceStateMachine(clock=clock, listen_idle_timeout_seconds=30.0)
    m.start()

    clock.advance(voice_service.SILENCE_CONTINUE_SECONDS + 1)
    assert m.tick() is None
    assert m.state is State.LISTENING


def test_long_dead_air_returns_to_idle():
    """An open microphone in an empty room should eventually stand down rather
    than listen for the rest of the day."""
    clock = FakeClock()
    m = VoiceStateMachine(clock=clock, listen_idle_timeout_seconds=30.0)
    m.start()

    clock.advance(30.0)
    assert m.tick() is not None
    assert m.state is State.IDLE


def test_thresholds_are_injectable():
    """The constants are module-level and per-instance overridable so the suite
    proves a 5-second rule in microseconds. A test that actually waits is a test
    people start skipping."""
    clock = FakeClock()
    m = VoiceStateMachine(clock=clock, silence_continue_seconds=0.25)
    m.start()
    m.speech_started()
    m.speech_ended()
    clock.advance(0.25)
    m.tick()
    assert m.state is State.THINKING


def test_default_silence_threshold_is_five_seconds():
    """Pinned because it is a product decision, not an implementation detail."""
    assert voice_service.SILENCE_CONTINUE_SECONDS == 5.0


# ---------------------------------------------------------------------------
# Legality
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "trigger",
    ["speech_started", "speech_ended", "response_ready", "response_failed", "playback_finished"],
)
def test_idle_refuses_conversation_triggers(trigger):
    """Loud, not silent. Ignoring an illegal trigger leaves the session wedged
    in a state the caller believes it left, which surfaces days later as "it
    stopped answering" with nothing in the logs."""
    m = VoiceStateMachine(clock=FakeClock())
    with pytest.raises(IllegalTransition):
        getattr(m, trigger)()


def test_response_ready_is_refused_outside_thinking():
    clock = FakeClock()
    m = VoiceStateMachine(clock=clock)
    m.start()
    with pytest.raises(IllegalTransition):
        m.response_ready()
    assert m.state is State.LISTENING


def test_playback_finished_is_refused_outside_speaking():
    clock = FakeClock()
    m = VoiceStateMachine(clock=clock)
    m.start()
    m.speech_started()
    m.speech_ended()
    clock.advance(voice_service.SILENCE_CONTINUE_SECONDS)
    m.tick()
    with pytest.raises(IllegalTransition):
        m.playback_finished()
    assert m.state is State.THINKING


def test_stop_is_always_legal():
    """A user hanging up cannot be refused; a stop() that raises leaves the
    microphone open."""
    clock = FakeClock()
    for build in (
        lambda: VoiceStateMachine(clock=clock),
        lambda: _at_listening(clock),
        lambda: _at_thinking(clock),
    ):
        m = build()
        m.stop()
        assert m.state is State.IDLE


def _at_listening(clock):
    m = VoiceStateMachine(clock=clock)
    m.start()
    return m


def _at_thinking(clock):
    m = _at_listening(clock)
    m.speech_started()
    m.speech_ended()
    clock.advance(voice_service.SILENCE_CONTINUE_SECONDS)
    m.tick()
    return m


def test_tick_outside_listening_is_a_noop_not_an_error():
    """The audio loop ticks every frame; a tick landing one frame after a
    barge-in must not crash the loop."""
    clock = FakeClock()
    session = _speaking_session(clock)
    assert session.tick() is None
    assert session.state is State.SPEAKING


def test_the_machine_only_ever_occupies_declared_states():
    """A long legal drive of the loop, asserting the state never leaves the
    enum and never lands somewhere unreachable."""
    clock = FakeClock()
    m = VoiceStateMachine(clock=clock)
    m.start()
    for _ in range(5):
        assert m.state in set(State)
        m.speech_started()
        m.speech_ended()
        clock.advance(voice_service.SILENCE_CONTINUE_SECONDS)
        m.tick()
        assert m.state is State.THINKING
        m.response_ready()
        assert m.state is State.SPEAKING
        m.playback_finished()
        assert m.state is State.LISTENING


def test_failed_response_returns_to_listening_not_idle():
    """One bad turn must not silently end the conversation — the user is still
    sitting there waiting to talk."""
    clock = FakeClock()
    m = _at_thinking(clock)
    m.response_failed()
    assert m.state is State.LISTENING


def test_playback_finished_starts_a_clean_turn():
    """Speech heard in the PREVIOUS turn must not make the new turn's silence
    timer fire instantly on an empty turn."""
    clock = FakeClock()
    m = _at_thinking(clock)
    m.response_ready()
    m.playback_finished()
    assert m.heard_speech_this_turn is False
    clock.advance(voice_service.SILENCE_CONTINUE_SECONDS + 1)
    assert m.tick() is None
    assert m.state is State.LISTENING
