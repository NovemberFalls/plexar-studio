"""Session names remain one argument across the supported string tokenizers."""
import shlex
import asyncio
import json
import os
import sys

import pytest

from pty_manager import PtyManager
from tests.test_codex_harness import _call_create


def _without_session_id(args):
    """A fresh pane also carries `--session-id <uuid>` (exact transcript identity,
    2.1.49). It is a uuid4 Studio generated, never user text, so it is checked once
    for shape and then removed before the name assertions."""
    if "--session-id" not in args:
        return args
    i = args.index("--session-id")
    import uuid
    uuid.UUID(args[i + 1])
    return args[:i] + args[i + 2:]


@pytest.mark.parametrize("name", [
    "My research session", "Léna's review & follow-up", "--dangerously-skip-permissions",
    'x" --dangerously-skip-permissions "', "x\\\" & echo injected",
    "%PATH%!COMSPEC!$HOME`whoami`\r\nnext", "", '\"\\%!$`',
    "x&echo", "x|cmd", "x>marker", "x<marker", "x^y", "x(y)",
])
def test_name_is_single_safe_argument(name):
    manager = PtyManager()
    try:
        session, cmd, _ = _call_create(manager, name=name, model="sonnet")
        for posix in (True, False):
            args = shlex.split(cmd, posix=posix)
            if not posix:
                args = [arg.strip('"') for arg in args]
            args = _without_session_id(args)
            if name.startswith("-") or any(ord(char) < 32 or ord(char) == 127 or char in '\"\\%!$`&|<>^()' for char in name):
                assert args == ["claude", "--model", "sonnet"]
            else:
                assert args == ["claude", "--model", "sonnet", "--name", name or "Session 1"]
        assert session.name == (name or "Session 1")
    finally:
        manager._pty_executor.shutdown(wait=True)


@pytest.mark.skipif(sys.platform != "win32", reason="Real cmd.exe fallback boundary")
@pytest.mark.parametrize("name", ["Safe project", "x&echo>PWN", "x|echo>PWN"])
async def test_cmd_install_cannot_execute_session_label(tmp_path, name):
    from conpty import PtyProcess
    receiver = tmp_path / "argv.py"
    receiver.write_text(
        'import json,sys\nfrom pathlib import Path\nPath("argv.json").write_text(json.dumps(sys.argv[1:]))\n', encoding="utf-8"
    )
    launcher = tmp_path / "claude.cmd"
    launcher.write_text(f'@"{sys.executable}" "{receiver}" %*\n', encoding="utf-8")
    manager = PtyManager()
    child = None
    try:
        _, command, _ = _call_create(manager, name=name, model="sonnet")
        command = f'"{launcher}"' + command[len("claude"):]
        child = PtyProcess.spawn(command, cwd=str(tmp_path), env=dict(os.environ))
        for _ in range(100):
            if (tmp_path / "argv.json").exists() and not child.isalive():
                break
            await asyncio.sleep(0.05)
        args = _without_session_id(json.loads((tmp_path / "argv.json").read_text()))
        assert args == (["--model", "sonnet", "--name", name] if name == "Safe project" else ["--model", "sonnet"])
        assert not (tmp_path / "PWN").exists()
        if name != "Safe project":
            child.terminate(force=True)
            # Isolated negative control: prove this exact backend/wrapper
            # would execute the marker if the name guard were removed.
            child = PtyProcess.spawn(f'"{launcher}" --name "{name}"',
                                     cwd=str(tmp_path), env=dict(os.environ))
            for _ in range(100):
                if (tmp_path / "PWN").exists():
                    break
                await asyncio.sleep(0.05)
            assert (tmp_path / "PWN").exists(), "Fixture must expose the unsafe cmd boundary"
    finally:
        if child is not None:
            child.terminate(force=True)
        manager._pty_executor.shutdown(wait=True)
