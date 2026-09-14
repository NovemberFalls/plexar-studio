import json

from codex_transcript import transcript_page


def test_native_messages_paginate_without_response_or_tool_duplicates(tmp_path):
    path = tmp_path / "rollout.jsonl"
    rows = [
        {"type": "event_msg", "payload": {"type": "user_message", "message": "first question"}},
        {"type": "response_item", "payload": {"type": "message", "message": "duplicate question"}},
        {"type": "event_msg", "payload": {"type": "agent_message", "message": "first answer"}},
        {"type": "event_msg", "payload": {"type": "user_message", "message": "follow-up"}},
    ]
    path.write_text("\n".join(map(json.dumps, rows)) + "\n", encoding="utf-8")
    page = transcript_page(path, limit=2)
    assert [m["text"] for m in page["messages"]] == ["first answer", "follow-up"]
    assert page["has_more"] is True
    older = transcript_page(path, before=page["before"], limit=2)
    assert [m["text"] for m in older["messages"]] == ["first question"]
    assert older["has_more"] is False


def test_missing_is_unavailable_and_partial_append_is_not_corrupt_message(tmp_path):
    path = tmp_path / "rollout.jsonl"
    assert transcript_page(path)["available"] is False
    path.write_text('{"type":"event_msg","payload":', encoding="utf-8")
    assert transcript_page(path)["messages"] == []


def test_actual_cli_response_message_schema_excludes_developer_and_duplicate_events(tmp_path):
    path = tmp_path / "native.jsonl"
    rows = [
        {"type": "response_item", "payload": {"type": "message", "role": "developer",
            "content": [{"type": "input_text", "text": "internal setup"}]}},
        {"type": "response_item", "payload": {"type": "message", "role": "user",
            "content": [{"type": "input_text", "text": "question"}]}},
        {"type": "event_msg", "payload": {"type": "user_message", "message": "question"}},
        {"type": "response_item", "payload": {"type": "message", "role": "assistant",
            "content": [{"type": "output_text", "text": "answer"}]}},
    ]
    path.write_text("\n".join(map(json.dumps, rows)) + "\n", encoding="utf-8")
    page = transcript_page(path, limit=1)
    assert [m["text"] for m in page["messages"]] == ["answer"]
    older = transcript_page(path, before=page["before"], limit=1)
    assert [m["text"] for m in older["messages"]] == ["question"]
    assert older["has_more"] is False


def _native(text):
    return json.dumps({"type": "response_item", "payload": {"type": "message", "role": "user",
                       "content": [{"type": "input_text", "text": text}]}}).encode() + b"\n"


def test_append_partial_and_native_replaces_legacy_even_on_old_page(tmp_path):
    path = tmp_path / "append.jsonl"
    legacy = b'{"type":"event_msg","payload":{"type":"user_message","message":"legacy"}}\n'
    path.write_bytes(legacy)
    assert transcript_page(path)["messages"][0]["text"] == "legacy"
    native = _native("native")
    with path.open("ab") as stream:
        stream.write(native[:-1])
    assert transcript_page(path)["messages"][0]["text"] == "legacy"
    with path.open("ab") as stream:
        stream.write(b"\n")
    assert transcript_page(path)["messages"][0]["text"] == "native"
    assert transcript_page(path, before=len(legacy))["messages"] == []


def test_truncation_and_replacement_invalidate_index(tmp_path):
    path = tmp_path / "replace.jsonl"
    path.write_bytes(_native("older long text") * 3)
    assert len(transcript_page(path)["messages"]) == 3
    path.write_bytes(_native("short"))
    assert [m["text"] for m in transcript_page(path)["messages"]] == ["short"]
    replacement = tmp_path / "replacement"
    replacement.write_bytes(_native("other"))
    replacement.replace(path)
    assert [m["text"] for m in transcript_page(path)["messages"]] == ["other"]
    # Truncate and regrow between requests can retain the inode and exceed its old size.
    path.write_bytes(_native("rebuilt") * 4)
    assert [m["text"] for m in transcript_page(path)["messages"]] == ["rebuilt"] * 4


def test_bounded_index_deep_history_and_lru(tmp_path, monkeypatch):
    import codex_transcript as module
    monkeypatch.setattr(module, "_MAX_OFFSETS", 3)
    monkeypatch.setattr(module, "_MAX_FILES", 2)
    module._CACHE.clear()
    path = tmp_path / "deep.jsonl"
    path.write_bytes(b"".join(_native(str(n)) for n in range(8)))
    page = transcript_page(path, limit=2)
    texts = []
    while True:
        texts = [m["text"] for m in page["messages"]] + texts
        if not page["has_more"]:
            break
        page = transcript_page(path, before=page["before"], limit=2)
    assert texts == list(map(str, range(8)))
    for n in range(3):
        other = tmp_path / str(n)
        other.write_bytes(_native("x"))
        transcript_page(other)
    assert len(module._CACHE) == 2
    assert all(len(item["offsets"]) <= 3 for item in module._CACHE.values())
    module._CACHE.clear()


def test_warm_pages_do_not_parse_tool_records(tmp_path, monkeypatch):
    import codex_transcript as module
    path = tmp_path / "large.jsonl"
    tool = json.dumps({"type": "response_item", "payload": {"type": "function_call_output",
                      "output": "x" * 1000000}}).encode() + b"\n"
    path.write_bytes(_native("first") + tool * 10 + _native("last"))
    assert transcript_page(path, limit=1)["messages"][0]["text"] == "last"
    original = module.json.loads
    decoded_bytes = []

    def counted(value):
        decoded_bytes.append(len(value))
        return original(value)

    monkeypatch.setattr(module.json, "loads", counted)
    latest = transcript_page(path, limit=1)
    older = transcript_page(path, before=latest["before"], limit=1)
    assert older["messages"][0]["text"] == "first"
    assert sum(decoded_bytes) < 1000


def test_malformed_oversize_and_empty_native_select_native(tmp_path):
    path = tmp_path / "malformed.jsonl"
    path.write_bytes(b"not json\n[]\n" + b"x" * (16 * 1024 * 1024 + 1) + b"\n" + _native("valid"))
    assert [m["text"] for m in transcript_page(path)["messages"]] == ["valid"]
    path.write_bytes(b'{"type":"event_msg","payload":{"type":"user_message","message":"legacy"}}\n'
                     b'{"type":"response_item","payload":{"type":"message","role":"user","content":[]}}\n')
    assert transcript_page(path)["messages"] == []


def test_concurrent_append_index_does_not_duplicate_messages(tmp_path):
    from concurrent.futures import ThreadPoolExecutor
    path = tmp_path / "threads.jsonl"
    path.write_bytes(_native("first"))
    transcript_page(path)
    with path.open("ab") as stream:
        stream.write(_native("second"))
    with ThreadPoolExecutor(max_workers=4) as pool:
        pages = list(pool.map(lambda _: transcript_page(path), range(20)))
    assert all([m["text"] for m in page["messages"]] == ["first", "second"] for page in pages)


def test_slow_cold_scan_does_not_block_another_file(tmp_path, monkeypatch):
    import threading
    from concurrent.futures import ThreadPoolExecutor
    import codex_transcript as module

    slow = tmp_path / "slow.jsonl"
    warm = tmp_path / "warm.jsonl"
    slow.write_bytes(_native("slow"))
    warm.write_bytes(_native("warm"))
    transcript_page(warm)
    entered = threading.Event()
    release = threading.Event()
    original = module._index_append

    def gated(stream, index, end):
        if str(stream.name) == str(slow):
            entered.set()
            assert release.wait(5), "test did not release the blocked file"
        return original(stream, index, end)

    monkeypatch.setattr(module, "_index_append", gated)
    with ThreadPoolExecutor(max_workers=2) as pool:
        pending = pool.submit(transcript_page, slow)
        try:
            assert entered.wait(2)
            other = pool.submit(transcript_page, warm).result(timeout=2)
            assert other["messages"][0]["text"] == "warm"
        finally:
            release.set()
        assert pending.result(timeout=2)["messages"][0]["text"] == "slow"


def _tool_rollout(path):
    msg = lambda role, text, **extra: {"type": "response_item", "payload": {"type": "message", "role": role, "content": [{"type": "output_text", "text": text}], **extra}}
    rows = [
        msg("user", "fix it"),
        {"type": "response_item", "payload": {"type": "reasoning", "encrypted_content": "x"}},
        {"type": "response_item", "payload": {"type": "custom_tool_call", "name": "exec", "call_id": "c1",
                                              "input": 'text(await tools.exec_command({cmd:"git status \\"src\\"",max_output_tokens:5}));'}},
        {"type": "response_item", "payload": {"type": "custom_tool_call_output", "call_id": "c1", "output": [
            {"type": "input_text", "text": "Script completed\nOutput:\n"},
            {"type": "input_text", "text": json.dumps({"output": "nothing to commit", "exit_code": 1})}]}},
        {"type": "response_item", "payload": {"type": "function_call", "name": "send_message", "namespace": "collaboration",
                                              "call_id": "c2", "arguments": json.dumps({"target": "/root/w1", "message": "gAAAA"})}},
        {"type": "response_item", "payload": {"type": "function_call_output", "call_id": "c2", "output": ""}},
        {"type": "response_item", "payload": {"type": "custom_tool_call_output", "call_id": "c3", "output": "y" * 20000}},
        msg("assistant", "done", phase="final_answer"),
    ]
    path.write_text("\n".join(map(json.dumps, rows)) + "\n", encoding="utf-8")


def test_full_detail_includes_tool_calls_and_output_but_default_stays_messages_only(tmp_path):
    import codex_transcript
    path = tmp_path / "rollout.jsonl"
    _tool_rollout(path)
    assert [m["role"] for m in transcript_page(path)["messages"]] == ["user", "assistant"]
    full = transcript_page(path, detail="full")["messages"]
    assert [(m["role"], m.get("kind")) for m in full] == [
        ("user", None), ("tool", "call"), ("tool", "output"), ("tool", "call"), ("tool", "output"), ("assistant", None)]
    assert full[1]["text"] == 'git status "src"' and full[1]["name"] == "exec"
    assert full[2]["text"] == "Script completed\nOutput:\nnothing to commit\n[exit code 1]"
    assert full[3]["text"] == "-> /root/w1" and "gAAAA" not in full[3]["text"]
    assert full[4]["truncated"] is True and len(full[4]["text"]) == codex_transcript._TOOL_TEXT_MAX
    assert full[5]["phase"] == "final_answer"
    older = transcript_page(path, before=full[2]["index"], limit=1, detail="full")
    assert [m["index"] for m in older["messages"]] == [full[1]["index"]] and older["has_more"] is True
    uncached = codex_transcript._uncached_page(path, None, 50, True)["messages"]
    assert uncached == full
