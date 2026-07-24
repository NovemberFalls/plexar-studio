"""Vendored lane-broker — single-flight priority gateway for local model servers.

Upstream: C:/Code/Personal/team/tools/lane-broker (broker-team repo). Vendored
into Cockpit 2026-07-24 so Cockpit OWNS the broker lifecycle: bundled in the
sidecar, spawned in-process at startup (see server.py managed-broker section),
no external repo path or Startup-folder launcher required. Keep broker.py
byte-close to upstream — sync changes both ways via the broker team.
"""
