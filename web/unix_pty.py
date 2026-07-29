"""Unix (Linux/macOS) PTY backend for Claude Cockpit.

Uses the ptyprocess library to spawn and manage pseudo-terminal processes.
This is the non-Windows counterpart to conpty.py.
"""

from __future__ import annotations

import codecs
import logging
import os
import select
import shlex

from ptyprocess import PtyProcess as _PtyProcess

from pty_backend import PtyProcess

logger = logging.getLogger("cockpit.pty")


class UnixPtyProcess(PtyProcess):
    """A process running inside a Unix PTY via ptyprocess.

    Implements the PtyProcess ABC for Linux and macOS platforms.
    """

    def __init__(self):
        self._pty: _PtyProcess | None = None
        # Incremental UTF-8 decoder: reads can split a multi-byte character
        # (box-drawing, emoji) across the chunk boundary. A per-chunk
        # decode(errors="replace") would mangle the split byte(s) into
        # U+FFFD; this decoder buffers incomplete trailing bytes across
        # read() calls until the sequence completes.
        self._decoder = codecs.getincrementaldecoder("utf-8")("replace")

    @classmethod
    def spawn(
        cls,
        argv,
        cwd: str | None = None,
        env: dict | None = None,
        dimensions: tuple[int, int] = (24, 80),
        **kwargs,
    ) -> "UnixPtyProcess":
        """Spawn a process inside a Unix PTY.

        Args:
            argv: Command as a string (e.g. "claude --model sonnet") or list.
                  Strings are split with shlex in POSIX mode.
            cwd: Working directory for the child process.
            env: Environment dict (or None to inherit).
            dimensions: (rows, cols) tuple — matches ptyprocess convention.

        Returns:
            UnixPtyProcess instance with the child process running.
        """
        # argv arrives as a string from pty_manager.py — convert to list.
        if isinstance(argv, str):
            argv_list = shlex.split(argv, posix=True)
        elif isinstance(argv, (list, tuple)):
            argv_list = list(argv)
        else:
            raise TypeError(f"Expected str, list, or tuple for argv, got {type(argv)}")

        inst = cls()
        inst._pty = _PtyProcess.spawn(
            argv_list,
            env=env,
            dimensions=dimensions,
            cwd=cwd,
        )
        return inst

    def isalive(self) -> bool:
        """Return True if the child process is still running."""
        return self._pty.isalive()

    def read(self, size: int = 65536) -> str:
        """Read available output from the PTY (non-blocking).

        Uses select() with a 0.5s timeout to avoid blocking the executor
        thread indefinitely. Returns empty string if no data is available
        within the timeout window.

        Raises EOFError when the child process has exited and no more data
        is available — pty_manager.py:569 depends on this to detect session
        death.
        """
        try:
            ready, _, _ = select.select([self._pty.fd], [], [], 0.5)
        except (ValueError, OSError):
            # fd is closed or invalid
            raise EOFError("PTY file descriptor closed")

        if not ready:
            # No data within timeout — check if process is still alive.
            if not self._pty.isalive():
                raise EOFError("Process exited")
            return ""

        try:
            data = os.read(self._pty.fd, size)
        except OSError:
            # fd closed between select() and read() — process is gone.
            raise EOFError("PTY read failed — fd closed")

        if not data:
            raise EOFError("Process exited")

        # Instances constructed via __new__() (bypassing __init__, as some
        # tests do) may not have _decoder set — fall back to a fresh one.
        decoder = getattr(self, "_decoder", None)
        if decoder is None:
            decoder = self._decoder = codecs.getincrementaldecoder("utf-8")("replace")
        return decoder.decode(data)

    def write(self, data: str) -> None:
        """Write data to the PTY stdin.

        ptyprocess.write() expects bytes, so we encode the string first.
        """
        try:
            self._pty.write(data.encode("utf-8"))
        except OSError:
            logger.warning("PTY write failed — fd may be closed")

    def setwinsize(self, rows: int, cols: int) -> None:
        """Resize the PTY dimensions."""
        self._pty.setwinsize(rows, cols)

    def terminate(self, force: bool = False) -> None:
        """Terminate the child process.

        Args:
            force: If True, send SIGKILL instead of SIGHUP.
        """
        self._pty.terminate(force=force)
        # Flush/reset the incremental decoder so any buffered partial
        # sequence is dropped rather than leaking into a future PTY reuse.
        try:
            self._decoder.reset()
        except Exception:
            pass

    @property
    def pid(self) -> int | None:
        """PID of the child process, for crash-recovery tracking."""
        return getattr(self._pty, "pid", None)

    @property
    def exitstatus(self) -> int | None:
        """Exit code of the process, or None if still running."""
        return self._pty.exitstatus
