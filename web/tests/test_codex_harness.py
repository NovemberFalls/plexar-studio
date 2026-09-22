"""The `harness` dimension: spawning OpenAI's `codex` CLI instead of `claude`.

Covers the codex half of PtyManager.create_terminal's command build, the
validation that guards it, and — most importantly — the JSONL mis-attribution
guard: ~/.claude/projects is Claude Code's store, and a codex pane must never
be handed some other pane's transcript (the bug #15 family).

NOTHING here spawns a real process: get_backend is patched at its source
(`pty_backend.get_backend`, imported call-time inside create_terminal) and both
CLI resolvers are patched so the tests do not depend on `codex` or `claude`
being installed on the machine running them.
"""

import os
import time
import types
from unittest.mock import MagicMock, patch

import pytest

os.environ.setdefault("MAX_SESSIONS", "8")

import pty_manager
from pty_manager import PtyManager


# ---------------------------------------------------------------------------
# Helpers — same shape as tests/test_spawn_levers.py, plus env capture and a
# stubbed CLI resolver (the codex CLI is not installed on CI or on the dev box).
# ---------------------------------------------------------------------------


def _make_mock_backend():
    pty = MagicMock()
    pty.isalive.return_value = True
    # Deliberately None: a truthy pid makes create_terminal append to the
    # instance's on-disk child-PID file, so a unit test would leave a fake PID
    # in a file whose whole purpose is to be a record of REAL children.
    pty.pid = None

    backend_cls = MagicMock()
    backend_cls.spawn.return_value = pty
    backend_cls.__name__ = "MockBackend"
    return backend_cls, pty


def _call_create(mgr, **kwargs):
    """Run create_terminal with no real spawn; return (session, cmd, env)."""
    backend_cls, _ = _make_mock_backend()
    captured = {}

    def recording_spawn(cmd, **kw):
        captured["cmd"] = cmd
        captured["env"] = kw.get("env", {})
        return backend_cls.spawn.return_value

    backend_cls.spawn.side_effect = recording_spawn

    with patch("pty_backend.get_backend", return_value=backend_cls), \
         patch.object(pty_manager, "resolve_codex_cli",
                      side_effect=lambda p: ("C:\\fake\\codex.cmd", p)), \
         patch.object(pty_manager, "resolve_claude_cli",
                      side_effect=lambda p: ("C:\\fake\\claude.cmd", p)):
        session = mgr.create_terminal(**kwargs)

    return session, captured.get("cmd", ""), captured.get("env", {})


@pytest.fixture()
def mgr():
    return PtyManager()


# ---------------------------------------------------------------------------
# 1 + 4 — the base command
# ---------------------------------------------------------------------------


class TestCodexCommand:
    @pytest.mark.parametrize("provider", ["anthropic", "openrouter"])
    @pytest.mark.parametrize("harness", ["codex", "claude-code"])
    def test_embedded_codex_preserves_terminal_scrollback(self, mgr, provider, harness):
        with patch("settings_store.resolve_openrouter_key",
                   return_value=("sk-or-test-key", "settings")):
            _, cmd, _ = _call_create(
                mgr, name="t", workdir="C:\\Code", harness=harness,
                model="gpt-5.6-terra" if harness == "codex" else "sonnet",
                provider=provider, provider_model="qwen/qwen3-coder-next",
            )
        assert cmd.split().count("--no-alt-screen") == (1 if harness == "codex" else 0)

    def test_base_command_selects_model_and_inline_rendering(self, mgr):
        """Embedded Codex selects the model and keeps normal-buffer history."""
        _, cmd, _ = _call_create(
            mgr, name="t", workdir="C:\\Code",
            harness="codex", model="gpt-5.6-terra",
        )
        assert cmd == "codex -m gpt-5.6-terra --no-alt-screen"
        # The claude CLI must not be anywhere near this command.
        assert "claude" not in cmd
        assert "--model" not in cmd

    def test_effort_high_becomes_a_config_override(self, mgr):
        """Codex takes reasoning effort as `-c model_reasoning_effort=`, not --effort."""
        _, cmd, _ = _call_create(
            mgr, name="t", workdir="C:\\Code",
            harness="codex", model="gpt-5.6-terra", effort="high",
        )
        assert "-c model_reasoning_effort=high" in cmd
        assert "--effort" not in cmd

    def test_empty_effort_adds_no_fragment(self, mgr):
        _, cmd, _ = _call_create(
            mgr, name="t", workdir="C:\\Code",
            harness="codex", model="gpt-5.6-terra", effort="",
        )
        assert "model_reasoning_effort" not in cmd

    def test_session_records_the_harness(self, mgr):
        session, _, _ = _call_create(
            mgr, name="t", workdir="C:\\Code",
            harness="codex", model="gpt-5.6-terra",
        )
        assert session.harness == "codex"


# ---------------------------------------------------------------------------
# 2 — codex + OpenRouter
# ---------------------------------------------------------------------------


class TestCodexOpenRouter:
    @pytest.fixture(autouse=True)
    def _no_inherited_anthropic_env(self, monkeypatch):
        # The codex+openrouter branch does not BLOCK the ANTHROPIC_* keys (only
        # the anthropic-provider branch does), so an inherited value on the
        # developer's box would travel into the child env and make the
        # "no ANTHROPIC_* is set" assertion below a test of the environment
        # rather than of the code. Clear them so the assertion means what it says.
        for key in ("ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY",
                    "ANTHROPIC_MODEL", "ANTHROPIC_SMALL_FAST_MODEL"):
            monkeypatch.delenv(key, raising=False)

    def _create(self, mgr, **kw):
        with patch("settings_store.resolve_openrouter_key",
                   return_value=("sk-or-test-key", "settings")):
            return _call_create(
                mgr, name="t", workdir="C:\\Code",
                harness="codex", provider="openrouter",
                # `model` is ignored for provider=openrouter — the SLUG is what
                # must reach `-m`, and pinning that is the point of this class.
                model="gpt-5.6-terra",
                provider_model="qwen/qwen3-coder-next",
                **kw,
            )

    def test_dash_m_carries_the_slug_not_the_model(self, mgr):
        _, cmd, _ = self._create(mgr)
        assert "-m qwen/qwen3-coder-next" in cmd
        assert "gpt-5.6-terra" not in cmd

    def test_all_five_provider_config_fragments_are_present(self, mgr):
        _, cmd, _ = self._create(mgr)
        for fragment in (
            "-c model_provider=openrouter",
            "-c model_providers.openrouter.name=OpenRouter",
            "-c model_providers.openrouter.base_url=https://openrouter.ai/api/v1",
            "-c model_providers.openrouter.env_key=OPENROUTER_API_KEY",
            "-c model_providers.openrouter.wire_api=responses",
        ):
            assert fragment in cmd, f"missing config fragment: {fragment}"

    def test_openrouter_key_reaches_the_child_env(self, mgr):
        _, _, env = self._create(mgr)
        assert env.get("OPENROUTER_API_KEY") == "sk-or-test-key"

    def test_no_anthropic_env_var_is_set_for_codex(self, mgr):
        """Codex reads none of the ANTHROPIC_* plumbing; setting it would mislead."""
        _, _, env = self._create(mgr)
        leaked = [k for k in env if k.startswith("ANTHROPIC_")]
        assert leaked == [], f"codex child env carries {leaked}"

    def test_session_model_displays_the_slug(self, mgr):
        session, _, _ = self._create(mgr)
        assert session.model == "qwen/qwen3-coder-next"
        assert session.provider == "openrouter"


# ---------------------------------------------------------------------------
# 3 — permission mapping
# ---------------------------------------------------------------------------


class TestCodexPermissionMapping:
    @pytest.mark.parametrize(
        "kwargs, expected",
        [
            ({"permission_mode": "bypassPermissions"},
             "--dangerously-bypass-approvals-and-sandbox"),
            ({"bypass_permissions": True},
             "--dangerously-bypass-approvals-and-sandbox"),
            ({"permission_mode": "acceptEdits"},
             "--sandbox workspace-write --ask-for-approval on-request"),
            ({"permission_mode": "plan"},
             "--sandbox read-only --ask-for-approval untrusted"),
        ],
    )
    def test_mode_maps_to_codex_flags(self, mgr, kwargs, expected):
        _, cmd, _ = _call_create(
            mgr, name="t", workdir="C:\\Code",
            harness="codex", model="gpt-5.6-terra", **kwargs,
        )
        assert expected in cmd

    def test_default_mode_adds_nothing(self, mgr):
        _, cmd, _ = _call_create(
            mgr, name="t", workdir="C:\\Code",
            harness="codex", model="gpt-5.6-terra", permission_mode="default",
        )
        assert cmd == "codex -m gpt-5.6-terra --no-alt-screen"

    @pytest.mark.parametrize(
        "kwargs",
        [
            {"permission_mode": "bypassPermissions"},
            {"bypass_permissions": True},
            {"permission_mode": "acceptEdits"},
            {"permission_mode": "plan"},
            {"permission_mode": "default"},
            {"permission_mode": "auto"},
            {"permission_mode": "dontAsk"},
        ],
    )
    def test_claude_only_flags_never_appear_under_codex(self, mgr, kwargs):
        """--dangerously-skip-permissions is a claude flag; codex would reject it
        outright, so a leak here is a session that dies at spawn."""
        _, cmd, _ = _call_create(
            mgr, name="t", workdir="C:\\Code",
            harness="codex", model="gpt-5.6-terra", **kwargs,
        )
        assert "--dangerously-skip-permissions" not in cmd
        assert "--permission-mode" not in cmd


# ---------------------------------------------------------------------------
# 5 — fast mode is dropped, and drops nothing on disk
# ---------------------------------------------------------------------------


def test_fast_is_skipped_under_codex_and_leaks_no_temp_file(mgr):
    """Fast mode is a Claude Code settings key. Under codex it must be dropped
    WITHOUT writing the temp --settings file — a file written and never cleaned
    up is how %TEMP% fills with cockpit_fast_*.json."""
    with patch("tempfile.mkstemp") as mkstemp:
        session, cmd, _ = _call_create(
            mgr, name="t", workdir="C:\\Code",
            # An Opus-shaped id would satisfy the claude-side fast gate; the
            # harness is what must veto it, not the model name.
            harness="codex", model="gpt-5.6-opus", fast=True,
        )
    assert "--settings" not in cmd
    assert mkstemp.call_count == 0
    assert getattr(session, "_fast_settings_path", None) is None
    # The lever itself is still recorded — the user asked for it, we just could
    # not honour it; silently rewriting their setting would be a second lie.
    assert session.fast is True


# ---------------------------------------------------------------------------
# 6 — native Codex resume subcommand preserves its own transcript identity
# ---------------------------------------------------------------------------


class TestCodexResume:
    def test_resume_session_id_uses_native_subcommand(self, mgr):
        session, cmd, _ = _call_create(
            mgr, name="t", workdir="C:\\Code",
            harness="codex", model="gpt-5.6-terra",
            resume_session_id="abc123def456",
        )
        assert "--resume" not in cmd
        assert cmd.startswith("codex resume abc123def456 -m gpt-5.6-terra --no-alt-screen")
        assert session.codex_session_id == "abc123def456"
        assert session.claude_session_id is None

    def test_continue_last_produces_no_flag(self, mgr):
        session, cmd, _ = _call_create(
            mgr, name="t", workdir="C:\\Code",
            harness="codex", model="gpt-5.6-terra", continue_last=True,
        )
        assert "--continue" not in cmd
        assert cmd.startswith("codex resume --last ")
        assert session.claude_session_id is None

    def test_claude_harness_still_resumes(self, mgr):
        """Watch-to-fail twin: the codex assertions above must not be passing
        because resume stopped working everywhere."""
        session, cmd, _ = _call_create(
            mgr, name="t", workdir="C:\\Code",
            harness="claude-code", model="sonnet",
            resume_session_id="abc123def456",
        )
        assert "--resume abc123def456" in cmd
        assert session.claude_session_id == "abc123def456"


# ---------------------------------------------------------------------------
# 7 — THE MIS-ATTRIBUTION GUARD (bug #15 family)
# ---------------------------------------------------------------------------


def _fake_session(sid, *, harness, workdir, claude_session_id=None,
                  pre_spawn_files=None, last_output_time=0.0):
    return types.SimpleNamespace(
        id=sid,
        harness=harness,
        working_dir=workdir,
        claude_session_id=claude_session_id,
        _pre_spawn_files=pre_spawn_files,
        last_output_time=last_output_time,
    )


def _project_dir(home, workdir):
    project_id = workdir.replace("\\", "-").replace("/", "-").replace(":", "-").lstrip("-")
    return os.path.join(str(home), ".claude", "projects", project_id)


@pytest.fixture()
def fake_home(tmp_path, monkeypatch):
    """Point ~ at a scratch dir so _get_jsonl_path reads a directory we own."""
    home = tmp_path / "home"
    home.mkdir()
    real_expanduser = os.path.expanduser
    monkeypatch.setattr(
        os.path, "expanduser",
        lambda p: str(home) if p == "~" else real_expanduser(p),
    )
    return home


class TestCodexNeverClaimsAClaudeTranscript:
    """A codex pane sharing a workdir with a LIVE claude pane is the exact
    configuration that made bug #15: Strategy 3 hands the most recently written
    unclaimed JSONL to whoever asks, and a codex session writes nothing to
    ~/.claude/projects, so it would happily be handed its neighbour's file and
    then report that neighbour's tokens, cost and context as its own."""

    WORKDIR = "C:\\Code\\Shared"

    def _setup(self, fake_home):
        proj = _project_dir(fake_home, self.WORKDIR)
        os.makedirs(proj)
        live = os.path.join(proj, "live-claude-file.jsonl")
        with open(live, "w") as fh:
            fh.write("{}\n")
        now = time.time()
        os.utime(live, (now, now))
        return proj, live

    def test_codex_gets_none_and_claude_keeps_its_own_file(self, mgr, fake_home):
        proj, live = self._setup(fake_home)

        claude = _fake_session(
            "t-claude", harness="claude-code", workdir=self.WORKDIR,
            # Empty snapshot: the live file is "new since spawn", so Strategy 2
            # legitimately discovers it.
            pre_spawn_files=set(),
        )
        codex = _fake_session(
            "t-codex", harness="codex", workdir=self.WORKDIR,
            # Everything Strategy 3 needs to fire: no snapshot, recent output.
            pre_spawn_files=None, last_output_time=time.monotonic(),
        )
        mgr.sessions = {"t-claude": claude, "t-codex": codex}

        # Ask the CODEX session FIRST — before the claude session has locked the
        # file. If the guard were absent this is the call that would steal it.
        assert mgr._get_jsonl_path(codex) is None
        assert codex.claude_session_id is None

        assert mgr._get_jsonl_path(claude) == live
        assert claude.claude_session_id == "live-claude-file"

        # And still None afterwards, now that the file is demonstrably claimed.
        assert mgr._get_jsonl_path(codex) is None
        assert codex.claude_session_id is None

    def test_codex_with_a_stale_claude_session_id_still_gets_none(self, mgr, fake_home):
        """Defense in depth: even a codex session that somehow carries a
        claude_session_id (e.g. a record migrated from an older build) must not
        resolve a path — Strategy 1 runs before every other guard but this one."""
        proj, live = self._setup(fake_home)
        codex = _fake_session(
            "t-codex", harness="codex", workdir=self.WORKDIR,
            claude_session_id="live-claude-file",
        )
        mgr.sessions = {"t-codex": codex}
        assert mgr._get_jsonl_path(codex) is None

    def test_watch_to_fail_the_same_session_as_claude_code_resolves(self, mgr, fake_home):
        """The twin that proves the assertions above are not passing because the
        fixture is broken: flip ONLY the harness and the same session resolves."""
        proj, live = self._setup(fake_home)
        s = _fake_session(
            "t-x", harness="claude-code", workdir=self.WORKDIR,
            pre_spawn_files=None, last_output_time=time.monotonic(),
        )
        mgr.sessions = {"t-x": s}
        assert mgr._get_jsonl_path(s) == live


# ---------------------------------------------------------------------------
# 8 — validation
# ---------------------------------------------------------------------------


class TestHarnessValidation:
    def test_unknown_harness_raises(self, mgr):
        with pytest.raises(ValueError, match="Invalid harness"):
            _call_create(mgr, name="t", workdir="C:\\Code",
                         harness="bogus", model="sonnet")

    def test_codex_plus_local_is_refused_only_when_MEASURED_unsupported(self, mgr, monkeypatch):
        """A local engine under Codex is gated on the ENGINE, not on its kind.

        This was a blanket refusal ("Local providers are not supported by the
        Codex harness"), written when every local provider served Chat
        Completions only. vLLM then gained /v1/responses and Plexar passes it
        through, so the pairing works -- verified against codex-cli 0.153.4
        driving a live rig end to end. The gate is now the measured protocol.
        """
        import server as server_module
        monkeypatch.setattr(server_module, "provider_speaks_responses", lambda pid: False)
        with pytest.raises(ValueError, match="does not serve the Responses API"):
            _call_create(mgr, name="t", workdir="C:\\Code",
                         harness="codex", provider="local",
                         provider_model="lmstudio-local::qwen3-coder-30b")

    def test_codex_plus_local_is_allowed_when_the_engine_serves_responses(self, mgr, monkeypatch):
        """The positive twin, so the refusal above cannot be passing by
        refusing everything -- the failure shape this repo keeps hitting."""
        import server as server_module
        monkeypatch.setattr(server_module, "provider_speaks_responses", lambda pid: True)
        session, cmd, env = _call_create(
            mgr, name="t", workdir="C:\\Code",
            harness="codex", provider="local",
            provider_model="lmstudio-local::qwen3-coder-30b")
        assert session.harness == "codex"
        # The engine's OWN OpenAI surface, never Studio's /shim/* routes: those
        # translate the Anthropic wire shape for the `claude` CLI, so a
        # Responses request handed to one would 404 on every turn.
        assert "/shim/" not in cmd
        assert "-c model_provider=lmstudio-local" in cmd
        assert "wire_api=responses" in cmd
        # codex refuses a provider whose env_key names an unset variable, so an
        # engine needing no credential must still get the dummy.
        assert env["PLEXAR_STUDIO_LOCAL_KEY"]

    def test_codex_plus_local_is_allowed_when_the_probe_is_unknown(self, mgr, monkeypatch):
        """UNKNOWN IS NOT FALSE. An engine we could not reach has told us
        nothing about its protocols, and refusing on that is a false claim
        about machine state -- the same split `authorized` exists to keep."""
        import server as server_module
        monkeypatch.setattr(server_module, "provider_speaks_responses", lambda pid: None)
        session, cmd, _env = _call_create(
            mgr, name="t", workdir="C:\\Code",
            harness="codex", provider="local",
            provider_model="lmstudio-local::qwen3-coder-30b")
        assert session.harness == "codex"
        assert "wire_api=responses" in cmd

    @pytest.mark.parametrize("model", ["--dangerously-skip-permissions", "-m evil",
                                       "a b", "a;rm -rf /", ""])
    def test_malformed_codex_model_is_refused(self, mgr, model):
        """The id is interpolated straight after `-m`, so a flag-shaped or
        space-bearing value must never reach the command string."""
        with pytest.raises(ValueError, match="Invalid Codex model"):
            _call_create(mgr, name="t", workdir="C:\\Code",
                         harness="codex", model=model)

    def test_codex_model_ids_are_not_held_to_the_anthropic_allowlist(self, mgr):
        """Watch-to-fail twin for the validator swap: a plain Codex id would be
        rejected outright if the Anthropic path were still in force."""
        _, cmd, _ = _call_create(mgr, name="t", workdir="C:\\Code",
                                 harness="codex", model="gpt-5.3-codex-spark")
        assert cmd == "codex -m gpt-5.3-codex-spark --no-alt-screen"

    @pytest.mark.parametrize("model", ["claude-opus-5", "claude-opus-5[1m]",
                                       "claude-sonnet-5", "sonnet", "opus", "haiku",
                                       "CLAUDE-Opus-5"])
    def test_codex_plus_a_claude_model_raises(self, mgr, model):
        """The twin of test_codex_plus_local_provider_raises, and it exists
        because _CODEX_MODEL_RE alone let this through.

        `claude-opus-5` is alphanumeric, hyphenated and injection-free, so the
        regex matched and the manager spawned `codex -m claude-opus-5` -- a
        session that authenticates fine and then 400s on every turn. The pair
        was reachable from the UI on 2.1.0: TopBar restores `cockpit-harness`
        and `cockpit-model` from two INDEPENDENT localStorage keys, so a saved
        Codex harness came back beside a saved Claude model with nothing
        reconciling them. The frontend now has a single arbiter
        (reconcileModelForHarness), but a direct POST still reaches here.
        """
        with pytest.raises(ValueError, match="cannot run it"):
            _call_create(mgr, name="t", workdir="C:\\Code",
                         harness="codex", model=model)

    def test_claude_harness_still_accepts_its_own_models(self, mgr):
        """Watch-to-fail twin #1: the refusal must be scoped to harness=codex.
        A guard that fired for Claude Code would break every normal session."""
        _, cmd, _ = _call_create(mgr, name="t", workdir="C:\\Code",
                                 harness="claude-code", model="claude-opus-5")
        assert "claude" in cmd and "codex" not in cmd

    def test_codex_via_openrouter_still_accepts_an_anthropic_slug(self, mgr):
        """Watch-to-fail twin #2, and the reason the guard checks `provider`.

        Under provider="openrouter" the id that reaches the CLI is
        provider_model -- an OpenRouter slug -- and Codex genuinely reaches
        Anthropic models that way through its custom model_provider. A guard
        that ignored provider would refuse a SUPPORTED combination.
        """
        with patch("settings_store.resolve_openrouter_key",
                   return_value=("sk-or-test-key", "settings")):
            _, cmd, _ = _call_create(mgr, name="t", workdir="C:\\Code",
                                     harness="codex", provider="openrouter",
                                     model="claude-opus-5",
                                     provider_model="anthropic/claude-opus-5")
        assert "codex -m anthropic/claude-opus-5" in cmd

    def test_a_codex_id_that_merely_contains_claude_is_allowed(self, mgr):
        """The check is a PREFIX match, not a substring one. A future OpenAI id
        carrying the word elsewhere must not be swept up -- the guard exists to
        catch Anthropic's own ids, not to police OpenAI's namespace."""
        _, cmd, _ = _call_create(mgr, name="t", workdir="C:\\Code",
                                 harness="codex", model="gpt-6-claude-compat")
        assert cmd == "codex -m gpt-6-claude-compat --no-alt-screen"


# ---------------------------------------------------------------------------
# 9 + 10 — the wire
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_post_terminals_forwards_harness():
    import logging_config
    logging_config.setup("WARNING")
    from httpx import AsyncClient, ASGITransport
    from server import app

    captured = {}

    def fake_create_terminal(**kwargs):
        captured.update(kwargs)
        raise RuntimeError("stop early")  # abort before any spawn

    with patch("server.pty_manager.create_terminal", side_effect=fake_create_terminal):
        async with AsyncClient(transport=ASGITransport(app=app),
                               base_url="http://127.0.0.1:8420") as client:
            res = await client.post("/api/terminals", json={
                "name": "t", "workdir": "C:\\Code",
                "model": "gpt-5.6-terra", "harness": "codex",
            })
    assert res.status_code == 500
    assert captured.get("harness") == "codex"


@pytest.mark.asyncio
async def test_post_terminals_without_harness_still_spawns_claude_code():
    """Regression guard: every existing client (and the Undo path) posts no
    `harness` key at all, and must keep getting the claude CLI."""
    import logging_config
    logging_config.setup("WARNING")
    from httpx import AsyncClient, ASGITransport
    from server import app

    captured = {}

    def fake_create_terminal(**kwargs):
        captured.update(kwargs)
        raise RuntimeError("stop early")

    with patch("server.pty_manager.create_terminal", side_effect=fake_create_terminal):
        async with AsyncClient(transport=ASGITransport(app=app),
                               base_url="http://127.0.0.1:8420") as client:
            res = await client.post("/api/terminals", json={
                "name": "t", "workdir": "C:\\Code", "model": "sonnet",
            })
    assert res.status_code == 500
    assert captured.get("harness") == "claude-code"


def test_session_to_dict_carries_harness(mgr):
    """The frontend reconciles panes from this dict; a missing key means a
    restored pane cannot know which CLI it is talking to."""
    session, _, _ = _call_create(
        mgr, name="t", workdir="C:\\Code",
        harness="codex", model="gpt-5.6-terra",
    )
    payload = mgr._session_to_dict(session)
    assert payload["harness"] == "codex"

    claude_session, _, _ = _call_create(
        mgr, name="t2", workdir="C:\\Code",
        harness="claude-code", model="sonnet",
    )
    assert mgr._session_to_dict(claude_session)["harness"] == "claude-code"
