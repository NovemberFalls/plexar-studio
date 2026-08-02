"""Conversational voice mode: STT + VAD + TTS, with barge-in.

The user speaks, a model answers, TTS speaks the answer back, and the user can
INTERRUPT mid-sentence simply by talking (barge-in). Five seconds of silence is
the cue that the user's turn is over.

Why this module looks the way it does
-------------------------------------
1. **Nothing heavy is bundled.** The PyInstaller sidecar is ~48MB. torch is
   never imported here — inference is onnxruntime only — and model WEIGHTS are
   downloaded on first use into ``<data dir>/voice/``, never shipped in
   the installer. This module does not download them; see "does NOT" below.

2. **Every ML import is lazy.** They live inside the function that needs them,
   never at module scope. ``import voice_service`` must be free: no GPU probe,
   no network, no model load, and it must SUCCEED on a machine with none of the
   ML dependencies installed (which is every CI box and every fresh dev
   checkout). ``availability()`` is likewise pure inspection — it uses
   ``importlib.util.find_spec`` (which does not execute the package) plus
   ``Path.exists``.

3. **Honest envelope, house style.** ``availability()`` reports what is actually
   present. A missing component is never reported as available, "we could not
   check" (``check_failed``) is a DIFFERENT answer from "it is not installed",
   and anything we cannot measure is ``None`` with a reason rather than a
   plausible-looking zero. Same stance as ``anthropic_usage`` and
   ``pricing_store``.

4. **The state machine has no audio and no models in it.** ``VoiceStateMachine``
   is pure logic over an injected clock, so the conversation rules — above all
   barge-in — are testable with no microphone, no ONNX runtime, and no sleeping
   in real time. Audio capture/playback lives behind the small ``Speaker``
   protocol that ``VoiceSession`` calls. That separation is deliberate: barge-in
   is the behaviour most likely to regress and the least pleasant to test
   through a device.

Public interface (the contract)
-------------------------------
- ``availability() -> dict`` — ``{available, reason, detail, components:{stt,vad,tts}}``.
  Cheap, pure inspection, never raises, never touches the network.
- ``list_voices() -> dict`` — ``{voices, reason, detail, source}``. An empty list
  always carries a reason; the list is never fabricated.
- ``voice_dir() -> Path`` — resolved model root (does not create it).
- ``transcribe(audio, *, sample_rate=16000, language=None) -> Transcript``
  — lazily loads faster-whisper; raises ``VoiceUnavailableError`` if it cannot.
- ``synthesize(text, *, voice=None, speed=1.0) -> Synthesis``
  — lazily loads Kokoro; raises ``VoiceUnavailableError`` if it cannot.
- ``VoiceStateMachine`` — idle/listening/thinking/speaking, injected clock.
- ``VoiceSession`` — the state machine plus a ``Speaker`` it stops on barge-in.
- Exceptions: ``VoiceError`` → ``VoiceUnavailableError`` / ``IllegalTransition``.
- ``reset_caches()`` — drop memoized model handles (tests, and settings changes).

This module does NOT:
- download model weights (a downloader is a separate concern with its own
  progress reporting and cancellation; ``availability()`` deliberately reports
  ``model_missing`` rather than fetching 200MB behind the caller's back);
- own a microphone or a speaker — no sounddevice/pyaudio import lives here;
- call an LLM. ``thinking`` is a state, not an implementation: the caller
  drives the response and reports back with ``response_ready()``;
- expose FastAPI routes (that is server.py's job);
- persist anything. There is no state file; the session lives in memory.
"""

from __future__ import annotations

import importlib.util
import logging
import os
import sys
import threading
import time
import zipfile
from dataclasses import dataclass
from enum import Enum
from pathlib import Path
from typing import Any, Callable, Optional, Protocol, Sequence

import app_paths

logger = logging.getLogger("cockpit.voice")

__all__ = [
    "SILENCE_CONTINUE_SECONDS",
    "LISTEN_IDLE_TIMEOUT_SECONDS",
    "BARGE_IN_MIN_SPEECH_SECONDS",
    "State",
    "Trigger",
    "Transition",
    "VoiceError",
    "VoiceUnavailableError",
    "IllegalTransition",
    "VoiceStateMachine",
    "VoiceSession",
    "Speaker",
    "Transcript",
    "Synthesis",
    "availability",
    "list_voices",
    "voice_dir",
    "transcribe",
    "synthesize",
    "reset_caches",
]

# --------------------------------------------------------------------------
# Timing constants. Module-level and injectable (VoiceStateMachine takes both a
# clock and per-instance overrides) so tests exercise the rules without sleeping
# — a suite that spends 5 real seconds proving a 5-second rule is a suite people
# stop running.
# --------------------------------------------------------------------------

# The cue that the user's turn is over. Five seconds is long by dictation
# standards and deliberately so: this is conversation, and cutting someone off
# mid-thought is far more annoying than a beat of extra wait.
SILENCE_CONTINUE_SECONDS = 5.0

# Silence with NO speech at all yet is a different situation: there is nothing
# to transcribe, so advancing to `thinking` would send the model an empty turn.
# Instead we keep listening, and only after this much dead air give up to `idle`.
LISTEN_IDLE_TIMEOUT_SECONDS = 30.0

# Advisory for the VAD adapter, NOT enforced by the state machine. TTS output
# bleeding into an open microphone is the classic false barge-in, so the adapter
# should require this much confirmed speech before emitting `speech_started`
# while we are speaking. The state machine itself acts on the event INSTANTLY —
# adding a delay there would make barge-in feel broken, which is the one thing
# it must never feel.
BARGE_IN_MIN_SPEECH_SECONDS = 0.20

# --------------------------------------------------------------------------
# Filesystem layout. Weights live beside the rest of Cockpit's state, under the
# user's home — NOT next to the executable, which on Windows is a Program Files
# path the app cannot write to, and not in the installer.
# --------------------------------------------------------------------------

_VOICE_DIR_ENV = "COCKPIT_VOICE_DIR"
#: Resolved through app_paths, NOT hard-coded: this module was written before
#: the .claude-cockpit -> .plexar rename and kept its own literal, so it would
#: have downloaded several hundred MB of weights into the OLD data directory —
#: one the migration deliberately leaves alone. The user would then see voice
#: report "model_missing" forever while the files sat on disk under a name
#: nothing reads any more.
_DEFAULT_VOICE_DIR = app_paths.data_dir() / "voice"

# Env-overridable model identities. Whisper model size is the single biggest
# quality/latency lever, so it is a knob rather than a constant.
_STT_MODEL_ENV = "COCKPIT_VOICE_STT_MODEL"
_DEFAULT_STT_MODEL = "base.en"

_VAD_FILENAME = "silero_vad.onnx"
_TTS_FILENAME = "kokoro.onnx"
# kokoro-onnx ships voices either as an npz blob (.bin) or a plain json map.
# Both are supported; .bin wins if both exist because it is what the current
# releases publish.
_TTS_VOICES_FILENAMES = ("voices.bin", "voices.json")

# Package requirements per component. onnxruntime is the shared inference
# runtime; torch is absent from this table on purpose and must stay absent.
_COMPONENT_PACKAGES = {
    "stt": ("faster_whisper",),
    "vad": ("onnxruntime", "numpy"),
    "tts": ("kokoro_onnx", "onnxruntime", "numpy"),
}

# Reason vocabulary. These are contract values the UI switches on.
REASON_NOT_INSTALLED = "not_installed"   # a required package is absent
REASON_MODEL_MISSING = "model_missing"   # packages fine, weights not downloaded
REASON_UNSUPPORTED = "unsupported"       # this build/platform cannot ever run it
REASON_CHECK_FAILED = "check_failed"     # we could not determine — NOT "broken"

# Serializes lazy model construction. Two concurrent first-uses would otherwise
# each load a copy of the model into memory (hundreds of MB) and race on the
# cache slot. Guards _MODELS only; the loaded handles themselves are treated as
# read-only after construction.
_MODEL_LOCK = threading.Lock()
_MODELS: dict[str, Any] = {}


# --------------------------------------------------------------------------
# Exceptions
# --------------------------------------------------------------------------


class VoiceError(Exception):
    """Base for every error this module raises."""


class VoiceUnavailableError(VoiceError):
    """A voice component was asked to do work it cannot do.

    Carries the same ``reason``/``detail`` pair as ``availability()`` so a
    caller can render one message for both surfaces. Raised — never swallowed
    into a silent no-op, because a synthesize() that quietly returns nothing is
    indistinguishable from a model that produced silence.
    """

    def __init__(self, component: str, reason: str, detail: str) -> None:
        super().__init__(f"{component}: {reason}: {detail}")
        self.component = component
        self.reason = reason
        self.detail = detail


class IllegalTransition(VoiceError):
    """A trigger was fired in a state that does not accept it.

    Loud by design. Silently ignoring, say, ``response_ready`` while listening
    would leave the session wedged in a state the caller believes it left, and
    that failure mode is invisible until a user reports "it stopped answering".
    """

    def __init__(self, state: "State", trigger: "Trigger") -> None:
        super().__init__(f"cannot fire {trigger.value} while {state.value}")
        self.state = state
        self.trigger = trigger


# --------------------------------------------------------------------------
# Availability — pure inspection. No imports executed, no network, no downloads.
# --------------------------------------------------------------------------


def voice_dir() -> Path:
    """Resolve the model root. Does NOT create it — inspection must not write."""
    override = os.environ.get(_VOICE_DIR_ENV)
    return Path(override) if override else _DEFAULT_VOICE_DIR


def stt_model_name() -> str:
    return os.environ.get(_STT_MODEL_ENV) or _DEFAULT_STT_MODEL


def _stt_model_dir() -> Path:
    return voice_dir() / "stt" / stt_model_name()


def _vad_model_path() -> Path:
    return voice_dir() / "vad" / _VAD_FILENAME


def _tts_model_path() -> Path:
    return voice_dir() / "tts" / _TTS_FILENAME


def _tts_voices_path() -> Optional[Path]:
    base = voice_dir() / "tts"
    for name in _TTS_VOICES_FILENAMES:
        candidate = base / name
        try:
            if candidate.is_file():
                return candidate
        except OSError:
            logger.debug("voice: could not stat %s", candidate, exc_info=True)
    return None


def _module_present(name: str) -> Optional[bool]:
    """True/False if we know, None if the check itself failed.

    ``find_spec`` locates a package WITHOUT importing it, which is what keeps
    availability() free of side effects. It can still raise (a broken parent
    package, a hostile meta-path finder), and that is a third answer — "we could
    not check" — which must not be collapsed into "not installed".
    """
    try:
        return importlib.util.find_spec(name) is not None
    except Exception:
        logger.warning("voice: find_spec(%s) failed", name, exc_info=True)
        return None


def _path_exists(path: Path, *, directory: bool = False) -> Optional[bool]:
    try:
        return path.is_dir() if directory else path.is_file()
    except OSError:
        logger.warning("voice: could not stat %s", path, exc_info=True)
        return None


def _frozen() -> bool:
    """True inside the PyInstaller sidecar.

    Matters because the remedy differs: a dev can `pip install faster-whisper`,
    a desktop user running the bundled sidecar cannot — there is no interpreter
    to install into. Telling them "not installed" implies an action they have no
    way to take, so that case reports ``unsupported`` instead.
    """
    return bool(getattr(sys, "frozen", False))


def _component_status(
    component: str,
    *,
    model_checks: Sequence[tuple[str, Path, bool]],
) -> dict:
    """Build one component envelope.

    *model_checks* is a sequence of ``(label, path, is_directory)``. Every entry
    must be present for the component to be available; each is reported by name
    so the UI can say WHICH file is missing rather than a vague "model missing".
    """
    packages: dict[str, Any] = {}
    missing_packages: list[str] = []
    unknown_packages: list[str] = []
    for pkg in _COMPONENT_PACKAGES[component]:
        present = _module_present(pkg)
        packages[pkg] = present
        if present is None:
            unknown_packages.append(pkg)
        elif not present:
            missing_packages.append(pkg)

    models: dict[str, Any] = {}
    missing_models: list[str] = []
    unknown_models: list[str] = []
    for label, path, is_dir in model_checks:
        present = _path_exists(path, directory=is_dir)
        models[label] = {"path": str(path), "present": present}
        if present is None:
            unknown_models.append(label)
        elif not present:
            missing_models.append(label)

    if unknown_packages or unknown_models:
        # "We could not check" — explicitly not the same as "it is missing".
        reason = REASON_CHECK_FAILED
        detail = "Could not determine whether {} is installed.".format(
            ", ".join(unknown_packages + unknown_models)
        )
    elif missing_packages:
        if _frozen():
            reason = REASON_UNSUPPORTED
            detail = (
                "Voice support is not bundled in this desktop build "
                f"(missing: {', '.join(missing_packages)})."
            )
        else:
            reason = REASON_NOT_INSTALLED
            detail = f"Python package(s) not installed: {', '.join(missing_packages)}."
    elif missing_models:
        reason = REASON_MODEL_MISSING
        detail = (
            f"Model file(s) not downloaded yet: {', '.join(missing_models)}. "
            f"They are fetched on first use into {voice_dir()}."
        )
    else:
        reason = None
        detail = "Ready."

    return {
        "component": component,
        "available": reason is None,
        "reason": reason,
        "detail": detail,
        "packages": packages,
        "models": models,
    }


def availability() -> dict:
    """Report what voice mode can actually do, right now, on this machine.

    Cheap, side-effect free, and it NEVER raises: an availability probe that
    throws turns a degraded feature into a broken page. It reports only what is
    importable and what is on disk — it does not download, does not import the
    ML packages, and does not touch the network or the GPU.
    """
    try:
        components = {
            "stt": _component_status(
                "stt",
                model_checks=[("whisper_model", _stt_model_dir(), True)],
            ),
            "vad": _component_status(
                "vad",
                model_checks=[("silero_vad", _vad_model_path(), False)],
            ),
            "tts": _component_status(
                "tts",
                model_checks=[("kokoro", _tts_model_path(), False)],
            ),
        }
    except Exception:
        # Defensive: nothing above should raise, but a probe that takes the app
        # down with it is strictly worse than one that admits ignorance.
        logger.error("voice: availability probe failed", exc_info=True)
        return {
            "available": False,
            "reason": REASON_CHECK_FAILED,
            "detail": "Could not inspect voice components.",
            "components": {},
        }

    unavailable = [c for c in components.values() if not c["available"]]
    if not unavailable:
        return {
            "available": True,
            "reason": None,
            "detail": "Speech-to-text, voice activity detection and text-to-speech are ready.",
            "components": components,
        }

    # Aggregate reason = the most blocking one. A missing package cannot be
    # fixed by downloading weights, so it outranks model_missing; and "we could
    # not check" outranks everything because we genuinely do not know.
    order = [REASON_CHECK_FAILED, REASON_UNSUPPORTED, REASON_NOT_INSTALLED, REASON_MODEL_MISSING]
    reason = min((c["reason"] for c in unavailable), key=lambda r: order.index(r))
    names = ", ".join(c["component"] for c in unavailable)
    return {
        "available": False,
        "reason": reason,
        "detail": f"Not ready: {names}. " + "; ".join(c["detail"] for c in unavailable),
        "components": components,
    }


def list_voices() -> dict:
    """List Kokoro voicepack names present on disk.

    NEVER returns a hard-coded catalogue. A list of voices the user does not
    have would produce a picker where every choice fails at synthesis time, so
    an empty list always ships with the reason it is empty and the UI says that
    instead of rendering an empty dropdown.

    Reads names WITHOUT numpy: the ``.bin`` voicepack is an npz, which is a zip,
    so the member names are the voice names. That keeps the "no heavy import"
    rule intact for a call the UI makes just to draw a list.
    """
    tts = _component_status("tts", model_checks=[("kokoro", _tts_model_path(), False)])
    if tts["reason"] in (REASON_NOT_INSTALLED, REASON_UNSUPPORTED, REASON_CHECK_FAILED):
        return {"voices": [], "reason": tts["reason"], "detail": tts["detail"], "source": None}

    path = _tts_voices_path()
    if path is None:
        expected = voice_dir() / "tts" / _TTS_VOICES_FILENAMES[0]
        return {
            "voices": [],
            "reason": REASON_MODEL_MISSING,
            "detail": f"Voicepack not downloaded yet (expected {expected}).",
            "source": None,
        }

    try:
        if path.suffix == ".json":
            import json  # stdlib, cheap, but kept local for symmetry

            data = json.loads(path.read_text(encoding="utf-8"))
            names = sorted(data.keys()) if isinstance(data, dict) else []
        else:
            with zipfile.ZipFile(path) as zf:
                names = sorted(
                    n[:-4] if n.endswith(".npy") else n for n in zf.namelist()
                )
    except Exception:
        logger.warning("voice: could not read voicepack %s", path, exc_info=True)
        return {
            "voices": [],
            "reason": REASON_CHECK_FAILED,
            "detail": f"Voicepack at {path} could not be read.",
            "source": str(path),
        }

    if not names:
        # A readable but empty pack is a real, distinct condition: the file is
        # there and intact, it just declares nothing. Saying "not downloaded"
        # would send the user to re-download a file they already have.
        return {
            "voices": [],
            "reason": REASON_MODEL_MISSING,
            "detail": f"Voicepack at {path} contains no voices.",
            "source": str(path),
        }

    return {"voices": names, "reason": None, "detail": "", "source": str(path)}


def reset_caches() -> None:
    """Drop memoized model handles. Next call reloads."""
    with _MODEL_LOCK:
        _MODELS.clear()


# --------------------------------------------------------------------------
# Model work. Every ML import lives inside these functions.
# --------------------------------------------------------------------------


@dataclass
class Transcript:
    """What STT heard. ``duration_seconds`` is the AUDIO length.

    ``latency_seconds`` is measured wall clock around the actual decode; it is
    None when we did not measure it. There are no invented numbers here.
    """

    text: str
    language: Optional[str] = None
    duration_seconds: Optional[float] = None
    latency_seconds: Optional[float] = None


@dataclass
class Synthesis:
    """Rendered speech. ``samples`` is whatever the engine returned (float32
    ndarray in practice); this module does not convert or resample it."""

    samples: Any
    sample_rate: int
    voice: str
    latency_seconds: Optional[float] = None


def _require(component: str) -> None:
    """Raise VoiceUnavailableError unless *component* is ready."""
    checks = {
        "stt": [("whisper_model", _stt_model_dir(), True)],
        "vad": [("silero_vad", _vad_model_path(), False)],
        "tts": [("kokoro", _tts_model_path(), False)],
    }[component]
    status = _component_status(component, model_checks=checks)
    if not status["available"]:
        raise VoiceUnavailableError(component, status["reason"], status["detail"])


def _load_stt():
    with _MODEL_LOCK:
        cached = _MODELS.get("stt")
        if cached is not None:
            return cached
    _require("stt")
    try:
        # LAZY: faster_whisper pulls in ctranslate2 and tokenizers and costs
        # real seconds. Importing it at module scope would make `import
        # voice_service` — which server.py does at startup — pay that cost, and
        # would hard-fail the whole server on a box without the package.
        from faster_whisper import WhisperModel  # type: ignore
    except Exception as exc:
        logger.error("voice: faster-whisper import failed", exc_info=True)
        raise VoiceUnavailableError("stt", REASON_NOT_INSTALLED, str(exc)) from exc

    try:
        # CPU int8 by default: no torch, no CUDA assumption. A GPU path is a
        # later decision, not a silent default that fails on machines without one.
        model = WhisperModel(str(_stt_model_dir()), device="cpu", compute_type="int8")
    except Exception as exc:
        logger.error("voice: whisper model load failed", exc_info=True)
        raise VoiceUnavailableError("stt", REASON_CHECK_FAILED, str(exc)) from exc

    with _MODEL_LOCK:
        _MODELS["stt"] = model
    return model


def _load_tts():
    with _MODEL_LOCK:
        cached = _MODELS.get("tts")
        if cached is not None:
            return cached
    _require("tts")
    voices = _tts_voices_path()
    if voices is None:
        raise VoiceUnavailableError(
            "tts", REASON_MODEL_MISSING, "Kokoro voicepack not downloaded yet."
        )
    try:
        from kokoro_onnx import Kokoro  # type: ignore
    except Exception as exc:
        logger.error("voice: kokoro-onnx import failed", exc_info=True)
        raise VoiceUnavailableError("tts", REASON_NOT_INSTALLED, str(exc)) from exc

    try:
        model = Kokoro(str(_tts_model_path()), str(voices))
    except Exception as exc:
        logger.error("voice: kokoro model load failed", exc_info=True)
        raise VoiceUnavailableError("tts", REASON_CHECK_FAILED, str(exc)) from exc

    with _MODEL_LOCK:
        _MODELS["tts"] = model
    return model


def transcribe(
    audio: Any,
    *,
    sample_rate: int = 16000,
    language: Optional[str] = None,
) -> Transcript:
    """Transcribe mono PCM (float32 ndarray or a path) via faster-whisper.

    Raises ``VoiceUnavailableError`` when STT is not ready. It never returns an
    empty transcript to signal failure — an empty string is a legitimate result
    (the user said nothing) and overloading it would make silence and breakage
    indistinguishable.
    """
    model = _load_stt()
    started = time.monotonic()
    segments, info = model.transcribe(audio, language=language, vad_filter=False)
    # faster-whisper returns a generator; the decode only happens on iteration,
    # so timing without draining it would measure nothing.
    text = "".join(seg.text for seg in segments).strip()
    elapsed = time.monotonic() - started
    return Transcript(
        text=text,
        language=getattr(info, "language", None) or language,
        duration_seconds=getattr(info, "duration", None),
        latency_seconds=elapsed,
    )


def synthesize(text: str, *, voice: Optional[str] = None, speed: float = 1.0) -> Synthesis:
    """Render *text* to audio with Kokoro.

    Raises ``VoiceUnavailableError`` when TTS is not ready, and when *voice* is
    not one of the voicepacks actually present — silently substituting a
    different voice would be a lie the user hears.
    """
    model = _load_tts()
    catalog = list_voices()
    names = catalog["voices"]
    if voice is None:
        if not names:
            raise VoiceUnavailableError("tts", catalog["reason"] or REASON_MODEL_MISSING, catalog["detail"])
        voice = names[0]
    elif names and voice not in names:
        raise VoiceUnavailableError(
            "tts",
            REASON_MODEL_MISSING,
            f"Voice {voice!r} is not in the installed voicepack ({len(names)} available).",
        )

    started = time.monotonic()
    samples, rate = model.create(text, voice=voice, speed=speed)
    return Synthesis(
        samples=samples,
        sample_rate=rate,
        voice=voice,
        latency_seconds=time.monotonic() - started,
    )


# --------------------------------------------------------------------------
# The state machine. No audio, no models, no real clock.
# --------------------------------------------------------------------------


class State(str, Enum):
    IDLE = "idle"
    LISTENING = "listening"
    THINKING = "thinking"
    SPEAKING = "speaking"


class Trigger(str, Enum):
    START = "start"
    STOP = "stop"
    SPEECH_STARTED = "speech_started"
    SPEECH_ENDED = "speech_ended"
    SILENCE_ELAPSED = "silence_elapsed"      # fired internally by tick()
    LISTEN_TIMEOUT = "listen_timeout"        # fired internally by tick()
    RESPONSE_READY = "response_ready"
    RESPONSE_FAILED = "response_failed"
    PLAYBACK_FINISHED = "playback_finished"
    BARGE_IN = "barge_in"                    # speech while thinking/speaking


@dataclass(frozen=True)
class Transition:
    frm: State
    to: State
    trigger: Trigger
    at: float


class VoiceStateMachine:
    """idle → listening → thinking → speaking → listening.

    Rules that carry weight:

    - **Speech while SPEAKING is a barge-in.** The machine leaves ``speaking``
      on the same call that reports the speech; it does not wait for the
      current utterance, sentence, or audio buffer to finish. Anything else and
      the user talks over the assistant for a second and a half, which is the
      exact experience this feature exists to avoid.
    - **Speech while THINKING is also a barge-in.** The user has changed their
      mind before the answer arrived; playing it anyway would be answering a
      question that was withdrawn. The pending response is invalidated via a
      monotonically increasing ``turn_id``, so a late ``response_ready`` from
      the abandoned turn is rejected rather than resurrecting it.
    - **Silence only advances a turn that HAS speech in it.** Five seconds of
      dead air with nothing said is not the end of a turn — there is no turn.
      Advancing there would send the model an empty prompt on a loop.
    - **Illegal triggers raise.** See ``IllegalTransition``.

    Not thread-safe by design: one session is driven by one audio loop. If a
    caller drives it from several threads it must supply its own lock — a lock
    in here would give false comfort, since callers also read ``state`` and act
    on it outside any critical section this class could own.
    """

    def __init__(
        self,
        *,
        clock: Optional[Callable[[], float]] = None,
        silence_continue_seconds: Optional[float] = None,
        listen_idle_timeout_seconds: Optional[float] = None,
        on_transition: Optional[Callable[[Transition], None]] = None,
    ) -> None:
        self._clock = clock or time.monotonic
        self.silence_continue_seconds = (
            SILENCE_CONTINUE_SECONDS if silence_continue_seconds is None else silence_continue_seconds
        )
        self.listen_idle_timeout_seconds = (
            LISTEN_IDLE_TIMEOUT_SECONDS
            if listen_idle_timeout_seconds is None
            else listen_idle_timeout_seconds
        )
        self._on_transition = on_transition

        self._state = State.IDLE
        self._speech_active = False
        self._heard_speech_this_turn = False
        self._last_speech_end: Optional[float] = None
        self._listening_since: Optional[float] = None
        self._turn_id = 0
        self._barge_in_count = 0
        self.history: list[Transition] = []

    # -- introspection -----------------------------------------------------

    @property
    def state(self) -> State:
        return self._state

    @property
    def turn_id(self) -> int:
        return self._turn_id

    @property
    def barge_in_count(self) -> int:
        return self._barge_in_count

    @property
    def heard_speech_this_turn(self) -> bool:
        return self._heard_speech_this_turn

    def snapshot(self) -> dict:
        return {
            "state": self._state.value,
            "turn_id": self._turn_id,
            "speech_active": self._speech_active,
            "heard_speech_this_turn": self._heard_speech_this_turn,
            "barge_in_count": self._barge_in_count,
        }

    # -- internals ---------------------------------------------------------

    def _now(self) -> float:
        return float(self._clock())

    def _go(self, to: State, trigger: Trigger) -> Transition:
        frm = self._state
        self._state = to
        tr = Transition(frm=frm, to=to, trigger=trigger, at=self._now())
        self.history.append(tr)
        if self._on_transition is not None:
            try:
                self._on_transition(tr)
            except Exception:
                # An observer must never be able to wedge the conversation.
                logger.error("voice: on_transition observer raised", exc_info=True)
        logger.debug("voice: %s -> %s (%s)", frm.value, to.value, trigger.value)
        return tr

    def _begin_listening(self, trigger: Trigger) -> Transition:
        self._speech_active = False
        self._heard_speech_this_turn = False
        self._last_speech_end = None
        self._listening_since = self._now()
        return self._go(State.LISTENING, trigger)

    # -- triggers ----------------------------------------------------------

    def start(self) -> Transition:
        """idle → listening. Idempotent-ish: restarting from listening rearms
        the turn (a caller pressing the mic button twice should not raise)."""
        if self._state in (State.IDLE, State.LISTENING):
            return self._begin_listening(Trigger.START)
        raise IllegalTransition(self._state, Trigger.START)

    def stop(self) -> Transition:
        """Any state → idle. Always legal: the user hanging up cannot be
        refused, and a stop that raises leaves the session running."""
        self._speech_active = False
        self._heard_speech_this_turn = False
        self._last_speech_end = None
        self._listening_since = None
        self._turn_id += 1  # invalidate anything in flight
        return self._go(State.IDLE, Trigger.STOP)

    def speech_started(self) -> Transition:
        """VAD says the user is talking.

        THE critical path: in ``speaking`` (or ``thinking``) this is a barge-in
        and returns immediately in ``listening``.
        """
        now = self._now()
        if self._state is State.LISTENING:
            self._speech_active = True
            self._heard_speech_this_turn = True
            self._last_speech_end = None
            # Not a state change; report the no-op transition for history
            # symmetry so a caller can log one stream of events.
            return self._go(State.LISTENING, Trigger.SPEECH_STARTED)

        if self._state in (State.SPEAKING, State.THINKING):
            self._barge_in_count += 1
            # Invalidate the in-flight turn BEFORE transitioning, so a
            # response_ready racing in from the abandoned turn is rejected.
            self._turn_id += 1
            # Set the turn fields BEFORE publishing the transition: an observer
            # watching for "listening" must not see a turn that claims no speech
            # has been heard when the reason we are listening is that it has.
            self._speech_active = True
            self._heard_speech_this_turn = True
            self._last_speech_end = None
            self._listening_since = now
            return self._go(State.LISTENING, Trigger.BARGE_IN)

        raise IllegalTransition(self._state, Trigger.SPEECH_STARTED)

    def speech_ended(self) -> Transition:
        """VAD says the user stopped. Starts the silence clock for this turn."""
        if self._state is not State.LISTENING:
            raise IllegalTransition(self._state, Trigger.SPEECH_ENDED)
        self._speech_active = False
        self._last_speech_end = self._now()
        return self._go(State.LISTENING, Trigger.SPEECH_ENDED)

    def tick(self) -> Optional[Transition]:
        """Advance time-based rules. Returns the transition it caused, or None.

        Called from the audio loop on every frame. Cheap and total: outside
        ``listening`` there is no timer, so it is a no-op rather than an error —
        a tick arriving one frame after a barge-in must not crash the loop.
        """
        if self._state is not State.LISTENING:
            return None
        now = self._now()
        if self._speech_active:
            return None

        if self._heard_speech_this_turn and self._last_speech_end is not None:
            if now - self._last_speech_end >= self.silence_continue_seconds:
                return self._go(State.THINKING, Trigger.SILENCE_ELAPSED)
            return None

        # No speech yet this turn: silence is not the end of a turn, it is an
        # empty room. Only give up after the much longer idle timeout.
        if self._listening_since is not None:
            if now - self._listening_since >= self.listen_idle_timeout_seconds:
                self._turn_id += 1
                return self._go(State.IDLE, Trigger.LISTEN_TIMEOUT)
        return None

    def response_ready(self, *, turn_id: Optional[int] = None) -> Transition:
        """The LLM answer (and its audio) is ready → speaking.

        Pass the ``turn_id`` captured when ``thinking`` began; a stale one is
        refused, which is how a barge-in stays barged-in.
        """
        if self._state is not State.THINKING:
            raise IllegalTransition(self._state, Trigger.RESPONSE_READY)
        if turn_id is not None and turn_id != self._turn_id:
            raise IllegalTransition(self._state, Trigger.RESPONSE_READY)
        return self._go(State.SPEAKING, Trigger.RESPONSE_READY)

    def response_failed(self) -> Transition:
        """The turn produced nothing usable → back to listening, not idle.

        Dropping to idle would silently end the conversation on one bad turn.
        """
        if self._state is not State.THINKING:
            raise IllegalTransition(self._state, Trigger.RESPONSE_FAILED)
        self._turn_id += 1
        return self._begin_listening(Trigger.RESPONSE_FAILED)

    def playback_finished(self) -> Transition:
        """TTS finished on its own → listening for the user's reply."""
        if self._state is not State.SPEAKING:
            raise IllegalTransition(self._state, Trigger.PLAYBACK_FINISHED)
        self._turn_id += 1
        return self._begin_listening(Trigger.PLAYBACK_FINISHED)


# --------------------------------------------------------------------------
# Session — the thin layer that binds the machine to something that makes noise.
# --------------------------------------------------------------------------


class Speaker(Protocol):
    """Whatever is playing TTS audio. The ONLY thing the session needs from it
    is the ability to shut up instantly."""

    def stop(self) -> None:  # pragma: no cover - protocol
        ...


class VoiceSession:
    """A conversation. Owns a ``VoiceStateMachine`` and stops the speaker on
    barge-in.

    Deliberately thin: everything policy-shaped lives in the state machine, and
    the audio device lives behind ``Speaker``, so this class holds no logic that
    needs a microphone to test.

    Ordering matters and is load-bearing: on barge-in the speaker is stopped
    BEFORE the state transition is published to observers. An observer that
    reacts to "now listening" by starting capture would otherwise be recording
    the tail of our own TTS.
    """

    def __init__(
        self,
        *,
        speaker: Optional[Speaker] = None,
        clock: Optional[Callable[[], float]] = None,
        silence_continue_seconds: Optional[float] = None,
        listen_idle_timeout_seconds: Optional[float] = None,
        on_transition: Optional[Callable[[Transition], None]] = None,
    ) -> None:
        self.speaker = speaker
        self.machine = VoiceStateMachine(
            clock=clock,
            silence_continue_seconds=silence_continue_seconds,
            listen_idle_timeout_seconds=listen_idle_timeout_seconds,
            on_transition=on_transition,
        )

    @property
    def state(self) -> State:
        return self.machine.state

    def start(self) -> Transition:
        return self.machine.start()

    def stop(self) -> Transition:
        self._silence_speaker()
        return self.machine.stop()

    def _silence_speaker(self) -> None:
        if self.speaker is None:
            return
        try:
            self.speaker.stop()
        except Exception:
            # A speaker that cannot be stopped must not also block the
            # transition — the user is already talking over it.
            logger.error("voice: speaker.stop() raised", exc_info=True)

    def speech_started(self) -> Transition:
        interrupting = self.machine.state in (State.SPEAKING, State.THINKING)
        if interrupting:
            self._silence_speaker()
        return self.machine.speech_started()

    def speech_ended(self) -> Transition:
        return self.machine.speech_ended()

    def tick(self) -> Optional[Transition]:
        return self.machine.tick()

    def response_ready(self, *, turn_id: Optional[int] = None) -> Transition:
        return self.machine.response_ready(turn_id=turn_id)

    def response_failed(self) -> Transition:
        return self.machine.response_failed()

    def playback_finished(self) -> Transition:
        return self.machine.playback_finished()

    def snapshot(self) -> dict:
        return self.machine.snapshot()
