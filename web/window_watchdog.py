"""Replace a hung desktop window without touching the sessions behind it.

Measured 2026-10-26: the Tauri host (`plexar-studio.exe`) deadlocked on its own
main thread (a re-entrant window proc waiting on a lock inside tauri/wry). The
WebView2 renderer kept painting, so panes visibly updated behind Windows' white
"(Not Responding)" ghost, but every keystroke routes through the host thread, so
Ctrl+R could not reach the page. The sidecar was healthy throughout.

The sidecar outlives the window on purpose (see `instance_guard`), so the cure
is to end ONLY the window process and launch it again: the new window's sidecar
exits 3 ("attached") and the page reattaches every live session. This module
does that unattended, from the one process that stays healthy.

Rules, each load-bearing:
- A process is ended only when its executable basename is `WINDOW_EXE`, checked
  again immediately before the kill. Never a sidecar, never a stranger.
- "Hung" is Windows' own verdict (`IsHungAppWindow`: no message pumped for ~5 s),
  sustained for `HUNG_AFTER_S`, so a long synchronous paint is not a hang.
- A minidump is written BEFORE the kill. A restart that destroys its own
  evidence would leave the root cause unmeasured forever.
- At most `MAX_RESTARTS` per `RESTART_WINDOW_S`: a window that hangs on every
  launch must not be killed in a loop.
- Runs only in the frozen (installed) build, or with PLEXAR_WINDOW_WATCHDOG=1.
  PLEXAR_WINDOW_WATCHDOG=0 disables it everywhere.
"""

from __future__ import annotations

import asyncio
import logging
import os
import subprocess
import sys
import time
from pathlib import Path

logger = logging.getLogger("cockpit.window_watchdog")

WINDOW_EXE = "plexar-studio.exe"
POLL_S = 5.0
HUNG_AFTER_S = 30.0
MAX_RESTARTS = 3
RESTART_WINDOW_S = 3600.0
DUMPS_KEPT = 3


class HangTracker:
    """Pure decision logic: which pids have been hung long enough to replace."""

    def __init__(self, hung_after: float = HUNG_AFTER_S, max_restarts: int = MAX_RESTARTS,
                 window: float = RESTART_WINDOW_S):
        self.hung_after = hung_after
        self.max_restarts = max_restarts
        self.window = window
        self.hung_since: dict[int, float] = {}
        self.restarts: list[float] = []
        self._limit_logged = False

    def observe(self, now: float, hung: set[int]) -> list[int]:
        """Record one probe; return the pids due for replacement now."""
        for pid in list(self.hung_since):
            if pid not in hung:
                del self.hung_since[pid]
        for pid in hung:
            self.hung_since.setdefault(pid, now)
        due = [p for p, t in self.hung_since.items() if now - t >= self.hung_after]
        if not due:
            return []
        self.restarts = [t for t in self.restarts if now - t < self.window]
        if len(self.restarts) >= self.max_restarts:
            if not self._limit_logged:
                logger.warning("Window hung but %d restarts in the last %.0f s; not restarting again",
                               len(self.restarts), self.window)
                self._limit_logged = True
            return []
        self._limit_logged = False
        return due

    def restarted(self, pid: int, now: float) -> None:
        self.hung_since.pop(pid, None)
        self.restarts.append(now)


def enabled() -> bool:
    flag = os.getenv("PLEXAR_WINDOW_WATCHDOG")
    if flag == "0" or sys.platform != "win32":
        return False
    return flag == "1" or bool(getattr(sys, "frozen", False))


def _window_pids() -> dict[int, bool]:
    """{pid: any visible top-level window hung} for every WINDOW_EXE process."""
    import ctypes
    from ctypes import wintypes

    import psutil

    user32 = ctypes.windll.user32
    found: dict[int, bool] = {}
    names: dict[int, bool] = {}

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def _each(hwnd, _lparam):
        if not user32.IsWindowVisible(hwnd):
            return True
        pid = wintypes.DWORD()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        p = pid.value
        if p not in names:
            try:
                names[p] = psutil.Process(p).name().lower() == WINDOW_EXE
            except (psutil.Error, OSError):
                names[p] = False
        if names[p]:
            found[p] = found.get(p, False) or bool(user32.IsHungAppWindow(hwnd))
        return True

    user32.EnumWindows(_each, 0)
    return found


def _write_dump(pid: int, dump_dir: Path) -> Path | None:
    """MiniDumpWithFullMemory-lite (type 0x2: with handle data) of `pid`."""
    import ctypes
    from ctypes import wintypes

    dump_dir.mkdir(parents=True, exist_ok=True)
    path = dump_dir / f"window-hang-{time.strftime('%Y%m%d-%H%M%S')}-{pid}.dmp"
    kernel32 = ctypes.windll.kernel32
    dbghelp = ctypes.windll.dbghelp
    kernel32.OpenProcess.restype = wintypes.HANDLE
    handle = kernel32.OpenProcess(0x0400 | 0x0010, False, pid)  # QUERY_INFORMATION | VM_READ
    if not handle:
        logger.warning("Cannot open hung window pid %d for a dump", pid)
        return None
    try:
        with open(path, "wb") as f:
            import msvcrt
            fh = msvcrt.get_osfhandle(f.fileno())
            ok = dbghelp.MiniDumpWriteDump(wintypes.HANDLE(handle), pid, wintypes.HANDLE(fh),
                                           0x2, None, None, None)
        if not ok:
            path.unlink(missing_ok=True)
            logger.warning("MiniDumpWriteDump failed for pid %d", pid)
            return None
    finally:
        kernel32.CloseHandle(wintypes.HANDLE(handle))
    for old in sorted(dump_dir.glob("window-hang-*.dmp"))[:-DUMPS_KEPT]:
        try:
            old.unlink()
        except OSError:
            logger.debug("Could not prune old dump %s", old, exc_info=True)
    return path


def _replace(pid: int, dump_dir: Path) -> bool:
    """Dump, end and relaunch one hung window. True if a new window was launched."""
    import psutil

    try:
        proc = psutil.Process(pid)
        if proc.name().lower() != WINDOW_EXE:
            logger.warning("pid %d is no longer %s; leaving it alone", pid, WINDOW_EXE)
            return False
        exe = proc.exe()
    except psutil.Error:
        logger.info("Hung window pid %d already gone", pid, exc_info=True)
        return False

    try:
        dump = _write_dump(pid, dump_dir)
    except Exception:
        dump = None
        logger.warning("Dump of hung window pid %d failed", pid, exc_info=True)

    try:
        proc.kill()
        proc.wait(timeout=10)
    except psutil.Error:
        logger.warning("Could not end hung window pid %d", pid, exc_info=True)
        return False

    flags = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
    try:
        subprocess.Popen([exe], creationflags=flags | 0x01000000, close_fds=True)  # BREAKAWAY_FROM_JOB
    except OSError:
        subprocess.Popen([exe], creationflags=flags, close_fds=True)
    logger.warning("Window pid %d was hung; ended it and relaunched %s (dump: %s). Sessions kept.",
                   pid, exe, dump or "none")
    return True


async def run(dump_dir: Path) -> None:
    """Poll forever. Every blocking call runs in a thread; nothing here may stall the loop."""
    tracker = HangTracker()
    while True:
        try:
            windows = await asyncio.to_thread(_window_pids)
            hung = {pid for pid, h in windows.items() if h}
            for pid in tracker.observe(time.monotonic(), hung):
                # Counted even on failure, so a kill that keeps failing is rate-limited too.
                await asyncio.to_thread(_replace, pid, dump_dir)
                tracker.restarted(pid, time.monotonic())
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.warning("Window watchdog probe failed", exc_info=True)
        await asyncio.sleep(POLL_S)
