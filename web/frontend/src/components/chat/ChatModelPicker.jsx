/**
 * Per-conversation model picker.
 *
 * WHY THE WARNING EXISTS. A chat has no server-side memory of a previous
 * model's context: switching model means the ENTIRE conversation is re-sent to
 * the new one on the next turn. That has three consequences a user cannot
 * infer from a dropdown:
 *
 *   1. It costs — the whole history is re-read as input tokens, and any cache
 *      warmth on the old model is gone.
 *   2. A long conversation may not FIT. Models have different context windows,
 *      and moving to a smaller one can make the thread unsendable.
 *   3. The reply style changes mid-thread, which reads as the assistant losing
 *      the plot unless the user knows they caused it.
 *
 * So the change is confirmed, not silent. This is the same reasoning as the
 * destructive interlocks elsewhere in the app: the cost is invisible at the
 * moment of the click and obvious ten seconds later.
 */

import { useState } from "react";
import { ChevronDown, AlertTriangle } from "lucide-react";

import { useModelCatalog, UNSERVED_ROW_TAG } from "../../modelCatalog.js";

/** Roughly 4 chars per token — good enough to warn, never shown as a fact. */
const CHARS_PER_TOKEN = 4;

function labelFor(groups, modelId) {
  for (const g of groups) {
    const m = (g.models || []).find((x) => x.id === modelId);
    if (m) return m.label;
  }
  return modelId || "Default";
}

export default function ChatModelPicker({ model, messages, onChange, disabled }) {
  const [pending, setPending] = useState(null);
  const { groups } = useModelCatalog();

  // Approximate, and labelled as such where it is shown. A precise count would
  // need the model's own tokenizer; the point here is order of magnitude.
  const chars = (messages || []).reduce((n, m) => n + (m.content?.length || 0), 0);
  const approxTokens = Math.round(chars / CHARS_PER_TOKEN);

  const confirm = () => {
    onChange(pending);
    setPending(null);
  };

  return (
    <>
      <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
        <select
          value={model || ""}
          disabled={disabled}
          onChange={(e) => {
            const next = e.target.value;
            if (!next || next === model) return;
            // Never apply on change — confirm first.
            setPending(next);
          }}
          aria-label="Conversation model"
          style={{
            appearance: "none",
            fontSize: 10,
            fontWeight: 700,
            padding: "3px 20px 3px 8px",
            borderRadius: 6,
            border: "1px solid var(--cc-border)",
            background: "transparent",
            color: "var(--cc-dim)",
            cursor: disabled ? "default" : "pointer",
          }}
        >
          <option value="">Default model</option>
          {groups.map((g) => {
            // A group with no models but a note (e.g. a local provider that
            // does not publish a model list) is a HEALTHY state, not an
            // omission — it still renders, as a disabled, note-carrying
            // optgroup, so the provider's existence is visible.
            if ((!g.models || g.models.length === 0) && g.note) {
              return (
                <optgroup key={g.label} label={`${g.label} — ${g.note}`} disabled />
              );
            }
            if (!g.models || g.models.length === 0) return null;
            return (
              <optgroup key={g.label} label={g.note ? `${g.label} — ${g.note}` : g.label}>
                {g.models.map((m) => {
                  // A local model the engine is not currently serving is
                  // visible (it doubles as "what is on disk") but never
                  // selectable — picking it would point the session at
                  // something that fails at request time, far from the click.
                  const unselectable = m.selectable === false;
                  return (
                    <option key={m.id} value={m.id} disabled={unselectable}>
                      {unselectable ? `${m.label} · ${UNSERVED_ROW_TAG}` : m.label}
                    </option>
                  );
                })}
              </optgroup>
            );
          })}
        </select>
        <ChevronDown
          size={11}
          style={{ position: "absolute", right: 5, pointerEvents: "none", color: "var(--cc-muted)" }}
        />
      </div>

      {pending && (
        <div
          role="dialog"
          aria-label="Confirm model change"
          style={{
            position: "fixed", inset: 0, zIndex: 60, display: "flex",
            alignItems: "center", justifyContent: "center",
            background: "rgba(0,0,0,.55)",
          }}
          onClick={() => setPending(null)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              maxWidth: 460, padding: 18, borderRadius: 12,
              background: "var(--cc-surface)", border: "1px solid var(--cc-border)",
            }}
          >
            <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10 }}>
              <AlertTriangle size={15} style={{ color: "var(--cc-waiting)" }} />
              <strong style={{ fontSize: 13 }}>
                Switch to {labelFor(groups, pending)}?
              </strong>
            </div>
            <p style={{ fontSize: 11, lineHeight: 1.65, color: "var(--cc-dim)", margin: 0 }}>
              The <strong>entire conversation is re-sent</strong> to the new model on
              your next message — nothing carries over from
              {" "}{labelFor(groups, model)}. That means:
            </p>
            <ul style={{ fontSize: 11, lineHeight: 1.7, color: "var(--cc-dim)", margin: "8px 0 0", paddingLeft: 18 }}>
              <li>
                you pay to re-read this thread (~{approxTokens.toLocaleString()} tokens,
                <em> approximate</em>), and any cache warmth is lost;
              </li>
              <li>if the new model has a smaller context window, it may not fit;</li>
              <li>the reply style changes mid-thread.</li>
            </ul>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 16 }}>
              <button className="hover-bg-elevated" onClick={() => setPending(null)} style={ghost}>Cancel</button>
              <button className="hover-bg-elevated" onClick={confirm} style={primary}>Switch and re-inject</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

const ghost = {
  fontSize: 11, padding: "6px 12px", borderRadius: 7, cursor: "pointer",
  border: "1px solid var(--cc-border)", background: "transparent", color: "var(--cc-dim)",
};
const primary = {
  fontSize: 11, fontWeight: 700, padding: "6px 12px", borderRadius: 7, cursor: "pointer",
  border: "1px solid var(--cc-accent)", background: "transparent", color: "var(--cc-accent)",
};
