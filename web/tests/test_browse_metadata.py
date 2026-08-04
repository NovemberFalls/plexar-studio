"""Tests for the enriched folder browser: GET /api/browse `entries` metadata
and GET /api/browse/git (the only place a `git status` subprocess runs).

Key invariants under test:
  * `dirs` keeps its legacy shape (list of absolute path strings) -- the
    existing NewSessionDialog consumes it and must not break.
  * `entries` is parallel to `dirs` (same order, same length).
  * branch comes from a direct read of .git/HEAD (ref: + detached sha), and
    works when .git is a FILE (worktree) as well as a directory.
  * heavy dirs are marked skipped and never walked.
  * entry_count is null (not 0) when the directory can't be read.
  * /api/browse/git degrades to dirty=null on timeout -- never a false clean.
"""

from __future__ import annotations

import os
import subprocess
import sys
from types import SimpleNamespace

import pytest
from httpx import AsyncClient, ASGITransport

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

import logging_config
logging_config.setup("WARNING")

import server as server_module
from server import app


@pytest.fixture()
def client():
    transport = ASGITransport(app=app)
    return AsyncClient(transport=transport, base_url="http://127.0.0.1:8420")


def _mk_git_dir(root, name, head_content):
    d = root / name
    (d / ".git").mkdir(parents=True)
    (d / ".git" / "HEAD").write_text(head_content, encoding="utf-8")
    return d


# -- backward compatibility ------------------------------------------------


@pytest.mark.asyncio
async def test_dirs_shape_unchanged_and_entries_parallel(client, tmp_path):
    for name in ("web", "backlog", "docs"):
        (tmp_path / name).mkdir()
    (tmp_path / "afile.txt").write_text("x", encoding="utf-8")

    res = await client.get("/api/browse", params={"path": str(tmp_path)})
    assert res.status_code == 200
    data = res.json()

    assert isinstance(data["dirs"], list)
    assert all(isinstance(d, str) for d in data["dirs"]), "dirs must stay plain strings"
    assert sorted(os.path.basename(d) for d in data["dirs"]) == ["backlog", "docs", "web"]
    assert data["parent"] == str(tmp_path)

    assert len(data["entries"]) == len(data["dirs"])
    assert [e["path"] for e in data["entries"]] == data["dirs"]
    assert [e["name"] for e in data["entries"]] == [os.path.basename(d) for d in data["dirs"]]


@pytest.mark.asyncio
async def test_drive_roots_include_entries(client):
    res = await client.get("/api/browse")
    data = res.json()
    assert len(data["dirs"]) > 0
    assert len(data["entries"]) == len(data["dirs"])


@pytest.mark.asyncio
async def test_nonexistent_path_behaves_as_before(client):
    res = await client.get("/api/browse", params={"path": "Z:\\definitely_not_real_path_xyz"})
    assert res.status_code == 200
    data = res.json()
    assert data["dirs"] == []
    assert data["entries"] == []


@pytest.mark.asyncio
async def test_traversal_path_does_not_escape_or_error(client, tmp_path):
    weird = str(tmp_path / ".." / ".." / "nope_not_here_xyz")
    res = await client.get("/api/browse", params={"path": weird})
    assert res.status_code == 200
    assert res.json()["dirs"] == []


@pytest.mark.asyncio
async def test_partial_prefix_listing_has_entries(client, tmp_path):
    (tmp_path / "alpha").mkdir()
    (tmp_path / "beta").mkdir()
    res = await client.get("/api/browse", params={"path": str(tmp_path / "al")})
    data = res.json()
    assert [os.path.basename(d) for d in data["dirs"]] == ["alpha"]
    assert len(data["entries"]) == 1
    assert data["entries"][0]["name"] == "alpha"


@pytest.mark.asyncio
async def test_hidden_dirs_still_filtered(client, tmp_path):
    (tmp_path / "visible").mkdir()
    (tmp_path / ".hidden").mkdir()
    data = (await client.get("/api/browse", params={"path": str(tmp_path)})).json()
    assert [os.path.basename(d) for d in data["dirs"]] == ["visible"]


# -- git / branch parsing --------------------------------------------------


def test_branch_from_ref_head(tmp_path):
    d = _mk_git_dir(tmp_path, "repo", "ref: refs/heads/feature/local-model-picker\n")
    assert server_module._git_branch_from_head(str(d)) == (True, "feature/local-model-picker")


def test_branch_detached_head_short_sha(tmp_path):
    d = _mk_git_dir(tmp_path, "repo", "6294705f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d\n")
    is_git, branch = server_module._git_branch_from_head(str(d))
    assert is_git is True
    assert branch == "6294705"


def test_worktree_git_as_a_file(tmp_path):
    real = tmp_path / "realgit"
    real.mkdir()
    (real / "HEAD").write_text("ref: refs/heads/wt-branch\n", encoding="utf-8")
    wt = tmp_path / "worktree"
    wt.mkdir()
    (wt / ".git").write_text(f"gitdir: {real}\n", encoding="utf-8")
    assert server_module._git_branch_from_head(str(wt)) == (True, "wt-branch")


def test_worktree_git_file_relative_gitdir(tmp_path):
    real = tmp_path / "gitstore"
    real.mkdir()
    (real / "HEAD").write_text("ref: refs/heads/rel\n", encoding="utf-8")
    wt = tmp_path / "wt2"
    wt.mkdir()
    (wt / ".git").write_text("gitdir: ../gitstore\n", encoding="utf-8")
    assert server_module._git_branch_from_head(str(wt)) == (True, "rel")


def test_non_git_dir(tmp_path):
    d = tmp_path / "plain"
    d.mkdir()
    assert server_module._git_branch_from_head(str(d)) == (False, None)


def test_unreadable_head_yields_git_true_branch_none(tmp_path):
    d = tmp_path / "repo"
    (d / ".git").mkdir(parents=True)  # no HEAD file at all
    assert server_module._git_branch_from_head(str(d)) == (True, None)


def test_git_file_without_gitdir_marker(tmp_path):
    d = tmp_path / "odd"
    d.mkdir()
    (d / ".git").write_text("garbage\n", encoding="utf-8")
    assert server_module._git_branch_from_head(str(d)) == (True, None)


@pytest.mark.asyncio
async def test_entry_reports_git_and_branch_and_null_dirty(client, tmp_path):
    _mk_git_dir(tmp_path, "repo", "ref: refs/heads/main\n")
    (tmp_path / "plain").mkdir()

    data = (await client.get("/api/browse", params={"path": str(tmp_path)})).json()
    by_name = {e["name"]: e for e in data["entries"]}
    assert by_name["repo"]["git"] is True
    assert by_name["repo"]["branch"] == "main"
    assert by_name["repo"]["dirty"] is None, "listing must never compute dirty"
    assert by_name["plain"]["git"] is False
    assert by_name["plain"]["branch"] is None
    assert by_name["plain"]["dirty"] is None


# -- skipped dirs ----------------------------------------------------------


@pytest.mark.parametrize("name", [
    "node_modules", ".git", "venv", ".venv", "__pycache__",
    "dist", "build", ".next", "target",
])
def test_heavy_dirs_marked_skipped_and_not_walked(tmp_path, name, monkeypatch):
    d = tmp_path / name
    d.mkdir()
    (d / "child").mkdir()

    def boom(*a, **kw):
        raise AssertionError("scandir must not be called on a skipped dir")

    monkeypatch.setattr(server_module.os, "scandir", boom)
    entry = server_module._browse_entry(str(d))
    assert entry["skipped"] is True
    assert entry["entry_count"] is None


@pytest.mark.asyncio
async def test_skipped_dirs_still_listed(client, tmp_path):
    (tmp_path / "node_modules").mkdir()
    (tmp_path / "src").mkdir()
    data = (await client.get("/api/browse", params={"path": str(tmp_path)})).json()
    by_name = {e["name"]: e for e in data["entries"]}
    assert set(by_name) == {"node_modules", "src"}
    assert by_name["node_modules"]["skipped"] is True
    assert by_name["src"]["skipped"] is False


# -- entry_count -----------------------------------------------------------


def test_entry_count_counts_all_entries(tmp_path):
    d = tmp_path / "proj"
    d.mkdir()
    (d / "a").mkdir()
    (d / "b").mkdir()
    (d / "c.txt").write_text("x", encoding="utf-8")
    assert server_module._browse_entry(str(d))["entry_count"] == 3


def test_entry_count_null_on_permission_error(tmp_path, monkeypatch):
    d = tmp_path / "locked"
    d.mkdir()

    def denied(path):
        raise PermissionError("nope")

    monkeypatch.setattr(server_module.os, "scandir", denied)
    entry = server_module._browse_entry(str(d))
    assert entry["entry_count"] is None, "PermissionError must yield null, not 0"
    assert entry["name"] == "locked"


def test_one_bad_directory_does_not_fail_the_listing(tmp_path, monkeypatch):
    d = tmp_path / "weird"
    d.mkdir()

    def boom(_p):
        raise OSError("device not ready")

    monkeypatch.setattr(server_module.os, "scandir", boom)
    entry = server_module._browse_entry(str(d))
    assert entry["entry_count"] is None
    assert entry["git"] is False


# -- session_count ---------------------------------------------------------


def test_session_count_counts_at_and_under_path(tmp_path, monkeypatch):
    root = tmp_path / "Code"
    proj = root / "proj"
    (proj / "sub").mkdir(parents=True)
    other = tmp_path / "Elsewhere"
    other.mkdir()

    sessions = {
        "t1": SimpleNamespace(working_dir=str(proj)),
        "t2": SimpleNamespace(working_dir=str(proj / "sub")),
        "t3": SimpleNamespace(working_dir=str(other)),
        "t4": SimpleNamespace(working_dir=""),
    }
    monkeypatch.setattr(server_module, "pty_manager", SimpleNamespace(sessions=sessions))

    assert server_module._browse_entry(str(proj))["session_count"] == 2
    assert server_module._browse_entry(str(other))["session_count"] == 1
    assert server_module._browse_entry(str(root))["session_count"] == 2


def test_session_count_does_not_match_sibling_prefix(tmp_path, monkeypatch):
    (tmp_path / "app").mkdir()
    (tmp_path / "app-two").mkdir()
    sessions = {"t1": SimpleNamespace(working_dir=str(tmp_path / "app-two"))}
    monkeypatch.setattr(server_module, "pty_manager", SimpleNamespace(sessions=sessions))
    assert server_module._browse_entry(str(tmp_path / "app"))["session_count"] == 0


# -- /api/browse/git -------------------------------------------------------


@pytest.mark.asyncio
async def test_browse_git_reports_dirty(client, tmp_path, monkeypatch):
    d = _mk_git_dir(tmp_path, "repo", "ref: refs/heads/main\n")

    def fake_run(argv, **kw):
        assert argv == ["git", "status", "--porcelain"]
        assert kw.get("shell") is None or kw.get("shell") is False
        return subprocess.CompletedProcess(argv, 0, stdout=" M a.py\n?? b.py\n", stderr="")

    monkeypatch.setattr(server_module.subprocess, "run", fake_run)
    data = (await client.get("/api/browse/git", params={"path": str(d)})).json()
    assert data == {"git": True, "branch": "main", "dirty": True, "changed": 2}


@pytest.mark.asyncio
async def test_browse_git_reports_clean(client, tmp_path, monkeypatch):
    d = _mk_git_dir(tmp_path, "repo", "ref: refs/heads/dev\n")
    monkeypatch.setattr(
        server_module.subprocess, "run",
        lambda argv, **kw: subprocess.CompletedProcess(argv, 0, stdout="\n", stderr=""),
    )
    data = (await client.get("/api/browse/git", params={"path": str(d)})).json()
    assert data == {"git": True, "branch": "dev", "dirty": False, "changed": 0}


@pytest.mark.asyncio
async def test_browse_git_timeout_yields_null_dirty(client, tmp_path, monkeypatch):
    d = _mk_git_dir(tmp_path, "repo", "ref: refs/heads/main\n")

    def slow(argv, **kw):
        raise subprocess.TimeoutExpired(argv, kw.get("timeout", 3))

    monkeypatch.setattr(server_module.subprocess, "run", slow)
    data = (await client.get("/api/browse/git", params={"path": str(d)})).json()
    assert data["git"] is True
    assert data["branch"] == "main"
    assert data["dirty"] is None, "a timeout must never render as clean"
    assert data["changed"] is None


@pytest.mark.asyncio
async def test_browse_git_passes_hard_timeout(client, tmp_path, monkeypatch):
    d = _mk_git_dir(tmp_path, "repo", "ref: refs/heads/main\n")
    seen = {}

    def capture(argv, **kw):
        seen.update(kw)
        return subprocess.CompletedProcess(argv, 0, stdout="", stderr="")

    monkeypatch.setattr(server_module.subprocess, "run", capture)
    await client.get("/api/browse/git", params={"path": str(d)})
    assert seen["timeout"] == server_module._GIT_STATUS_TIMEOUT
    assert seen["timeout"] <= 3.0


@pytest.mark.asyncio
async def test_browse_git_non_git_dir(client, tmp_path):
    d = tmp_path / "plain"
    d.mkdir()
    data = (await client.get("/api/browse/git", params={"path": str(d)})).json()
    assert data == {"git": False, "branch": None, "dirty": None, "changed": None}


@pytest.mark.asyncio
async def test_browse_git_missing_dir(client, tmp_path):
    data = (await client.get("/api/browse/git", params={"path": str(tmp_path / "nope")})).json()
    assert data["git"] is False
    assert data["dirty"] is None


@pytest.mark.asyncio
async def test_browse_git_command_failure_yields_null_dirty(client, tmp_path, monkeypatch):
    d = _mk_git_dir(tmp_path, "repo", "ref: refs/heads/main\n")
    monkeypatch.setattr(
        server_module.subprocess, "run",
        lambda argv, **kw: subprocess.CompletedProcess(argv, 128, stdout="", stderr="fatal"),
    )
    data = (await client.get("/api/browse/git", params={"path": str(d)})).json()
    assert data["dirty"] is None
    assert data["changed"] is None


@pytest.mark.asyncio
async def test_browse_git_missing_binary_yields_null_dirty(client, tmp_path, monkeypatch):
    d = _mk_git_dir(tmp_path, "repo", "ref: refs/heads/main\n")

    def no_git(argv, **kw):
        raise OSError("git not found")

    monkeypatch.setattr(server_module.subprocess, "run", no_git)
    data = (await client.get("/api/browse/git", params={"path": str(d)})).json()
    assert data["dirty"] is None
