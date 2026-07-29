"""Pure-ctypes Windows ConPTY wrapper.

Bypasses pywinpty's C extension which causes 0xC0000142 DLL failures
when spawning child processes inside PyInstaller onefile bundles.
Uses the Windows ConPTY API (CreatePseudoConsole) directly via ctypes,
with NtCreateNamedPipeFile for pipe creation (matching winpty-rs internals).
"""

from __future__ import annotations

import codecs
import ctypes
import ctypes.wintypes as wt
import os
import shutil
import subprocess
import threading
import time

kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
ntdll = ctypes.WinDLL("ntdll")
user32 = ctypes.WinDLL("user32", use_last_error=True)

# ── Constants ──
PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE = 0x00020016
EXTENDED_STARTUPINFO_PRESENT = 0x00080000
CREATE_UNICODE_ENVIRONMENT = 0x00000400
STILL_ACTIVE = 259
S_OK = 0

# NT constants
SYNCHRONIZE = 0x00100000
GENERIC_READ = 0x80000000
GENERIC_WRITE = 0x40000000
FILE_GENERIC_READ = 0x00120089
FILE_GENERIC_WRITE = 0x00120116
FILE_SHARE_READ = 0x01
FILE_SHARE_WRITE = 0x02
FILE_ATTRIBUTE_NORMAL = 0x80
OPEN_EXISTING = 3
FILE_OPEN = 0x01
FILE_CREATE = 0x02
FILE_NON_DIRECTORY_FILE = 0x40
FILE_SYNCHRONOUS_IO_NONALERT = 0x20
OBJ_CASE_INSENSITIVE = 0x40
DUPLICATE_SAME_ACCESS = 0x02
ENABLE_VIRTUAL_TERMINAL_PROCESSING = 0x0004
STD_OUTPUT_HANDLE = 0xFFFFFFF5
STD_ERROR_HANDLE = 0xFFFFFFF4
STD_INPUT_HANDLE = 0xFFFFFFF6
SW_HIDE = 0

# Job Object constants — used to kill entire process trees
JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000
JobObjectExtendedLimitInformation = 9


# ── Structures ──

class UNICODE_STRING(ctypes.Structure):
    _fields_ = [
        ("Length", wt.USHORT),
        ("MaximumLength", wt.USHORT),
        ("Buffer", ctypes.c_void_p),
    ]


class OBJECT_ATTRIBUTES(ctypes.Structure):
    _fields_ = [
        ("Length", wt.ULONG),
        ("RootDirectory", wt.HANDLE),
        ("ObjectName", ctypes.POINTER(UNICODE_STRING)),
        ("Attributes", wt.ULONG),
        ("SecurityDescriptor", ctypes.c_void_p),
        ("SecurityQualityOfService", ctypes.c_void_p),
    ]


class IO_STATUS_BLOCK(ctypes.Structure):
    _fields_ = [
        ("Status", ctypes.c_void_p),
        ("Information", ctypes.c_size_t),
    ]


class STARTUPINFOW(ctypes.Structure):
    _fields_ = [
        ("cb", wt.DWORD), ("lpReserved", wt.LPWSTR), ("lpDesktop", wt.LPWSTR),
        ("lpTitle", wt.LPWSTR), ("dwX", wt.DWORD), ("dwY", wt.DWORD),
        ("dwXSize", wt.DWORD), ("dwYSize", wt.DWORD),
        ("dwXCountChars", wt.DWORD), ("dwYCountChars", wt.DWORD),
        ("dwFillAttribute", wt.DWORD), ("dwFlags", wt.DWORD),
        ("wShowWindow", wt.WORD), ("cbReserved2", wt.WORD),
        ("lpReserved2", ctypes.c_void_p),
        ("hStdInput", wt.HANDLE), ("hStdOutput", wt.HANDLE),
        ("hStdError", wt.HANDLE),
    ]


class STARTUPINFOEXW(ctypes.Structure):
    _fields_ = [
        ("StartupInfo", STARTUPINFOW),
        ("lpAttributeList", ctypes.c_void_p),
    ]


class PROCESS_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("hProcess", wt.HANDLE), ("hThread", wt.HANDLE),
        ("dwProcessId", wt.DWORD), ("dwThreadId", wt.DWORD),
    ]


class IO_COUNTERS(ctypes.Structure):
    _fields_ = [
        ("ReadOperationCount", ctypes.c_ulonglong),
        ("WriteOperationCount", ctypes.c_ulonglong),
        ("OtherOperationCount", ctypes.c_ulonglong),
        ("ReadTransferCount", ctypes.c_ulonglong),
        ("WriteTransferCount", ctypes.c_ulonglong),
        ("OtherTransferCount", ctypes.c_ulonglong),
    ]


class JOBOBJECT_BASIC_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("PerProcessUserTimeLimit", ctypes.c_longlong),
        ("PerJobUserTimeLimit", ctypes.c_longlong),
        ("LimitFlags", wt.DWORD),
        ("MinimumWorkingSetSize", ctypes.c_size_t),
        ("MaximumWorkingSetSize", ctypes.c_size_t),
        ("ActiveProcessLimit", wt.DWORD),
        ("Affinity", ctypes.POINTER(ctypes.c_ulong)),
        ("PriorityClass", wt.DWORD),
        ("SchedulingClass", wt.DWORD),
    ]


class JOBOBJECT_EXTENDED_LIMIT_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("BasicLimitInformation", JOBOBJECT_BASIC_LIMIT_INFORMATION),
        ("IoInfo", IO_COUNTERS),
        ("ProcessMemoryLimit", ctypes.c_size_t),
        ("JobMemoryLimit", ctypes.c_size_t),
        ("PeakProcessMemoryUsed", ctypes.c_size_t),
        ("PeakJobMemoryUsed", ctypes.c_size_t),
    ]


# ── Function signatures ──

# ntdll
ntdll.NtCreateFile.argtypes = [
    ctypes.POINTER(wt.HANDLE), wt.DWORD, ctypes.POINTER(OBJECT_ATTRIBUTES),
    ctypes.POINTER(IO_STATUS_BLOCK), ctypes.c_void_p, wt.DWORD, wt.DWORD,
    wt.DWORD, wt.DWORD, ctypes.c_void_p, wt.DWORD,
]
ntdll.NtCreateFile.restype = ctypes.c_long

ntdll.NtCreateNamedPipeFile.argtypes = [
    ctypes.POINTER(wt.HANDLE), wt.DWORD, ctypes.POINTER(OBJECT_ATTRIBUTES),
    ctypes.POINTER(IO_STATUS_BLOCK), wt.DWORD, wt.DWORD, wt.DWORD,
    wt.DWORD, wt.DWORD, wt.DWORD, wt.DWORD, wt.DWORD, wt.DWORD,
    ctypes.POINTER(ctypes.c_longlong),
]
ntdll.NtCreateNamedPipeFile.restype = ctypes.c_long

# kernel32
kernel32.CreatePseudoConsole.argtypes = [
    wt.DWORD, wt.HANDLE, wt.HANDLE, wt.DWORD, ctypes.POINTER(ctypes.c_void_p),
]
kernel32.CreatePseudoConsole.restype = ctypes.c_long

kernel32.ClosePseudoConsole.argtypes = [ctypes.c_void_p]
kernel32.ClosePseudoConsole.restype = None

kernel32.ResizePseudoConsole.argtypes = [ctypes.c_void_p, wt.DWORD]
kernel32.ResizePseudoConsole.restype = ctypes.c_long

kernel32.InitializeProcThreadAttributeList.argtypes = [
    ctypes.c_void_p, wt.DWORD, wt.DWORD, ctypes.POINTER(ctypes.c_size_t),
]
kernel32.InitializeProcThreadAttributeList.restype = wt.BOOL

kernel32.UpdateProcThreadAttribute.argtypes = [
    ctypes.c_void_p, wt.DWORD, ctypes.c_size_t,
    ctypes.c_void_p, ctypes.c_size_t, ctypes.c_void_p, ctypes.POINTER(ctypes.c_size_t),
]
kernel32.UpdateProcThreadAttribute.restype = wt.BOOL

kernel32.DeleteProcThreadAttributeList.argtypes = [ctypes.c_void_p]
kernel32.DeleteProcThreadAttributeList.restype = None

kernel32.CreateProcessW.argtypes = [
    wt.LPCWSTR, wt.LPWSTR, ctypes.c_void_p, ctypes.c_void_p,
    wt.BOOL, wt.DWORD, ctypes.c_void_p, wt.LPCWSTR,
    ctypes.c_void_p, ctypes.POINTER(PROCESS_INFORMATION),
]
kernel32.CreateProcessW.restype = wt.BOOL

kernel32.CloseHandle.argtypes = [wt.HANDLE]
kernel32.CloseHandle.restype = wt.BOOL

kernel32.TerminateProcess.argtypes = [wt.HANDLE, wt.UINT]
kernel32.TerminateProcess.restype = wt.BOOL

kernel32.GetExitCodeProcess.argtypes = [wt.HANDLE, ctypes.POINTER(wt.DWORD)]
kernel32.GetExitCodeProcess.restype = wt.BOOL

kernel32.ReadFile.argtypes = [
    wt.HANDLE, ctypes.c_void_p, wt.DWORD, ctypes.POINTER(wt.DWORD), ctypes.c_void_p,
]
kernel32.ReadFile.restype = wt.BOOL

kernel32.WriteFile.argtypes = [
    wt.HANDLE, ctypes.c_void_p, wt.DWORD, ctypes.POINTER(wt.DWORD), ctypes.c_void_p,
]
kernel32.WriteFile.restype = wt.BOOL

kernel32.DuplicateHandle.argtypes = [
    wt.HANDLE, wt.HANDLE, wt.HANDLE, ctypes.POINTER(wt.HANDLE),
    wt.DWORD, wt.BOOL, wt.DWORD,
]
kernel32.DuplicateHandle.restype = wt.BOOL

kernel32.GetCurrentProcess.argtypes = []
kernel32.GetCurrentProcess.restype = wt.HANDLE

kernel32.FreeConsole.argtypes = []
kernel32.FreeConsole.restype = wt.BOOL

kernel32.AllocConsole.argtypes = []
kernel32.AllocConsole.restype = wt.BOOL

kernel32.GetConsoleWindow.argtypes = []
kernel32.GetConsoleWindow.restype = wt.HWND

kernel32.GetConsoleMode.argtypes = [wt.HANDLE, ctypes.POINTER(wt.DWORD)]
kernel32.GetConsoleMode.restype = wt.BOOL

kernel32.SetConsoleMode.argtypes = [wt.HANDLE, wt.DWORD]
kernel32.SetConsoleMode.restype = wt.BOOL

kernel32.SetStdHandle.argtypes = [wt.DWORD, wt.HANDLE]
kernel32.SetStdHandle.restype = wt.BOOL

kernel32.CreateFileW.argtypes = [
    wt.LPCWSTR, wt.DWORD, wt.DWORD, ctypes.c_void_p,
    wt.DWORD, wt.DWORD, wt.HANDLE,
]
kernel32.CreateFileW.restype = wt.HANDLE

kernel32.PeekNamedPipe.argtypes = [
    wt.HANDLE, ctypes.c_void_p, wt.DWORD,
    ctypes.POINTER(wt.DWORD), ctypes.POINTER(wt.DWORD), ctypes.POINTER(wt.DWORD),
]
kernel32.PeekNamedPipe.restype = wt.BOOL

# Job Object functions — kill entire process trees on session close
kernel32.CreateJobObjectW.argtypes = [ctypes.c_void_p, wt.LPCWSTR]
kernel32.CreateJobObjectW.restype = wt.HANDLE

kernel32.SetInformationJobObject.argtypes = [
    wt.HANDLE, ctypes.c_int, ctypes.c_void_p, wt.DWORD,
]
kernel32.SetInformationJobObject.restype = wt.BOOL

kernel32.AssignProcessToJobObject.argtypes = [wt.HANDLE, wt.HANDLE]
kernel32.AssignProcessToJobObject.restype = wt.BOOL

kernel32.TerminateJobObject.argtypes = [wt.HANDLE, wt.UINT]
kernel32.TerminateJobObject.restype = wt.BOOL

user32.ShowWindow.argtypes = [wt.HWND, ctypes.c_int]
user32.ShowWindow.restype = wt.BOOL


# ── Helpers ──

def _make_unicode_string(s):
    """Create a UNICODE_STRING with a persistent buffer."""
    if s is None:
        return UNICODE_STRING(0, 0, None), None
    buf = ctypes.create_unicode_buffer(s)
    us = UNICODE_STRING()
    us.Length = len(s) * 2
    us.MaximumLength = (len(s) + 1) * 2
    us.Buffer = ctypes.addressof(buf)
    return us, buf  # caller must keep buf alive


_console_initialized = False


def _ensure_console():
    """Ensure the process has a real Windows console with VT processing.

    ConPTY requires the calling process to have a proper console.
    In GUI apps or MSYS2/mintty, this creates a hidden console window.
    """
    global _console_initialized
    if _console_initialized:
        return

    console_allocated = kernel32.AllocConsole()
    if console_allocated:
        hwnd = kernel32.GetConsoleWindow()
        if hwnd:
            user32.ShowWindow(hwnd, SW_HIDE)
    elif not kernel32.GetConsoleWindow():
        # No console window — detach from MSYS2/Cygwin and create a real one
        kernel32.FreeConsole()
        kernel32.AllocConsole()
        hwnd = kernel32.GetConsoleWindow()
        if hwnd:
            user32.ShowWindow(hwnd, SW_HIDE)

    # Open CONOUT$/CONIN$ and enable VT processing
    h_con = kernel32.CreateFileW(
        "CONOUT$", FILE_GENERIC_READ | FILE_GENERIC_WRITE,
        FILE_SHARE_READ | FILE_SHARE_WRITE, None, OPEN_EXISTING,
        FILE_ATTRIBUTE_NORMAL, wt.HANDLE(0),
    )
    h_in = kernel32.CreateFileW(
        "CONIN$", FILE_GENERIC_READ | FILE_GENERIC_WRITE,
        FILE_SHARE_READ, None, OPEN_EXISTING, 0, wt.HANDLE(0),
    )

    if h_con and h_con != wt.HANDLE(-1).value:
        mode = wt.DWORD()
        if kernel32.GetConsoleMode(wt.HANDLE(h_con), ctypes.byref(mode)):
            kernel32.SetConsoleMode(
                wt.HANDLE(h_con), mode.value | ENABLE_VIRTUAL_TERMINAL_PROCESSING,
            )
        kernel32.SetStdHandle(wt.DWORD(STD_OUTPUT_HANDLE), wt.HANDLE(h_con))
        kernel32.SetStdHandle(wt.DWORD(STD_ERROR_HANDLE), wt.HANDLE(h_con))

    if h_in and h_in != wt.HANDLE(-1).value:
        kernel32.SetStdHandle(wt.DWORD(STD_INPUT_HANDLE), wt.HANDLE(h_in))

    _console_initialized = True


def _create_nt_pipe():
    """Create a bidirectional named pipe using NtCreateNamedPipeFile.

    Returns (server_handle, client_handle). The server handle is used by the
    host for reading and writing. The client handle is duplicated and passed
    to CreatePseudoConsole.

    This matches winpty-rs's pipe creation approach, which is required for
    ConPTY to properly bridge I/O through the pipes.
    """
    # Open \Device\NamedPipe\ directory
    dir_us, _dir_buf = _make_unicode_string("\\Device\\NamedPipe\\")
    dir_oa = OBJECT_ATTRIBUTES()
    dir_oa.Length = ctypes.sizeof(OBJECT_ATTRIBUTES)
    dir_oa.RootDirectory = None
    dir_oa.ObjectName = ctypes.pointer(dir_us)
    dir_oa.Attributes = 0
    dir_oa.SecurityDescriptor = None
    dir_oa.SecurityQualityOfService = None

    isb = IO_STATUS_BLOCK()
    dir_h = wt.HANDLE()
    status = ntdll.NtCreateFile(
        ctypes.byref(dir_h), SYNCHRONIZE | GENERIC_READ,
        ctypes.byref(dir_oa), ctypes.byref(isb),
        None, 0, FILE_SHARE_READ | FILE_SHARE_WRITE,
        FILE_OPEN, FILE_SYNCHRONOUS_IO_NONALERT, None, 0,
    )
    if status < 0:
        raise OSError(f"NtCreateFile(\\Device\\NamedPipe\\) failed: 0x{status & 0xFFFFFFFF:08x}")

    # Create server pipe (anonymous, bidirectional)
    empty_us, _empty_buf = _make_unicode_string(None)
    pipe_oa = OBJECT_ATTRIBUTES()
    pipe_oa.Length = ctypes.sizeof(OBJECT_ATTRIBUTES)
    pipe_oa.RootDirectory = dir_h
    pipe_oa.ObjectName = ctypes.pointer(empty_us)
    pipe_oa.Attributes = OBJ_CASE_INSENSITIVE
    pipe_oa.SecurityDescriptor = None
    pipe_oa.SecurityQualityOfService = None

    pisb = IO_STATUS_BLOCK()
    server = wt.HANDLE()
    timeout = ctypes.c_longlong(-10_0000_0000)  # 10s in 100ns units

    status = ntdll.NtCreateNamedPipeFile(
        ctypes.byref(server),
        SYNCHRONIZE | GENERIC_READ | GENERIC_WRITE,
        ctypes.byref(pipe_oa), ctypes.byref(pisb),
        FILE_SHARE_READ | FILE_SHARE_WRITE,
        FILE_CREATE, 0,  # CreateOptions
        0,  # FILE_PIPE_BYTE_STREAM_TYPE
        0,  # FILE_PIPE_BYTE_STREAM_MODE
        0,  # FILE_PIPE_QUEUE_OPERATION
        1,  # MaximumInstances
        128 * 1024, 128 * 1024,  # InboundQuota, OutboundQuota
        ctypes.byref(timeout),
    )
    kernel32.CloseHandle(dir_h)
    if status < 0:
        raise OSError(f"NtCreateNamedPipeFile failed: 0x{status & 0xFFFFFFFF:08x}")

    # Open client side of the pipe
    client_oa = OBJECT_ATTRIBUTES()
    client_oa.Length = ctypes.sizeof(OBJECT_ATTRIBUTES)
    client_oa.RootDirectory = server
    client_oa.ObjectName = ctypes.pointer(empty_us)
    client_oa.Attributes = OBJ_CASE_INSENSITIVE
    client_oa.SecurityDescriptor = None
    client_oa.SecurityQualityOfService = None

    cisb = IO_STATUS_BLOCK()
    client = wt.HANDLE()
    status = ntdll.NtCreateFile(
        ctypes.byref(client),
        SYNCHRONIZE | GENERIC_READ | GENERIC_WRITE,
        ctypes.byref(client_oa), ctypes.byref(cisb),
        None, 0, FILE_SHARE_READ | FILE_SHARE_WRITE,
        FILE_OPEN, FILE_NON_DIRECTORY_FILE, None, 0,
    )
    if status < 0:
        kernel32.CloseHandle(server)
        raise OSError(f"NtCreateFile(client) failed: 0x{status & 0xFFFFFFFF:08x}")

    return server.value, client.value


class PtyProcess:
    """A process running inside a Windows ConPTY pseudo-console.

    Drop-in replacement for winpty.PtyProcess that uses raw ctypes,
    avoiding pywinpty's C extension DLL issues in PyInstaller bundles.
    """

    def __init__(self):
        self._hpc = ctypes.c_void_p()
        self._pi = PROCESS_INFORMATION()
        self._server_pipe = None  # Bidirectional pipe for read/write
        self._pipe_lock = threading.RLock()  # Guards _server_pipe against concurrent close/read
        self._job = None  # Job Object handle for process tree management
        self._alive = False
        self.exitstatus = None
        # Incremental UTF-8 decoder: ConPTY output is chunked in up-to-64KB
        # reads, and multi-byte sequences (box-drawing chars, emoji) can
        # straddle a chunk boundary. A per-chunk decode() with errors="replace"
        # would mangle the split byte(s) into U+FFFD. This decoder buffers
        # incomplete trailing bytes across read() calls until the sequence
        # completes.
        self._decoder = codecs.getincrementaldecoder("utf-8")("replace")

    @classmethod
    def spawn(cls, argv, cwd=None, env=None, dimensions=(24, 80), backend=None):
        """Spawn a process in a ConPTY pseudo-console.

        Args:
            argv: Command as string or list
            cwd: Working directory
            env: Environment dict (or None for inherited)
            dimensions: (rows, cols) tuple
            backend: Ignored (always uses ConPTY)

        Returns:
            PtyProcess instance
        """
        _ensure_console()

        # Resolve command
        if isinstance(argv, str):
            import shlex
            argv = shlex.split(argv, posix=False)
            # shlex(posix=False) preserves surrounding quotes as literal chars;
            # strip them so subprocess.list2cmdline can re-add them correctly
            # when the argument contains spaces.
            argv = [a.strip('"') for a in argv]
        if isinstance(argv, (list, tuple)):
            argv = list(argv)
        else:
            raise TypeError(f"Expected str, list, or tuple for argv, got {type(argv)}")

        command = argv[0]
        path = (env or os.environ).get("PATH", os.defpath)
        resolved = shutil.which(command, path=path)
        if resolved is None:
            raise FileNotFoundError(f"Command not found: {command}")

        ext = os.path.splitext(resolved)[1].lower()
        if ext in (".cmd", ".bat"):
            sys_root = os.environ.get("SystemRoot", r"C:\Windows")
            cmd_exe = os.path.join(sys_root, "System32", "cmd.exe")
            cmdline = f'"{cmd_exe}" /c {subprocess.list2cmdline([resolved] + argv[1:])}'
            resolved = cmd_exe
        else:
            cmdline = subprocess.list2cmdline([resolved] + argv[1:])

        inst = cls()
        rows, cols = dimensions

        # Create bidirectional pipe via NT native API
        server_handle, client_handle = _create_nt_pipe()
        inst._server_pipe = server_handle

        # Duplicate client handle for ConPTY input and output
        cur_proc = kernel32.GetCurrentProcess()
        input_read = wt.HANDLE()
        output_write = wt.HANDLE()
        kernel32.DuplicateHandle(
            cur_proc, wt.HANDLE(client_handle), cur_proc,
            ctypes.byref(input_read), 0, True, DUPLICATE_SAME_ACCESS,
        )
        kernel32.DuplicateHandle(
            cur_proc, wt.HANDLE(client_handle), cur_proc,
            ctypes.byref(output_write), 0, True, DUPLICATE_SAME_ACCESS,
        )

        # Create pseudo-console
        size = wt.DWORD(cols | (rows << 16))
        hr = kernel32.CreatePseudoConsole(
            size, input_read, output_write, wt.DWORD(0), ctypes.byref(inst._hpc),
        )

        # Close ConPTY-side handles (it duplicates them internally)
        kernel32.CloseHandle(input_read)
        kernel32.CloseHandle(output_write)
        kernel32.CloseHandle(wt.HANDLE(client_handle))

        if hr != S_OK:
            kernel32.CloseHandle(wt.HANDLE(server_handle))
            inst._server_pipe = None
            raise OSError(f"CreatePseudoConsole failed: HRESULT 0x{hr & 0xFFFFFFFF:08x}")

        # Set up thread attribute list with pseudo-console
        attr_size = ctypes.c_size_t(0)
        kernel32.InitializeProcThreadAttributeList(None, 1, 0, ctypes.byref(attr_size))
        attr_buf = (ctypes.c_byte * attr_size.value)()
        if not kernel32.InitializeProcThreadAttributeList(
            ctypes.cast(attr_buf, ctypes.c_void_p), 1, 0, ctypes.byref(attr_size),
        ):
            raise ctypes.WinError()

        # Pass HPCON value directly (not byref) — matches winpty-rs and MS sample
        if not kernel32.UpdateProcThreadAttribute(
            ctypes.cast(attr_buf, ctypes.c_void_p),
            wt.DWORD(0),
            ctypes.c_size_t(PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE),
            inst._hpc,  # direct: ctypes extracts .value (the HPCON handle)
            ctypes.c_size_t(ctypes.sizeof(ctypes.c_void_p)),
            None,
            None,
        ):
            raise ctypes.WinError()

        si = STARTUPINFOEXW()
        si.StartupInfo.cb = ctypes.sizeof(si)
        si.lpAttributeList = ctypes.addressof(attr_buf)

        # Build environment block if provided
        env_ptr = None
        flags = EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT
        if env is not None:
            parts = [f"{k}={v}" for k, v in env.items()]
            env_str = "\0".join(parts) + "\0\0"
            env_buf = ctypes.create_unicode_buffer(env_str)
            env_ptr = ctypes.cast(env_buf, ctypes.c_void_p)

        # Create process
        pi = PROCESS_INFORMATION()
        ok = kernel32.CreateProcessW(
            resolved,
            cmdline,
            None, None, False,
            wt.DWORD(flags),
            env_ptr,
            cwd,
            ctypes.byref(si),
            ctypes.byref(pi),
        )

        kernel32.DeleteProcThreadAttributeList(ctypes.cast(attr_buf, ctypes.c_void_p))

        if not ok:
            err = ctypes.get_last_error()
            # Clean up all allocated resources on failure
            kernel32.ClosePseudoConsole(inst._hpc)
            inst._hpc = ctypes.c_void_p()
            kernel32.CloseHandle(wt.HANDLE(inst._server_pipe))
            inst._server_pipe = None
            raise OSError(f"CreateProcessW failed: error {err} (0x{err:08x})")

        inst._pi = pi
        inst._alive = True

        # Create a Job Object so we can kill the entire process tree
        # (cmd.exe → node.exe → child workers) when the session ends.
        # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE ensures all processes die
        # when the Job handle is closed, even if we crash.
        job = kernel32.CreateJobObjectW(None, None)
        if job:
            info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION()
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            kernel32.SetInformationJobObject(
                job, JobObjectExtendedLimitInformation,
                ctypes.byref(info), ctypes.sizeof(info),
            )
            kernel32.AssignProcessToJobObject(job, pi.hProcess)
            inst._job = job

        return inst

    def isalive(self) -> bool:
        """Check if the process is still running."""
        if not self._alive:
            return False
        code = wt.DWORD()
        kernel32.GetExitCodeProcess(self._pi.hProcess, ctypes.byref(code))
        if code.value != STILL_ACTIVE:
            self._alive = False
            self.exitstatus = code.value
            return False
        return True

    def read(self, size: int = 65536, timeout_ms: int = 500) -> str:
        """Read from the pseudo-console output with timeout.

        Uses PeekNamedPipe to poll for available data, avoiding indefinite
        blocking that can strand executor threads when a session dies.
        Returns empty string on timeout (no data within timeout_ms).
        Reads ALL available data (up to *size* bytes) in one call to avoid
        delivering partial output across multiple read cycles.

        The pipe lock prevents the read from racing with _cleanup() which
        closes the handle from another thread.
        """
        avail = wt.DWORD(0)
        deadline = time.monotonic() + timeout_ms / 1000.0

        while time.monotonic() < deadline:
            with self._pipe_lock:
                pipe = self._server_pipe
                if pipe is None:
                    raise EOFError("Pty is closed")
                ok = kernel32.PeekNamedPipe(
                    wt.HANDLE(pipe), None, wt.DWORD(0),
                    None, ctypes.byref(avail), None,
                )
            if not ok:
                if not self.isalive():
                    raise EOFError("Process exited")
                return ""
            if avail.value > 0:
                break
            if not self.isalive():
                raise EOFError("Process exited")
            time.sleep(0.01)
        else:
            return ""  # Timeout — no data available

        # Read all available data up to *size* bytes (won't block)
        read_size = min(size, avail.value)
        buf = ctypes.create_string_buffer(read_size)
        n = wt.DWORD()
        with self._pipe_lock:
            pipe = self._server_pipe
            if pipe is None:
                raise EOFError("Pty is closed")
            ok = kernel32.ReadFile(
                wt.HANDLE(pipe), buf, wt.DWORD(read_size),
                ctypes.byref(n), None,
            )
        if not ok or n.value == 0:
            if not self.isalive():
                raise EOFError("Process exited")
            return ""
        return self._decoder.decode(buf.raw[: n.value])

    def write(self, data: str) -> None:
        """Write to the pseudo-console input.

        Handles partial writes by looping until all bytes are sent.
        Large pastes are written in chunks to avoid overwhelming the pipe.
        """
        raw = data.encode("utf-8") if isinstance(data, str) else data
        total = len(raw)
        offset = 0
        chunk_size = 4096  # Write in manageable chunks for ConPTY

        while offset < total:
            chunk = raw[offset:offset + chunk_size]
            n = wt.DWORD()
            with self._pipe_lock:
                pipe = self._server_pipe
                if pipe is None:
                    return
                ok = kernel32.WriteFile(
                    wt.HANDLE(pipe), chunk, wt.DWORD(len(chunk)),
                    ctypes.byref(n), None,
                )
            if not ok:
                import logging
                logging.getLogger("cockpit.pty").warning(
                    "WriteFile failed at offset %d/%d (error %d)",
                    offset, total, ctypes.get_last_error(),
                )
                return
            if n.value == 0:
                import logging
                logging.getLogger("cockpit.pty").warning(
                    "WriteFile wrote 0 bytes at offset %d/%d", offset, total,
                )
                return
            offset += n.value

    def setwinsize(self, rows: int, cols: int) -> None:
        """Resize the pseudo-console."""
        size = wt.DWORD(cols | (rows << 16))
        kernel32.ResizePseudoConsole(self._hpc, size)

    def terminate(self, force: bool = False) -> None:
        """Terminate the process and all its children via Job Object."""
        if not self._alive and not self._pi.hProcess:
            return
        if self._pi.hProcess and not force:
            try:
                self.write("\x03")  # Ctrl+C
                for _ in range(20):  # Wait up to 2s
                    time.sleep(0.1)
                    if not self.isalive():
                        self._cleanup()
                        return
            except Exception:
                import logging
                logging.getLogger("cockpit.pty").debug(
                    "Graceful terminate (Ctrl+C) failed — falling back to force kill", exc_info=True,
                )
        # Kill entire process tree via Job Object (cmd.exe + node.exe + children)
        if self._job:
            kernel32.TerminateJobObject(self._job, 1)
        elif self._pi.hProcess:
            kernel32.TerminateProcess(self._pi.hProcess, 1)
        self._cleanup()

    def _cleanup(self):
        """Close all handles including the Job Object.

        The pipe lock ensures that reader/writer threads see _server_pipe
        become None *before* the handle is closed, preventing use-after-close.
        """
        self._alive = False
        # Flush and reset the incremental decoder so any buffered partial
        # sequence is dropped rather than leaking into a future PTY reuse.
        try:
            self._decoder.reset()
        except Exception:
            pass
        if self._hpc:
            kernel32.ClosePseudoConsole(self._hpc)
            self._hpc = ctypes.c_void_p()
        if self._pi.hProcess:
            kernel32.CloseHandle(self._pi.hProcess)
            self._pi.hProcess = None
        if self._pi.hThread:
            kernel32.CloseHandle(self._pi.hThread)
            self._pi.hThread = None
        # Atomically grab and clear _server_pipe so concurrent readers
        # see None and bail out before we close the underlying handle.
        with self._pipe_lock:
            pipe = self._server_pipe
            self._server_pipe = None
        if pipe:
            kernel32.CloseHandle(wt.HANDLE(pipe))
        # Close Job Object last — JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        # ensures any remaining processes in the job are killed
        if self._job:
            kernel32.CloseHandle(self._job)
            self._job = None

    def __del__(self):
        try:
            self._cleanup()
        except Exception:
            import logging
            logging.getLogger("cockpit.pty").debug("Cleanup failed in __del__", exc_info=True)
