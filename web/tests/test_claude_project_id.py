"""A working dir with a space or a dot must resolve to Claude Code's real folder.

Owner, 2026-11-22: a session in "C:/Code/Personal/project NC" showed "No messages
yet." on the phone while its terminal was full. Studio derived
"C--Code-Personal-project NC"; Claude Code writes "C--Code-Personal-project-NC".
"""
import os
import re
from pathlib import Path
from types import SimpleNamespace

import agent_api
from jsonl_watcher import claude_project_id

WEB = Path(__file__).resolve().parent.parent


def test_space_and_dot_become_dashes():
    assert claude_project_id(r"C:\Code\Personal\project NC") == "C--Code-Personal-project-NC"
    assert claude_project_id(r"C:\Code\CarrotExpress\.claude\worktrees\x") == \
        "C--Code-CarrotExpress--claude-worktrees-x"


def test_plain_path_is_unchanged_from_the_old_rule():
    assert claude_project_id(r"C:\Code\Personal\plexar-studio") == "C--Code-Personal-plexar-studio"
    assert claude_project_id("C:/Code/Personal/plexar-studio") == "C--Code-Personal-plexar-studio"


def test_a_consumer_resolves_the_spaced_folder():
    s = SimpleNamespace(working_dir=r"C:\Code\Personal\project NC")
    assert os.path.basename(agent_api._transcript_dir(s)) == "C--Code-Personal-project-NC"


def test_no_product_module_re_derives_the_rule_by_hand():
    # Five copies of the separator-only rule is how one bug reached five features.
    shape = re.compile(r'\.replace\(":", ?"-"\)')
    offenders = [p.name for p in WEB.glob("*.py") if shape.search(p.read_text(encoding="utf-8"))]
    assert offenders == []
