/**
 * HarnessView — a pane for a Plexar Harness session.
 *
 * Structurally separate from TerminalPane/xterm: there is no PTY and no
 * ANSI stream here, just JSON frames over /ws/harness. See the pinned API
 * contract in the task brief for exact shapes; this file is the sole
 * consumer, so the frame/payload field names below (`text`, `id`,
 * `used_tokens`, `context_window`, `config_id`/`options`/`value` on a
 * config_options entry) are this component's own convention, not something
 * read off a shipped backend.
 *
 * ONE WEBSOCKET PER WORKSPACE, REFCOUNTED. Every open pane for the same
 * workspace shares a single `/ws/harness?workspace=` connection via the
 * module-level `registry` below; each pane's hook filters incoming frames
 * by `session_id`. The socket closes only when the last subscriber for that
 * workspace unmounts.
 */
import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Loader, Send, Square, TriangleAlert, X } from "lucide-react";
import HarnessApprovalDialog from "./HarnessApprovalDialog";

// ── shared WS registry, keyed by workspace ──────────────────────────────
const registry = new Map(); // workspace -> { ws, listeners: Set<fn>, statusListeners: Set<fn>, status }

function wsUrlFor(workspace) {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/ws/harness?workspace=${encodeURIComponent(workspace)}`;
}

function connect(workspace, entry) {
  let ws;
  try {
    ws = new WebSocket(wsUrlFor(workspace));
  } catch {
    entry.status = "error";
    entry.statusListeners.forEach((fn) => fn(entry.status));
    return;
  }
  entry.ws = ws;
  entry.status = "connecting";
  ws.onopen = () => {
    entry.status = "open";
    entry.statusListeners.forEach((fn) => fn(entry.status));
  };
  ws.onmessage = (ev) => {
    let frame;
    try {
      frame = JSON.parse(ev.data);
    } catch {
      return;
    }
    entry.listeners.forEach((fn) => fn(frame));
  };
  ws.onclose = () => {
    entry.status = "closed";
    entry.statusListeners.forEach((fn) => fn(entry.status));
  };
  ws.onerror = () => {
    entry.status = "error";
    entry.statusListeners.forEach((fn) => fn(entry.status));
  };
}

function subscribeHarness(workspace, onFrame, onStatus) {
  let entry = registry.get(workspace);
  if (!entry) {
    entry = { ws: null, listeners: new Set(), statusListeners: new Set(), status: "connecting" };
    registry.set(workspace, entry);
    connect(workspace, entry);
  }
  entry.listeners.add(onFrame);
  entry.statusListeners.add(onStatus);
  onStatus(entry.status);
  return () => {
    entry.listeners.delete(onFrame);
    entry.statusListeners.delete(onStatus);
    if (entry.listeners.size === 0) {
      try {
        entry.ws?.close();
      } catch {
        // best-effort
      }
      registry.delete(workspace);
    }
  };
}

// ── friendly runtime-error copy, keyed by reason ────────────────────────
const REASON_MESSAGES = {
  node_too_old: "Plexar Harness needs Node 22.19 or newer.",
  key_missing: "Add your Plexar Harness key in Settings.",
  key_rejected: "The rig rejected your Plexar Harness key.",
  rig_unreachable: "The rig didn't answer. Check your connection and try again.",
  profile_install_failed: "Couldn't set up the harness profile.",
};

function friendlyError(reason, message) {
  return REASON_MESSAGES[reason] || message || "Something went wrong.";
}

function ToolCard({ call }) {
  return (
    <div
      data-testid={`tool-card-${call.id}`}
      style={{
        border: "1px solid var(--cc-border)",
        borderRadius: 8,
        padding: "8px 10px",
        margin: "6px 0",
        background: "var(--cc-elev)",
        fontSize: 12,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, fontWeight: 600 }}>
        <span>{call.name}</span>
        <span style={{ fontSize: 10, color: "var(--cc-muted)", textTransform: "uppercase" }}>
          {call.status || "pending"}
        </span>
      </div>
      {call.args != null && (
        <pre style={{ margin: "4px 0 0", fontSize: 10, whiteSpace: "pre-wrap", color: "var(--cc-dim)" }}>
          {typeof call.args === "string" ? call.args : JSON.stringify(call.args)}
        </pre>
      )}
      {call.output != null && (
        <pre style={{ margin: "4px 0 0", fontSize: 10, whiteSpace: "pre-wrap", color: "var(--cc-fg)" }}>
          {typeof call.output === "string" ? call.output : JSON.stringify(call.output)}
        </pre>
      )}
    </div>
  );
}

export default function HarnessView({ session, onClose, toast, onOpenSettings }) {
  const workspace = session.workdir;
  const sessionId = session.harnessSessionId;

  const [answerText, setAnswerText] = useState("");
  const [thoughtText, setThoughtText] = useState("");
  const [thoughtOpen, setThoughtOpen] = useState(false);
  const [toolCalls, setToolCalls] = useState([]); // [{id, name, status, args, output}]
  const [usage, setUsage] = useState(null); // {used_tokens, context_window}
  const [busy, setBusy] = useState(false);
  // A session that failed to start carries its reason from createSession, so the
  // pane says what is wrong on first render rather than showing an empty transcript.
  const [errorBanner, setErrorBanner] = useState(session.startError || null);
  const startFailed = session.status === "error";
  // The pane mounts while the start request is still in flight, so a failure lands
  // AFTER first render; adopt it when it arrives or the pane stays blank (2.1.39 QA).
  useEffect(() => {
    if (session.startError) setErrorBanner(session.startError);
  }, [session.startError]);
  const [pendingPermissions, setPendingPermissions] = useState([]);
  const [wsStatus, setWsStatus] = useState("connecting");
  const [configOptions, setConfigOptions] = useState(session.harnessConfigOptions || []);
  const [prompt, setPrompt] = useState("");

  useEffect(() => {
    setConfigOptions(session.harnessConfigOptions || []);
  }, [session.harnessConfigOptions]);

  const handleFrame = useCallback(
    (frame) => {
      if (!frame || frame.session_id !== sessionId) return;
      if (frame.type === "update") {
        const payload = frame.payload || {};
        switch (frame.kind) {
          case "agent_message_chunk":
            setAnswerText((prev) => prev + (payload.text || ""));
            break;
          case "agent_thought_chunk":
            setThoughtText((prev) => prev + (payload.text || ""));
            break;
          case "tool_call":
          case "tool_call_update":
            setToolCalls((prev) => {
              const idx = prev.findIndex((c) => c.id === payload.id);
              if (idx === -1) return [...prev, payload];
              const next = [...prev];
              next[idx] = { ...next[idx], ...payload };
              return next;
            });
            break;
          case "usage_update":
            setUsage(payload);
            break;
          case "config_option_update":
            // Same full-configOptions shape as a set_config reply -- redraw
            // from it, never from separately cached data (effort is per-model).
            if (Array.isArray(payload.configOptions) && payload.configOptions.length > 0) {
              setConfigOptions(payload.configOptions);
            }
            break;
          default:
            // unknown kinds are ignored silently, per contract
            break;
        }
      } else if (frame.type === "permission") {
        setPendingPermissions((prev) => [...prev, frame]);
      } else if (frame.type === "turn_end") {
        setBusy(false);
        if (frame.error) {
          setErrorBanner({ reason: null, message: frame.error });
        }
      } else if (frame.type === "runtime_error") {
        setBusy(false);
        setErrorBanner({ reason: frame.reason, message: frame.message });
      }
    },
    [sessionId]
  );

  useEffect(() => {
    if (!workspace) return undefined;
    return subscribeHarness(workspace, handleFrame, setWsStatus);
  }, [workspace, handleFrame]);

  const sendPrompt = useCallback(async () => {
    const text = prompt.trim();
    if (!text || busy || !sessionId) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/harness/sessions/${sessionId}/prompt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (res.status === 409) {
        setBusy(true); // a turn is already in flight server-side
        toast?.("Plexar Harness session is busy", "error");
        return;
      }
      if (!res.ok) {
        setBusy(false);
        const data = await res.json().catch(() => ({}));
        toast?.(data.error || "Failed to send prompt", "error");
        return;
      }
      setPrompt("");
    } catch {
      setBusy(false);
      toast?.("Failed to send prompt", "error");
    }
  }, [prompt, busy, sessionId, toast]);

  const cancelTurn = useCallback(async () => {
    if (!sessionId) return;
    try {
      await fetch(`/api/harness/sessions/${sessionId}/cancel`, { method: "POST" });
    } catch {
      toast?.("Failed to cancel", "error");
    }
  }, [sessionId, toast]);

  const changeConfig = useCallback(
    async (configId, value) => {
      if (!sessionId) return;
      // Optimistic local update so the changed control reflects the pick
      // immediately; then redraw from the REPLY's full configOptions (never
      // from separately cached data) since effort is per-model and a model
      // change can add/drop/replace the whole reasoning_effort entry.
      setConfigOptions((prev) =>
        prev.map((c) => (c.id === configId ? { ...c, currentValue: value } : c))
      );
      try {
        const res = await fetch(`/api/harness/sessions/${sessionId}/config`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ config_id: configId, value }),
        });
        if (res.ok) {
          const data = await res.json().catch(() => null);
          if (data && Array.isArray(data.configOptions) && data.configOptions.length > 0) {
            setConfigOptions(data.configOptions);
          }
        }
      } catch {
        toast?.("Failed to update config", "error");
      }
    },
    [sessionId, toast]
  );

  const resolvePermission = useCallback(
    async (requestId, optionId) => {
      try {
        await fetch(`/api/harness/permissions/${requestId}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ option_id: optionId }),
        });
      } catch {
        toast?.("Failed to answer permission request", "error");
      } finally {
        setPendingPermissions((prev) => prev.filter((p) => p.request_id !== requestId));
      }
    },
    [toast]
  );

  // configOptions is the RAW wire shape (see harness_manager.py's docstring
  // for the fixture): {id, name, category, type, currentValue, options}. The
  // "model" entry's `options` may be GROUPED ({group, name, options: [...]})
  // while others (e.g. "reasoning_effort") are flat {value, name} leaves.
  // Flatten either shape to {id, label} so both render the same way.
  const flattenLeaves = (entry) => {
    // `value: ""` ("Provider default") is a REAL value -- checked with
    // `!= null`, never truthiness, or it silently vanishes from the list.
    const leaves = [];
    for (const opt of entry?.options || []) {
      if (opt && Array.isArray(opt.options)) {
        for (const leaf of opt.options) {
          if (leaf && leaf.value != null) leaves.push({ id: leaf.value, label: leaf.name || leaf.value || "Provider default" });
        }
      } else if (opt && opt.value != null) {
        leaves.push({ id: opt.value, label: opt.name || opt.value || "Provider default" });
      }
    }
    return leaves;
  };

  const modelEntry = configOptions.find((c) => c.id === "model");
  const effortEntry = configOptions.find((c) => c.id === "reasoning_effort");
  const otherEntries = configOptions.filter((c) => c.id !== "model" && c.id !== "reasoning_effort");
  const modelLeaves = modelEntry ? flattenLeaves(modelEntry) : [];
  const effortLeaves = effortEntry ? flattenLeaves(effortEntry) : [];

  const usagePercent =
    usage && usage.context_window ? Math.round((usage.used_tokens / usage.context_window) * 100) : null;

  return (
    <div
      data-testid="harness-view"
      className="flex flex-col h-full"
      style={{ background: "var(--cc-bg)", overflow: "hidden" }}
    >
      {/* header */}
      <div
        className="flex items-center gap-2"
        style={{ padding: "6px 10px", borderBottom: "1px solid var(--cc-border)", flexShrink: 0 }}
      >
        <span style={{ fontSize: 12, fontWeight: 700, flex: 1, minWidth: 0 }} className="truncate">
          {session.name}
        </span>
        {modelEntry && (
          <select
            key={modelEntry.id}
            aria-label={modelEntry.name || modelEntry.id}
            data-testid={`harness-config-${modelEntry.id}`}
            value={modelEntry.currentValue || ""}
            onChange={(e) => changeConfig(modelEntry.id, e.target.value)}
            style={{ fontSize: 11, background: "var(--cc-elev)", border: "1px solid var(--cc-border)", borderRadius: 6 }}
          >
            {modelLeaves.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        )}
        {/* `effortEntry` absent from configOptions altogether = genuinely
            unknown/unobserved for this model ("effort set after start").
            `effortEntry` present but its `options` empty = OBSERVED: this
            model declares no reasoning support at all, so no control and no
            label either. The two must render distinctly, never collapsed. */}
        {effortEntry ? (
          effortLeaves.length > 0 && (
            <select
              key={effortEntry.id}
              aria-label={effortEntry.name || effortEntry.id}
              data-testid={`harness-config-${effortEntry.id}`}
              value={effortEntry.currentValue || ""}
              onChange={(e) => changeConfig(effortEntry.id, e.target.value)}
              style={{ fontSize: 11, background: "var(--cc-elev)", border: "1px solid var(--cc-border)", borderRadius: 6 }}
            >
              {effortLeaves.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          )
        ) : (
          <span style={{ fontSize: 10, color: "var(--cc-muted)" }}>effort set after start</span>
        )}
        {otherEntries.map((c) => (
          <select
            key={c.id}
            aria-label={c.name || c.id}
            data-testid={`harness-config-${c.id}`}
            value={c.currentValue || ""}
            onChange={(e) => changeConfig(c.id, e.target.value)}
            style={{ fontSize: 11, background: "var(--cc-elev)", border: "1px solid var(--cc-border)", borderRadius: 6 }}
          >
            {flattenLeaves(c).map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        ))}
        {usagePercent != null && (
          <span data-testid="harness-usage-meter" title="Context usage" style={{ fontSize: 10, color: "var(--cc-muted)" }}>
            {usagePercent}% context
          </span>
        )}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="hover-bg-surface"
          style={{ background: "none", border: "none", color: "var(--cc-muted)", cursor: "pointer" }}
        >
          <X size={14} />
        </button>
      </div>

      {wsStatus === "closed" && (
        <div role="note" style={{ fontSize: 10, color: "var(--cc-muted)", padding: "2px 10px" }}>
          Reconnecting…
        </div>
      )}

      {errorBanner && (
        <div
          role="alert"
          data-testid="harness-error-banner"
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "8px 10px",
            background: "color-mix(in srgb, var(--cc-error) 10%, transparent)",
            border: "1px solid var(--cc-error)",
            margin: "6px 10px",
            borderRadius: 8,
            fontSize: 12,
            color: "var(--cc-error)",
          }}
        >
          <TriangleAlert size={14} style={{ flexShrink: 0 }} />
          <span style={{ flex: 1 }}>{friendlyError(errorBanner.reason, errorBanner.message)}</span>
          {errorBanner.reason === "key_missing" || errorBanner.reason === "key_rejected" ? (
            onOpenSettings && (
              <button
                type="button"
                onClick={onOpenSettings}
                className="hover-bg-surface"
                style={{ background: "none", border: "1px solid var(--cc-error)", borderRadius: 6, color: "inherit", cursor: "pointer", padding: "2px 8px", fontSize: 12 }}
              >
                Open Settings
              </button>
            )
          ) : null}
          <button
            type="button"
            aria-label="Dismiss error"
            onClick={() => setErrorBanner(null)}
            className="hover-bg-surface"
            style={{ background: "none", border: "none", color: "inherit", cursor: "pointer" }}
          >
            <X size={12} />
          </button>
        </div>
      )}

      {/* body */}
      <div className="flex-1" style={{ overflowY: "auto", padding: 10, minHeight: 0 }}>
        {thoughtText && (
          <div style={{ marginBottom: 8 }}>
            <button
              type="button"
              onClick={() => setThoughtOpen((v) => !v)}
              aria-expanded={thoughtOpen}
              data-testid="harness-thought-toggle"
              className="flex items-center gap-1 hover-bg-surface"
              style={{ background: "none", border: "none", color: "var(--cc-muted)", fontSize: 11, cursor: "pointer" }}
            >
              {thoughtOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              Thinking
            </button>
            {thoughtOpen && (
              <pre data-testid="harness-thought-text" style={{ fontSize: 11, whiteSpace: "pre-wrap", color: "var(--cc-dim)" }}>
                {thoughtText}
              </pre>
            )}
          </div>
        )}

        {toolCalls.map((c) => (
          <ToolCard key={c.id} call={c} />
        ))}

        {answerText && (
          <div data-testid="harness-answer-text" style={{ fontSize: 13, whiteSpace: "pre-wrap", color: "var(--cc-fg)" }}>
            {answerText}
          </div>
        )}
      </div>

      {/* composer */}
      <div
        className="flex items-center gap-2"
        style={{ padding: 10, borderTop: "1px solid var(--cc-border)", flexShrink: 0 }}
      >
        <input
          type="text"
          aria-label="Message"
          value={prompt}
          disabled={busy || startFailed}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              sendPrompt();
            }
          }}
          style={{
            flex: 1,
            height: 30,
            padding: "0 8px",
            fontSize: 12,
            background: "var(--cc-elev)",
            border: "1px solid var(--cc-border)",
            borderRadius: 6,
            color: "var(--cc-fg)",
          }}
        />
        <button
          type="button"
          onClick={sendPrompt}
          disabled={busy || startFailed}
          aria-label="Send"
          className="hover-bg-surface"
          style={{
            height: 30,
            padding: "0 10px",
            borderRadius: 6,
            background: "var(--cc-accent)",
            border: "none",
            color: "#0f1216",
            cursor: busy ? "not-allowed" : "pointer",
            opacity: busy ? 0.6 : 1,
          }}
        >
          {busy ? <Loader size={12} className="animate-spin" /> : <Send size={12} />}
        </button>
        <button
          type="button"
          onClick={cancelTurn}
          disabled={!busy}
          aria-label="Stop"
          className="hover-bg-surface"
          style={{
            height: 30,
            padding: "0 10px",
            borderRadius: 6,
            background: "none",
            border: "1px solid var(--cc-border)",
            color: "var(--cc-fg)",
            cursor: busy ? "pointer" : "not-allowed",
            opacity: busy ? 1 : 0.5,
          }}
        >
          <Square size={12} />
        </button>
      </div>

      {pendingPermissions.length > 0 && (
        <HarnessApprovalDialog
          request={pendingPermissions[0]}
          onResolve={(optionId) => resolvePermission(pendingPermissions[0].request_id, optionId)}
        />
      )}
    </div>
  );
}
