"""Tests for the vLLM models-directory config + on-disk discovery merge.

Covers:
  1. GET/PUT /api/local/vllm-local/models-dir happy path + persistence.
  2. PUT validation: relative path, non-existent path, a file (not dir), NUL
     byte, over-length path -> 400.
  3. PUT on lmstudio-local -> 404/409 (vLLM-local-only).
  4. _scan_vllm_models_dir finds subdirs, maps id -> "/models/<name>",
     host_path stays the host path, quantization sniffing.
  5. Merged GET /models: served model marked loaded, disk-only entries marked
     available, no duplicate ids.
  6. vLLM unreachable but dir scannable -> 200 with disk entries.
  7. Neither reachable nor scannable -> 503.
"""
from __future__ import annotations

import os
import sys

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
    return AsyncClient(transport=transport, base_url="http://test")


@pytest.fixture(autouse=True)
def _clean_models_dir_state(monkeypatch, tmp_path):
    # Isolate from a developer's real ~/.claude-cockpit and reset the module-
    # level mutables between tests.
    monkeypatch.setattr(server_module, "_vllm_models_dir", "")
    monkeypatch.setattr(server_module, "_vllm_models_dir_mount", "")
    monkeypatch.setattr(server_module, "_vllm_models_dir_raw", "")
    monkeypatch.setattr(
        server_module, "_VLLM_MODELS_DIR_FILE", str(tmp_path / "vllm-models-dir.json")
    )
    yield


# ── GET/PUT models-dir ─────────────────────────────────────


@pytest.mark.asyncio
async def test_models_dir_get_default_empty(client):
    res = await client.get("/api/local/vllm-local/models-dir")
    assert res.status_code == 200
    assert res.json() == {
        "path": "", "mount_path": "", "scan_path": "", "exists": False,
        "writable_config": True, "current_model": server_module._vllm_runtime_model,
    }


@pytest.mark.asyncio
async def test_models_dir_put_happy_path_and_persistence(client, tmp_path):
    target = tmp_path / "models"
    target.mkdir()
    res = await client.put("/api/local/vllm-local/models-dir", json={"path": str(target)})
    assert res.status_code == 200
    body = res.json()
    assert body["exists"] is True
    assert body["path"] == str(target)
    assert os.path.samefile(body["scan_path"], target)
    assert server_module._vllm_models_dir == body["scan_path"]
    assert server_module._vllm_models_dir_raw == str(target)
    assert body["current_model"] == server_module._vllm_runtime_model

    # Persisted to disk (raw as typed).
    with open(server_module._VLLM_MODELS_DIR_FILE, "r", encoding="utf-8") as f:
        import json
        saved = json.load(f)
    assert saved["path"] == str(target)

    # GET reflects the persisted value.
    res2 = await client.get("/api/local/vllm-local/models-dir")
    assert res2.json()["exists"] is True


@pytest.mark.asyncio
async def test_models_dir_put_rejects_relative_path(client):
    res = await client.put("/api/local/vllm-local/models-dir", json={"path": "relative/dir"})
    assert res.status_code == 400


@pytest.mark.asyncio
async def test_models_dir_put_rejects_nonexistent_path(client, tmp_path):
    missing = tmp_path / "does-not-exist"
    res = await client.put("/api/local/vllm-local/models-dir", json={"path": str(missing)})
    assert res.status_code == 400


@pytest.mark.asyncio
async def test_models_dir_put_rejects_file_not_dir(client, tmp_path):
    f = tmp_path / "some-file.txt"
    f.write_text("hi")
    res = await client.put("/api/local/vllm-local/models-dir", json={"path": str(f)})
    assert res.status_code == 400


@pytest.mark.asyncio
async def test_models_dir_put_rejects_nul_byte(client):
    res = await client.put("/api/local/vllm-local/models-dir", json={"path": "C:\\foo\x00bar"})
    assert res.status_code == 400


@pytest.mark.asyncio
async def test_models_dir_put_rejects_overlong_path(client):
    huge = "C:\\" + ("a" * 5000)
    res = await client.put("/api/local/vllm-local/models-dir", json={"path": huge})
    assert res.status_code == 400


@pytest.mark.asyncio
async def test_models_dir_put_rejects_on_lmstudio(client, tmp_path):
    res = await client.put("/api/local/lmstudio-local/models-dir", json={"path": str(tmp_path)})
    assert res.status_code == 409


@pytest.mark.asyncio
async def test_models_dir_get_rejects_on_lmstudio(client):
    res = await client.get("/api/local/lmstudio-local/models-dir")
    assert res.status_code == 404


@pytest.mark.asyncio
async def test_models_dir_unknown_provider_404(client, tmp_path):
    res = await client.put("/api/local/nope/models-dir", json={"path": str(tmp_path)})
    assert res.status_code == 404


# ── _scan_vllm_models_dir ───────────────────────────────────


def test_scan_finds_config_json_subdirs(monkeypatch, tmp_path):
    m1 = tmp_path / "Qwen3-Coder-30B-AWQ"
    m1.mkdir()
    (m1 / "config.json").write_text("{}")
    m2 = tmp_path / "Llama-3-GPTQ-int4"
    m2.mkdir()
    (m2 / "config.json").write_text("{}")
    (tmp_path / "not-a-model.txt").write_text("nope")  # ignored -- not a dir

    monkeypatch.setattr(server_module, "_vllm_models_dir", str(tmp_path))
    entries = server_module._scan_vllm_models_dir()

    ids = {e["id"] for e in entries}
    assert ids == {"/models/Qwen3-Coder-30B-AWQ", "/models/Llama-3-GPTQ-int4"}
    for e in entries:
        assert e["state"] == "available"
        assert e["host_path"].endswith(e["name"])
        assert os.path.isabs(e["host_path"])
        assert e["container_path"] == e["id"]


def test_scan_quantization_sniffing(monkeypatch, tmp_path):
    names = {
        "model-awq": "awq",
        "model-GPTQ": "gptq",
        "model-int4": "int4",
        "model-fp8": "fp8",
        "model-q4": "q4",
        "plain-model": None,
    }
    for name in names:
        (tmp_path / name).mkdir()

    monkeypatch.setattr(server_module, "_vllm_models_dir", str(tmp_path))
    entries = {e["name"]: e for e in server_module._scan_vllm_models_dir()}
    for name, expected in names.items():
        assert entries[name]["quantization"] == expected


def test_scan_empty_when_dir_unset(monkeypatch):
    monkeypatch.setattr(server_module, "_vllm_models_dir", "")
    assert server_module._scan_vllm_models_dir() == []


def test_scan_returns_empty_never_raises_on_missing_dir(monkeypatch, tmp_path):
    monkeypatch.setattr(server_module, "_vllm_models_dir", str(tmp_path / "gone"))
    assert server_module._scan_vllm_models_dir() == []


# ── Merged /models response ────────────────────────────────


@pytest.mark.asyncio
async def test_merged_models_marks_served_loaded_and_disk_available(client, monkeypatch, tmp_path):
    served_dir = tmp_path / "qwen3-coder-30b-awq"
    served_dir.mkdir()
    other_dir = tmp_path / "llama-3-gptq"
    other_dir.mkdir()
    monkeypatch.setattr(server_module, "_vllm_models_dir", str(tmp_path))

    def fake_mgmt_get(provider, path):
        return {"data": [{"id": "qwen3-coder-30b-awq", "state": "loaded"}]}

    monkeypatch.setattr(server_module, "_mgmt_get", fake_mgmt_get)

    res = await client.get("/api/local/vllm-local/models")
    assert res.status_code == 200
    body = res.json()
    assert body["reachable"] is True

    by_id = {m["id"]: m for m in body["models"]}
    assert set(by_id) == {"qwen3-coder-30b-awq", "/models/llama-3-gptq"}
    assert by_id["qwen3-coder-30b-awq"]["state"] == "loaded"
    assert by_id["/models/llama-3-gptq"]["state"] == "available"
    assert len(body["models"]) == len(set(by_id))  # no duplicate ids


@pytest.mark.asyncio
async def test_unreachable_vllm_but_scannable_dir_returns_200(client, monkeypatch, tmp_path):
    d = tmp_path / "some-model"
    d.mkdir()
    monkeypatch.setattr(server_module, "_vllm_models_dir", str(tmp_path))

    def fake_mgmt_get(provider, path):
        raise OSError("connection refused")

    monkeypatch.setattr(server_module, "_mgmt_get", fake_mgmt_get)

    res = await client.get("/api/local/vllm-local/models")
    assert res.status_code == 200
    body = res.json()
    assert body["reachable"] is False
    assert body["reason"] == "server_offline_disk_only"
    assert [m["id"] for m in body["models"]] == ["/models/some-model"]


@pytest.mark.asyncio
async def test_unreachable_vllm_and_no_dir_returns_503(client, monkeypatch):
    monkeypatch.setattr(server_module, "_vllm_models_dir", "")

    def fake_mgmt_get(provider, path):
        raise OSError("connection refused")

    monkeypatch.setattr(server_module, "_mgmt_get", fake_mgmt_get)

    res = await client.get("/api/local/vllm-local/models")
    assert res.status_code == 503
    assert res.json() == {"reachable": False, "reason": "unreachable"}


# ── vLLM ground-truth /v1/models normalization (Bug 1) ─────


@pytest.mark.asyncio
async def test_vllm_ground_truth_payload_normalized(client, monkeypatch):
    """Exact shape captured live from vLLM's /v1/models (see task brief)."""
    def fake_mgmt_get(provider, path):
        return {"object": "list", "data": [{
            "id": "qwen3-30b-instruct", "object": "model", "created": 1785370694,
            "owned_by": "vllm", "root": "/models/Qwen3-30B-A3B-Instruct-2507-AWQ",
            "parent": None, "max_model_len": 32768, "permission": [],
        }]}

    monkeypatch.setattr(server_module, "_mgmt_get", fake_mgmt_get)
    res = await client.get("/api/local/vllm-local/models")
    assert res.status_code == 200
    body = res.json()
    assert body["reachable"] is True
    m = body["models"][0]
    assert m["id"] == "qwen3-30b-instruct"
    assert m["state"] == "loaded"
    assert m["max_context_length"] == 32768
    assert m["loaded_context_length"] == 32768
    assert m["container_path"] == "/models/Qwen3-30B-A3B-Instruct-2507-AWQ"
    assert m["quantization"] == "awq"
    assert m["arch"] is None


@pytest.mark.asyncio
async def test_lmstudio_state_not_overwritten(client, monkeypatch):
    """A real LM Studio 'not-loaded' state must survive untouched -- the
    vLLM normalization path must never run for lmstudio-kind providers."""
    def fake_mgmt_get(provider, path):
        return {"data": [{"id": "some-model", "state": "not-loaded"}]}

    monkeypatch.setattr(server_module, "_mgmt_get", fake_mgmt_get)
    res = await client.get("/api/local/lmstudio-local/models")
    assert res.status_code == 200
    body = res.json()
    assert body["models"][0]["state"] == "not-loaded"
    assert body["models"][0]["container_path"] is None


# ── Windows+WSL models-dir mount/scan derivation (Bug 2) ────


@pytest.mark.asyncio
async def test_windows_wsl_style_input_derives_unc_scan_and_keeps_mount(client, monkeypatch, tmp_path):
    monkeypatch.setattr(server_module.sys, "platform", "win32")
    monkeypatch.setattr(server_module, "_WSL_DISTRO_CACHE", {})

    # Fake distro detection.
    monkeypatch.setattr(server_module, "_detect_wsl_distro", lambda: "Ubuntu")

    expected_scan = tmp_path  # pretend the UNC form resolves here
    monkeypatch.setattr(
        server_module, "_derive_models_dir_paths",
        lambda raw: ("/home/lenbo/models", str(expected_scan)),
    )

    res = await client.put("/api/local/vllm-local/models-dir", json={"path": "/home/lenbo/models"})
    assert res.status_code == 200
    body = res.json()
    assert body["path"] == "/home/lenbo/models"
    assert body["mount_path"] == "/home/lenbo/models"
    assert os.path.samefile(body["scan_path"], expected_scan)

    # Docker argv uses the MOUNT path, never the scan path.
    argv = server_module._vllm_docker_argv("run")
    joined = " ".join(argv)
    assert "-v /home/lenbo/models:/models" in joined
    assert str(expected_scan) not in joined


@pytest.mark.asyncio
async def test_windows_style_input_derives_mnt_mount(client, monkeypatch, tmp_path):
    monkeypatch.setattr(server_module.sys, "platform", "win32")
    target = tmp_path / "models"
    target.mkdir()

    res = await client.put("/api/local/vllm-local/models-dir", json={"path": str(target)})
    assert res.status_code == 200
    body = res.json()
    drive = str(target)[0].lower()
    assert body["mount_path"].startswith(f"/mnt/{drive}/")
    assert os.path.samefile(body["scan_path"], target)


def test_wsl_distro_detection_failure_accepted_not_rejected(monkeypatch):
    monkeypatch.setattr(server_module.sys, "platform", "win32")
    monkeypatch.setattr(server_module, "_WSL_DISTRO_CACHE", {})
    monkeypatch.setattr(server_module, "_detect_wsl_distro", lambda: None)

    ok, error, mount_path, scan_path = server_module._validate_models_dir("/home/lenbo/models")
    assert ok is True
    assert error is None
    assert mount_path == "/home/lenbo/models"
    assert scan_path == ""


def test_posix_platform_mount_equals_scan(monkeypatch, tmp_path):
    monkeypatch.setattr(server_module.sys, "platform", "linux")
    ok, error, mount_path, scan_path = server_module._validate_models_dir(str(tmp_path))
    assert ok is True
    assert mount_path == scan_path
    assert os.path.samefile(mount_path, tmp_path)


def test_wsl_distro_detection_parses_and_caches(monkeypatch):
    monkeypatch.setattr(server_module, "_WSL_DISTRO_CACHE", {})
    calls = {"n": 0}

    class _FakeResult:
        stdout = "Ubuntu\r\n".encode("utf-16-le")

    def fake_run(*args, **kwargs):
        calls["n"] += 1
        return _FakeResult()

    monkeypatch.setattr(server_module.subprocess, "run", fake_run)
    assert server_module._detect_wsl_distro() == "Ubuntu"
    assert server_module._detect_wsl_distro() == "Ubuntu"
    assert calls["n"] == 1  # cached after first call
