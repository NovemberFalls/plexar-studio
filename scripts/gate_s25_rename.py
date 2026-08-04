#!/usr/bin/env python3
"""S25 gate — the product is called Plexar Studio, and the rename did not touch identifiers.

TWO ARMS, and the second one is the whole safety of the row.

  ARM A (Tier 1/2 done): no renderable occurrence of the bare word "Cockpit" survives
  in the frontend source. That is the rename actually happening.

  ARM B (Tier 3 NOT done): the identifier census is byte-identical to the frozen
  baseline in tier3_baseline.json. `com.claude-cockpit.app`, the `cockpit-server`
  sidecar, every `COCKPIT_*` env var and every `cockpit-*` localStorage key are
  compatibility surface with the INSTALLED copy and the updater. A rename that
  "helpfully" swept one of those would present to Len as data loss, not as a rename.
  Arm B fails the gate if the count moves in EITHER direction.

Run: python scripts/gate_s25_rename.py
Exit 0 = pass. Exit 1 = fail, with the sites printed.
"""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SKIP_DIRS = {"node_modules", ".git", "target", "dist", "build", "__pycache__",
             "releases", "downloads", "coverage"}

# The one deliberate survivor. `cockpit-blue` is a persisted theme id (Tier 3), and
# its human-facing label is a colour's proper noun, not a claim about the product's
# name. Renaming the label while the id stays would also mean Len's selected theme
# silently changes what it calls itself. Excluded ON PURPOSE, not by omission.
# The rule is about the PHRASE, not about one file: wherever "Cockpit Blue" appears
# — the definition, its doc comment, or a test asserting the rendered label — it is
# the same proper noun and it is excluded for the same reason.
ALLOWLIST_PHRASES = ("Cockpit Blue",)

FRONTEND_EXTS = (".jsx", ".js", ".html", ".css")
CENSUS_EXTS = (".jsx", ".js", ".py", ".json", ".html", ".rs", ".toml")

WORD = re.compile(r"Cockpit")
CENSUS = {
    "COCKPIT_env": re.compile(r"\bCOCKPIT_[A-Z0-9_]+"),
    "cockpit_ls": re.compile(r"[\"']cockpit-[a-zA-Z0-9._-]+[\"']"),
    "bundle_id": re.compile(r"com\.claude-cockpit\.app"),
    "sidecar": re.compile(r"cockpit-server"),
}


def walk(base, exts):
    for dp, dn, fn in os.walk(base):
        dn[:] = [d for d in dn if d not in SKIP_DIRS]
        for f in fn:
            if f.endswith(exts):
                yield os.path.join(dp, f)


def rel(p):
    return os.path.relpath(p, ROOT).replace("\\", "/")


def arm_a():
    """No bare 'Cockpit' left where a human can read it."""
    violations = []
    src = os.path.join(ROOT, "web", "frontend", "src")
    for p in walk(src, FRONTEND_EXTS):
        r = rel(p)
        with open(p, encoding="utf8", errors="replace") as fh:
            for i, line in enumerate(fh, 1):
                if any(ph in line for ph in ALLOWLIST_PHRASES):
                    continue
                for _ in WORD.finditer(line):
                    violations.append((r, i, line.strip()[:120]))
    return violations


def arm_b():
    """The identifier census has not moved."""
    with open(os.path.join(HERE, "tier3_baseline.json"), encoding="utf8") as fh:
        base = json.load(fh)
    counts = {k: 0 for k in CENSUS}
    for p in walk(os.path.join(ROOT, "web"), CENSUS_EXTS):
        text = open(p, encoding="utf8", errors="replace").read()
        for k, rx in CENSUS.items():
            counts[k] += len(rx.findall(text))
    drift = []
    for k in CENSUS:
        if counts[k] != base[k]:
            drift.append((k, base[k], counts[k]))
    return counts, drift


def main():
    va = arm_a()
    counts, drift = arm_b()

    print("S25 GATE")
    print("  ARM A  renderable 'Cockpit' remaining : %d (expect 0)" % len(va))
    print("  ARM B  Tier-3 identifier census       : %s" % counts)
    if drift:
        for k, exp, got in drift:
            print("    DRIFT %s expected %d got %d" % (k, exp, got))

    if va:
        print("\n  ARM A sites:")
        for r, i, line in va[:60]:
            print("    %s:%d  %s" % (r, i, line))
        if len(va) > 60:
            print("    ... and %d more" % (len(va) - 60))

    ok = not va and not drift
    print("\nS25 GATE: %s" % ("PASS" if ok else "FAIL"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
