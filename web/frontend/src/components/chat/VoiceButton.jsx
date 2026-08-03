/**
 * VoiceButton — the Mic control in the composer bottom bar.
 *
 * DECISION (do not "fix" this into a recorder without reading this first):
 * `voice_service.py` on THIS machine reports `available:false` /
 * `not_installed` today, and even where `available:true`, Chat has no
 * capture/playback pipeline wired to it yet — no microphone stream, no VAD
 * loop, nothing that would turn a click into a recording. Rendering an
 * enabled mic that "starts listening" and does nothing is a FAKE RECORDER:
 * worse than an absent button, because the user believes they were heard.
 * So this button is ALWAYS rendered disabled-with-reason, for every value of
 * `available` — never natively `disabled` (that would swallow the click),
 * but `aria-disabled` + inert styling, so a click still opens the note that
 * explains why. When wiring a real capture pipeline lands, THIS is the
 * component to change, and the comment should move with it.
 *
 * Fetched ONCE on mount — CLAUDE.md is explicit that `/api/voice/status` is
 * capability, not live state, and this file must not add a poller.
 */

import { useEffect, useState } from "react";
import { Mic } from "lucide-react";

const MONO = "'JetBrains Mono', ui-monospace, monospace";

// The four reasons voice_service.py separates. Each implies a DIFFERENT
// remedy — collapsing them into "voice unavailable" sends the user to fix
// the wrong thing. Keep this map in sync with voice_service.REASON_*.
const REASON_LABEL = {
  not_installed: "Not installed",
  model_missing: "Model not downloaded",
  unsupported: "Not supported in this build",
  check_failed: "Could not check",
};

/** Packages missing per-component, read straight off the server's own
 *  envelope — never a hard-coded list of what Cockpit thinks is missing. */
function missingPackagesByComponent(components) {
  const out = [];
  for (const [name, c] of Object.entries(components || {})) {
    if (c?.reason !== "not_installed") continue;
    const missing = Object.entries(c.packages || {})
      .filter(([, present]) => present === false)
      .map(([pkg]) => pkg);
    if (missing.length) out.push(`${name}: ${missing.join(", ")}`);
  }
  return out;
}

export default function VoiceButton() {
  // null while the one-shot fetch is in flight.
  const [status, setStatus] = useState(null);
  const [noteOpen, setNoteOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/voice/status")
      .then((r) => r.json())
      .then((body) => { if (!cancelled) setStatus(body); })
      .catch(() => {
        // The fetch itself failing is its own "could not check" — reuse the
        // server's own vocabulary rather than inventing a fifth reason.
        if (!cancelled) {
          setStatus({
            available: false, reason: "check_failed",
            detail: "Could not reach the server to check voice availability.",
            components: {},
          });
        }
      });
    return () => { cancelled = true; };
  }, []);

  const reason = status && !status.available ? status.reason : null;
  const reasonLabel = reason ? (REASON_LABEL[reason] || reason) : null;

  const title = status == null
    ? "Checking voice availability…"
    : status.available
      ? "Voice components are installed, but recording is not wired into Chat yet."
      : `Voice unavailable — ${reasonLabel}`;

  return (
    <div style={{ position: "relative" }}>
      <button className="hover-bg-elevated"
        type="button"
        aria-disabled="true"
        aria-label="Voice input"
        title={title}
        onClick={() => status && setNoteOpen((v) => !v)}
        style={{
          display: "flex", alignItems: "center", justifyContent: "center",
          padding: 4, border: "none", background: "transparent",
          color: "var(--cc-muted)", opacity: 0.55, cursor: "default",
        }}
      >
        <Mic size={13} />
      </button>
      {noteOpen && status && (
        <div
          role="note"
          aria-label="Voice availability"
          style={{
            position: "absolute", bottom: 30, left: 0, width: 260, zIndex: 20,
            padding: "9px 11px", borderRadius: 8, fontSize: 11, lineHeight: 1.55,
            background: "var(--cc-elev)", border: "1px solid var(--cc-border)",
            color: "var(--cc-dim)",
          }}
        >
          {status.available ? (
            <p style={{ margin: 0 }}>
              Speech-to-text, voice activity detection and text-to-speech are
              installed on this machine, but Chat does not have a capture
              pipeline wired to them yet.
            </p>
          ) : (
            <>
              <div style={{ fontFamily: MONO, fontSize: 9.5, letterSpacing: ".08em",
                            textTransform: "uppercase", color: "var(--cc-fg)",
                            marginBottom: 4 }}>
                {reasonLabel}
              </div>
              {/* Rendered verbatim from the server — never re-worded here. */}
              <p style={{ margin: "0 0 6px" }}>{status.detail}</p>
              {reason === "not_installed" && (
                <>
                  {missingPackagesByComponent(status.components).map((line) => (
                    <p key={line} style={{ margin: "0 0 2px", fontFamily: MONO, fontSize: 10 }}>
                      {line}
                    </p>
                  ))}
                  <p style={{ margin: "6px 0 0", color: "var(--cc-muted)" }}>
                    These are large ML dependencies (speech models), so
                    installing them is a deliberate choice, not something
                    Cockpit does automatically.
                  </p>
                </>
              )}
            </>
          )}
          <button className="hover-bg-elevated"
            type="button"
            onClick={() => setNoteOpen(false)}
            aria-label="Close"
            style={{ marginTop: 6, border: "none", background: "transparent",
                     color: "var(--cc-muted)", cursor: "pointer", fontSize: 10,
                     padding: 0 }}
          >
            Close
          </button>
        </div>
      )}
    </div>
  );
}
