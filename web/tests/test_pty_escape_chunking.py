"""Regression tests for escape-safe PTY chunking.

Background: bridge messages arrived at the peer session mangled — one message
showing up as several partial submissions with duplicated fragments. The cause
was ``write_pty_async`` slicing every payload over 200 bytes at blind byte
offsets, so a boundary could land *inside* the bracketed-paste markers
(``\\x1b[200~`` / ``\\x1b[201~``). A split marker means the receiving TUI never
enters paste mode, so each embedded newline submits on its own.

These tests pin the two properties that fix it: ordinary payloads are written
in one call, and any boundary above the ceiling never bisects an escape.
"""

from __future__ import annotations

import re
import sys
import os

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from pty_manager import (  # noqa: E402
    _split_preserving_escapes,
    _SINGLE_WRITE_MAX,
    _CHUNK_SIZE,
)

_BP_START = "\x1b[200~"
_BP_END = "\x1b[201~"

# Matches a complete CSI sequence: ESC [ <params> <final byte 0x40-0x7E>.
_CSI = re.compile(r"\x1b\[[0-9;]*[\x40-\x7e]")


def _boundaries(chunks: list[str]) -> set[int]:
    """Absolute offsets at which *chunks* were cut."""
    out: set[int] = set()
    pos = 0
    for c in chunks:
        pos += len(c)
        out.add(pos)
    return out


def _assert_no_escape_bisected(data: str, chunks: list[str]) -> None:
    assert "".join(chunks) == data, "chunking must be lossless"
    assert all(len(c) > 0 for c in chunks), "no empty chunks"
    bounds = _boundaries(chunks)
    for m in _CSI.finditer(data):
        start, end = m.span()
        bisecting = [b for b in bounds if start < b < end]
        assert not bisecting, (
            f"boundary {bisecting} bisects escape at {start}:{end} "
            f"({data[start:end]!r})"
        )


def test_bridge_sized_payload_keeps_its_markers_intact_while_chunked():
    """A bridge message IS chunked — and its markers still survive.

    This test previously asserted the opposite (that such a message goes out as
    one uncut write, because the ceiling was 64 KB). That was the wrong fix for
    the bridge bug: dropping the cut also dropped the pacing ConPTY needs, and
    multi-KB pastes started arriving with their heads missing.

    Escape-safe boundaries — not the absence of boundaries — are what keep the
    markers whole, so the pacing can stay.
    """
    message = _BP_START + ("word " * 200) + _BP_END
    chunks = _split_preserving_escapes(message, _CHUNK_SIZE)

    assert len(chunks) > 1, "a message this size must be paced, not sent in one burst"
    _assert_no_escape_bisected(message, chunks)
    assert chunks[0].startswith(_BP_START), "the start marker must survive whole"
    assert chunks[-1].endswith(_BP_END), "the end marker must survive whole"


def test_boundary_landing_inside_paste_end_marker_rewinds():
    """A cut that would fall inside \\x1b[201~ moves back before the ESC."""
    body = "A" * 4093
    data = _BP_START + body + _BP_END + "tail"
    marker_start = data.index(_BP_END)

    # Chunk sizes that would otherwise cut into the 6-byte end marker.
    for size in range(marker_start + 1, marker_start + len(_BP_END)):
        chunks = _split_preserving_escapes(data, size)
        _assert_no_escape_bisected(data, chunks)


def test_no_escape_bisected_across_many_chunk_sizes():
    """Exhaustive sweep — no chunk size at or above the marker length splits one."""
    data = _BP_START + ("line of text\n" * 400) + _BP_END + "trailing"
    for size in range(len(_BP_START), 600):
        _assert_no_escape_bisected(data, _split_preserving_escapes(data, size))


def test_csi_introducer_is_not_mistaken_for_a_terminator():
    """``[`` is 0x5B, inside the 0x40-0x7E final-byte range.

    Treating it as a terminator would make every CSI sequence look complete the
    instant its ``[`` arrived, so a boundary at ESC-[-2 would not rewind. This
    is a real bug that existed in the first version of the splitter.
    """
    data = "x" * 10 + _BP_END + "y" * 10
    esc = data.index(_BP_END)
    # Cut exactly two bytes in — right after the "[" introducer.
    chunks = _split_preserving_escapes(data, esc + 2)
    assert chunks[0] == data[:esc], "must rewind to before the ESC, not mid-sequence"
    _assert_no_escape_bisected(data, chunks)


def test_plain_text_splits_at_the_requested_size():
    """No escapes present → boundaries are exactly where asked (no drift)."""
    data = "z" * 10_000
    chunks = _split_preserving_escapes(data, _CHUNK_SIZE)
    assert "".join(chunks) == data
    # Every chunk but the last is exactly the requested size — no drift.
    assert all(len(c) == _CHUNK_SIZE for c in chunks[:-1])
    assert len(chunks[-1]) == 10_000 % _CHUNK_SIZE or len(chunks[-1]) == _CHUNK_SIZE


def test_lone_esc_cannot_rewind_arbitrarily_far():
    """A stray ESC in ordinary text must not collapse a chunk to nothing.

    The backtrack window is bounded, so a never-terminated ESC far from the
    boundary is ignored rather than dragging the split back to it.
    """
    data = "\x1b" + "q" * 500
    chunks = _split_preserving_escapes(data, 400)
    assert all(len(c) > 0 for c in chunks)
    assert "".join(chunks) == data


def test_empty_and_degenerate_inputs():
    assert _split_preserving_escapes("", _CHUNK_SIZE) == []
    with pytest.raises(ValueError):
        _split_preserving_escapes("abc", 0)
