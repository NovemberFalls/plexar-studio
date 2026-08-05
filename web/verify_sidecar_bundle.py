"""Assert the sidecar's EMBEDDED frontend is the one currently in dist/.

WHY THIS EXISTS (measured 2026-08-05, shipped broken in 1.32.0 and 1.33.0):
the desktop app embeds no frontend at all -- `tauri.conf.json` sets
`frontendDist: "http://localhost:8420"`, so the window is a thin webview over
the sidecar's HTTP server. The bundle a user actually sees is the copy
PyInstaller froze into `cockpit-server.exe` via the spec's `frontend_dist`
datas entry, NOT `frontend/dist` on disk.

So build ORDER is load-bearing: vite must run BEFORE PyInstaller. Run it after
and the sidecar carries the PREVIOUS release's UI while every other version
source reads correct. That is exactly what happened -- `scripts/check-version-
sources.mjs` compared package.json / tauri.conf / Cargo.toml / both lockfiles
/ dist and found them all in agreement on the new version, because each one
WAS. None of them is the bundle that gets served. The only visible symptom was
the version pill disagreeing with `/api/version`, and the pill was right.

A timestamp comparison would not do: rebuilding the sidecar makes it newer than
dist while still carrying stale contents. This compares the bytes.
"""
from __future__ import annotations

import hashlib
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DIST = ROOT / "frontend" / "dist"
DEFAULT_EXE = ROOT / "dist" / "claude-cockpit.exe"


def _embedded_index(exe: Path) -> bytes:
    """Pull frontend_dist/index.html back out of the onefile archive."""
    from PyInstaller.archive.readers import CArchiveReader

    reader = CArchiveReader(str(exe))
    # PyInstaller normalises data paths with forward slashes on every platform.
    for name in ("frontend_dist/index.html", "frontend_dist\\index.html"):
        try:
            return reader.extract(name)
        except KeyError:
            continue
    raise SystemExit(
        f"FAIL: {exe.name} contains no frontend_dist/index.html -- the spec's "
        "datas entry is missing, so the sidecar serves no UI at all."
    )


def main(argv: list[str]) -> int:
    exe = Path(argv[1]) if len(argv) > 1 else DEFAULT_EXE
    on_disk = DIST / "index.html"
    if not exe.is_file():
        raise SystemExit(f"FAIL: no sidecar at {exe}")
    if not on_disk.is_file():
        raise SystemExit(f"FAIL: no built frontend at {on_disk}")

    embedded = _embedded_index(exe)
    current = on_disk.read_bytes()
    if embedded == current:
        digest = hashlib.sha256(current).hexdigest()[:12]
        print(f"sidecar bundle check OK -- embedded index.html matches "
              f"frontend/dist (sha256 {digest})")
        return 0

    def assets(blob: bytes) -> list[str]:
        text = blob.decode("utf-8", "replace")
        return sorted({
            frag.split('"')[0].split("'")[0]
            for frag in text.split("assets/")[1:]
        })

    print("FAIL: the sidecar carries a DIFFERENT frontend than frontend/dist.")
    print("      Almost certainly PyInstaller ran before vite. Correct order:")
    print("      npm run build  ->  PyInstaller  ->  copy sidecar  ->  tauri build")
    print(f"  embedded in {exe.name}: {assets(embedded)}")
    print(f"  frontend/dist       : {assets(current)}")
    return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
