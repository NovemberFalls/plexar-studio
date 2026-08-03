import React, { useEffect, useState, useCallback } from "react";

/**
 * Ask, once per conversation, where this chat's work happens.
 *
 * Len, asked directly whether the root is per-conversation or global:
 * **"per convo."**
 *
 * ── THE FOUR RULES THIS COMPONENT EXISTS TO KEEP ───────────────────────────
 *
 * 1. NO SILENT DEFAULT. The default location is DISPLAYED, always, fetched from
 *    `/api/chat/root/default` rather than written here — one resolver owns
 *    where data lives and a literal in a dialog would be a second owner. A
 *    prompt that can be dismissed into an unstated location is a silent default
 *    with a dialog in front of it, and this program measured what that costs: a
 *    4,096-byte database appearing in the rig's directory in forty seconds.
 *
 * 2. ASKED ONCE, AND EVERY EXIT IS AN ANSWER. There is no backdrop-dismiss and
 *    no bare close button, because a dismissal that records nothing means the
 *    same question returns next time — and a question asked repeatedly gets
 *    answered carelessly. Closing the window without answering leaves
 *    `root_choice` NULL, which is honestly "never asked" and asks again; that
 *    is the ONE path that does not record, and it is the one where the user
 *    never saw an answer either.
 *
 * 3. A SAVE THAT FAILS IS SAID OUT LOUD AND THE DIALOG STAYS OPEN. This write
 *    decides where a person's transcripts live. The rig found a one-shot copy
 *    control today with no feedback, whose visible symptom was "it doesn't turn
 *    green" and whose real cost was a credential lost forever. `onSave` is
 *    awaited, its failure is rendered, and the dialog never closes on a write
 *    that did not land.
 *
 * 4. AN INVALID ROOT IS REFUSED AT THE CONTROL. The Save button is disabled
 *    until the server has validated the typed path, and the reason is shown.
 *    A form that prints its own rule and still lets you submit the violation is
 *    worse than one that never mentioned the rule.
 */
export default function ChatRootPrompt({ conversationTitle, onChoose, onCancel }) {
  const [defaultPath, setDefaultPath] = useState(null);
  const [custom, setCustom] = useState("");
  // The verdict carries the EXACT input it was computed for. Without that, a
  // verdict from a previous keystroke keeps the Save button enabled while the
  // user edits the path underneath it -- validating one string and saving
  // another. Caught by the react-hooks lint rule that objected to a synchronous
  // setState here, which turned out to be pointing at a real defect and not
  // just a style violation.
  const [verdict, setVerdict] = useState(null);   // {ok, resolved, error, forValue} | null
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);

  useEffect(() => {
    let live = true;
    fetch("/api/chat/root/default")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status))))
      .then((d) => { if (live) setDefaultPath(d.path); })
      // The location must never be blank. If we cannot state it, we say so
      // rather than showing an empty space that reads as "nowhere".
      .catch(() => { if (live) setDefaultPath(""); });
    return () => { live = false; };
  }, []);

  // Validate on the server, not with a regex here: "is this writable" is not a
  // question the browser can answer, and guessing it would be the decorative
  // rule this component exists to avoid.
  useEffect(() => {
    const value = custom.trim();
    if (!value) return undefined;
    let live = true;
    const t = setTimeout(() => {
      fetch("/api/chat/root/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ root: value }),
      })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status))))
        .then((d) => { if (live) setVerdict({ ...d, forValue: value }); })
        .catch(() => {
          if (live) {
            setVerdict({ ok: false, error: "Could not check that folder.", forValue: value });
          }
        });
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [custom]);

  const choose = useCallback(async (choice, root) => {
    setSaveError(null);
    setSaving(true);
    try {
      // AWAITED. An unawaited promise here is how a failed write becomes a
      // closed dialog and a location the user believes they chose.
      await onChoose(choice, root);
    } catch (err) {
      setSaveError(err?.message || "Could not save that. Nothing was changed.");
      setSaving(false);
      return;                      // stays open, deliberately
    }
    setSaving(false);
  }, [onChoose]);

  // FRESH verdict only. `forValue` must match what is in the box right now.
  const fresh = verdict && verdict.forValue === custom.trim() ? verdict : null;
  const customUsable = Boolean(fresh?.ok) && !saving;

  return (
    <div style={S.backdrop} data-testid="chat-root-prompt">
      <div style={S.panel} role="dialog" aria-modal="true" aria-label="Where should this chat work?">
        <div style={S.title}>Where should this chat work?</div>
        <div style={S.body}>
          Files this chat reads and writes live here, and so does its transcript.
          {conversationTitle ? <> This is for <b>{conversationTitle}</b>.</> : null}
        </div>

        <div style={S.optionLabel}>Default folder</div>
        <div style={S.pathBox} data-testid="chat-root-default-path">
          {defaultPath === null
            ? "Reading…"
            : defaultPath || "Could not read the default location."}
        </div>

        <div style={S.optionLabel}>Or use a specific folder</div>
        <input
          style={S.input}
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          placeholder="C:\\Users\\you\\projects\\my-project"
          aria-label="Custom folder"
          data-testid="chat-root-input"
          disabled={saving}
        />
        {fresh && !fresh.ok ? (
          <div style={S.error} data-testid="chat-root-validation-error">{fresh.error}</div>
        ) : null}

        {saveError ? (
          <div style={S.error} data-testid="chat-root-save-error">{saveError}</div>
        ) : null}

        <div style={S.row}>
          <button
            style={S.secondary}
            disabled={saving}
            onClick={() => choose("declined", null)}
            data-testid="chat-root-decline"
          >
            {/* Names the consequence rather than being a bare "Cancel": a
                button whose effect the user cannot predict is a dismissal. */}
            Don&apos;t ask again — use the default
          </button>
          <div style={{ flex: 1 }} />
          <button
            style={S.secondary}
            disabled={saving}
            onClick={() => choose("default", null)}
            data-testid="chat-root-use-default"
          >
            Use the default
          </button>
          <button
            style={{ ...S.primary, opacity: customUsable ? 1 : 0.45 }}
            disabled={!customUsable}
            onClick={() => choose("custom", fresh.resolved)}
            data-testid="chat-root-save-custom"
          >
            {saving ? "Saving…" : "Use this folder"}
          </button>
        </div>
        {onCancel ? (
          <button style={S.later} onClick={onCancel} data-testid="chat-root-later">
            Ask me later
          </button>
        ) : null}
      </div>
    </div>
  );
}

const S = {
  backdrop: {
    position: "absolute", inset: 0, background: "rgba(0,0,0,0.55)",
    display: "flex", alignItems: "center", justifyContent: "center", zIndex: 40,
  },
  panel: {
    width: 460, maxWidth: "90%", background: "var(--cc-surface)",
    border: "1px solid var(--cc-border)", borderRadius: 10, padding: 18,
    display: "flex", flexDirection: "column", gap: 8,
  },
  title: { fontSize: 14, fontWeight: 600, color: "var(--cc-fg)" },
  body: { fontSize: 12, color: "var(--cc-muted)", lineHeight: 1.5 },
  optionLabel: {
    fontSize: 9.5, letterSpacing: ".09em", textTransform: "uppercase",
    color: "var(--cc-muted)", marginTop: 6,
  },
  pathBox: {
    fontFamily: "'JetBrains Mono', monospace", fontSize: 11,
    color: "var(--cc-dim)", background: "var(--cc-bg2)",
    border: "1px solid var(--cc-border)", borderRadius: 6, padding: "7px 9px",
    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
  },
  input: {
    fontFamily: "'JetBrains Mono', monospace", fontSize: 11,
    color: "var(--cc-fg)", background: "var(--cc-bg2)",
    border: "1px solid var(--cc-border)", borderRadius: 6, padding: "7px 9px",
  },
  error: { fontSize: 11, color: "var(--cc-error)", lineHeight: 1.4 },
  row: { display: "flex", alignItems: "center", gap: 8, marginTop: 12 },
  secondary: {
    fontSize: 11, padding: "6px 10px", borderRadius: 6, cursor: "pointer",
    background: "transparent", color: "var(--cc-muted)",
    border: "1px solid var(--cc-border)",
  },
  primary: {
    fontSize: 11, padding: "6px 12px", borderRadius: 6, cursor: "pointer",
    background: "var(--cc-accent)", color: "#0b0b0b", border: "none",
  },
  later: {
    marginTop: 4, fontSize: 10.5, background: "none", border: "none",
    color: "var(--cc-muted)", cursor: "pointer", alignSelf: "flex-start",
    padding: 0, textDecoration: "underline",
  },
};
