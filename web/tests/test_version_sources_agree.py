"""S12 — the app must not misreport its own version. The updater keys on it.

FOUR SOURCES, THREE NUMBERS, MEASURED 2026-08-02 on the running 1.24.0 install:

  1. `frontend/package.json`            -> 1.24.0
     `tauri.conf.json` reads "../package.json", so this names the INSTALLER and
     the `latest.json` the updater compares against.
  2. `frontend/dist/assets/*.js`        -> 1.23.0
     `vite.config.js` bakes `pkg.version` into `VITE_APP_VERSION` at BUILD time.
     This is what the title bar and Settings > Updates DISPLAY.
  3. `src-tauri/Cargo.toml`             -> 1.12.1
     Stamps the Windows exe file metadata. Stale by twelve minor versions, in
     BOTH installs -- Explorer and Task Manager report 1.12.1 for a 1.24.0 build.
  4. `GET /api/version` -> `app`        -> reads package.json AT RUNTIME.

WHY THIS IS CORRECTNESS AND NOT COSMETICS. The updater compares the number the
app BELIEVES it is against GitHub Releases. A 1.24.0 install that reports 1.23.0
is perpetually offered the release it is already running -- `UpdatesSettings.jsx`
renders "nothing newer than v{appVersion}" off the baked constant. And this
program has ALREADY shipped two different binaries under `Plexar_1.23.0`, which
is the entire reason 1.24.0 exists.

WHY NO EXISTING CHECK CAUGHT IT. `server.py::_app_version` carries a comment
saying package.json is "the single source of truth ... so the API can never
disagree with the number in the title bar or the installer." Every clause of
that is reasonable and the conclusion is false: the title bar shows a constant
BAKED AT BUILD TIME, while the API reads the file AT RUNTIME. They agree only
if `dist/` was built from the current package.json -- which is precisely the
thing that failed. R15: "the thing exists" and "the thing fits" are different
findings.

And the one guard that could have surfaced it is disabled where it is needed
most: `UpdatesSettings.jsx:333` warns only `if (serverApp && serverApp !== ...)`,
but `_app_version()` returns None when package.json is not in the bundle -- so
in the PACKAGED app, the mismatch detector most likely sees null and stays
silent. A guard that only covers the case where the answer was already visible
is R11.
"""
import json
import re
from pathlib import Path

import pytest

WEB = Path(__file__).resolve().parent.parent
PACKAGE_JSON = WEB / "frontend" / "package.json"
CARGO_TOML = WEB / "frontend" / "src-tauri" / "Cargo.toml"
TAURI_CONF = WEB / "frontend" / "src-tauri" / "tauri.conf.json"
DIST_ASSETS = WEB / "frontend" / "dist" / "assets"


def _package_version() -> str:
    return json.loads(PACKAGE_JSON.read_text(encoding="utf-8"))["version"]


def _cargo_version() -> str:
    m = re.search(r'^version\s*=\s*"([^"]+)"', CARGO_TOML.read_text(encoding="utf-8"), re.M)
    assert m, "no version in Cargo.toml"
    return m.group(1)


def test_tauri_conf_still_derives_from_package_json():
    """The derivation is the only reason two of the four sources agree at all.

    Pinned because if someone ever replaces "../package.json" with a literal,
    this whole file starts comparing a number against a copy of itself and
    every assertion below goes quietly vacuous.
    """
    conf = json.loads(TAURI_CONF.read_text(encoding="utf-8"))
    assert conf["version"] == "../package.json", (
        "tauri.conf.json no longer derives its version; it is now a FOURTH "
        "independent number and the installer can disagree with the app"
    )


def test_cargo_version_matches_package_json():
    """The exe metadata must not claim a different version than the installer.

    This is the source that was stale by twelve minor versions. Cargo cannot
    read package.json, so this cannot be derived -- it has to be asserted, and
    a bump has to touch both files. That is the cost of the second source, and
    the point of this test is that the cost is a red suite rather than a wrong
    number in Explorer.
    """
    assert _cargo_version() == _package_version(), (
        f"Cargo.toml {_cargo_version()} != package.json {_package_version()}. "
        "Bump both: Cargo stamps the Windows exe file metadata."
    )


def test_built_bundle_was_built_from_the_current_package_json():
    """THE ONE THAT WOULD HAVE CAUGHT WHAT LEN SAW.

    `VITE_APP_VERSION` is frozen into the bundle when vite runs. If `dist/` is
    older than the version bump, the installer ships one number and the UI
    displays another -- the installer being right, which is the dangerous way
    round, because the updater and the user then disagree about what is
    installed.

    Skips rather than fails when `dist/` is absent: a tree with no build is not
    a tree with a WRONG build, and failing here would just teach people to
    ignore it. It is not vacuous when it matters, because the release path
    always has a dist/.
    """
    if not DIST_ASSETS.is_dir():
        pytest.skip("no built bundle in dist/ -- nothing to check")
    expected = _package_version()
    bundles = sorted(DIST_ASSETS.glob("index-*.js"))
    assert bundles, "dist/assets has no index bundle; the build is incomplete"

    found = set()
    for b in bundles:
        found.update(re.findall(r"\b\d+\.\d+\.\d+\b", b.read_text(encoding="utf-8", errors="ignore")))
    assert expected in found, (
        f"the built bundle does not contain package.json's version {expected!r}. "
        f"dist/ is STALE -- it was built before the version bump, so the "
        f"installer will say {expected} and the app will display something else. "
        f"Re-run `npm run build` (or `tauri:build`, which chains it) before "
        f"packaging. Versions seen in the bundle: {sorted(found)[:10]}"
    )
