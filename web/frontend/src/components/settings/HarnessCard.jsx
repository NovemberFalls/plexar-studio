/**
 * HarnessCard — the Plexar Harness key, permission mode and rig URL.
 *
 * Lives on Settings > Keys & secrets (it used to sit on Settings > Remote, where
 * it did not belong: a harness key is a credential, not a remote-access setting).
 * Behaviour is unchanged from when it lived there.
 */
import { useEffect, useState } from "react";
import { Bot, KeyRound, TriangleAlert } from "lucide-react";

const ACCENT_FG = "#0f1216";
const tint = (token, pct) => `color-mix(in srgb, ${token} ${pct}%, transparent)`;

const CARD = {
  borderRadius: 12,
  background: "var(--cc-surface)",
  border: "1px solid var(--cc-border)",
  padding: 16,
};

const LABEL = {
  fontSize: 10,
  fontWeight: 800,
  textTransform: "uppercase",
  letterSpacing: ".08em",
  color: "var(--cc-muted)",
};

const MONO = "var(--font-mono, monospace)";

const FIELD_GRID = {
  display: "grid",
  gridTemplateColumns: "200px 1fr 108px",
  gap: 8,
  alignItems: "center",
  padding: "6px 0",
};

function CardHeader({ icon: Icon, token, name, children }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        flexWrap: "wrap",
        paddingBottom: 10,
        marginBottom: 4,
        borderBottom: "1px solid var(--cc-line)",
      }}
    >
      {Icon && (
        <span
          aria-hidden="true"
          style={{
            width: 22,
            height: 22,
            borderRadius: 7,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            color: token,
            background: tint(token, 8),
            border: `1px solid ${tint(token, 30)}`,
            flexShrink: 0,
          }}
        >
          <Icon size={12} />
        </span>
      )}
      <span style={{ fontSize: 13, fontWeight: 700, color: "var(--cc-fg)" }}>{name}</span>
      {children}
    </div>
  );
}

function Callout({ token = "var(--cc-waiting)", icon: Icon = TriangleAlert, children, testId, alert }) {
  return (
    <div
      data-testid={testId}
      role={alert ? "alert" : "note"}
      style={{
        display: "flex",
        gap: 8,
        alignItems: "flex-start",
        marginTop: 10,
        padding: "8px 10px",
        borderRadius: 9,
        fontSize: 11,
        lineHeight: 1.5,
        color: token,
        background: tint(token, 8),
        border: `1px solid ${tint(token, 35)}`,
      }}
    >
      <Icon size={13} style={{ flexShrink: 0, marginTop: 1 }} />
      <span>{children}</span>
    </div>
  );
}

function ActionButton({ label, onClick, disabled, title, accent, testId, icon: Icon, danger }) {
  return (
    <button
      type="button"
      data-testid={testId}
      onClick={onClick}
      disabled={disabled}
      title={title || label}
      aria-label={label}
      className="rounded transition-colors hover-bg-elevated"
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        height: 26,
        padding: "0 12px",
        fontSize: 11,
        fontWeight: 600,
        borderRadius: 7,
        background: accent && !disabled ? "var(--cc-accent)" : "var(--cc-elev)",
        color: accent && !disabled ? ACCENT_FG : danger ? "var(--cc-error)" : "var(--cc-fg)",
        border: `1px solid ${accent && !disabled ? "transparent" : "var(--cc-border)"}`,
        opacity: disabled ? 0.5 : 1,
        cursor: disabled ? "not-allowed" : "pointer",
      }}
    >
      {Icon && <Icon size={12} aria-hidden="true" />}
      {label}
    </button>
  );
}

const HARNESS_PERMISSION_MODES = [
  { id: "read-only", label: "Read-only" },
  { id: "workspace-write", label: "Workspace write" },
];

/**
 * Plexar Harness card — Settings ▸ Keys & secrets.
 *
 * The key field follows KeysSettings' NO DRAFT STATE / MASKING IS ABSOLUTE
 * contract: PUT /api/harness/key writes through immediately, the key is never
 * echoed back, and a successful save clears the field and shows only
 * confirmation text. The permission-mode select is an ordinary settings field
 * (`harness.permission_mode`) through the normal useSettings get/setField/save
 * draft flow — it is NOT a live API call like the key.
 */
export default function HarnessCard({ get, setField }) {
  // Same fallback as harness_manager.permission_mode() and DEFAULT_SETTINGS, so the
  // picker never shows a mode the backend is not actually using.
  const permissionModeDraft = get("harness.permission_mode", "workspace-write") || "workspace-write";
  const rigUrlDraft = get("harness.rig_url", "") || "";

  const [status, setStatus] = useState(null);
  const [statusError, setStatusError] = useState(null);
  const [keyDraft, setKeyDraft] = useState("");
  const [keyBusy, setKeyBusy] = useState(false);
  const [keyError, setKeyError] = useState(null);
  const [keySaved, setKeySaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/harness/status")
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error("bad status"))))
      .then((data) => {
        if (!cancelled) setStatus(data);
      })
      .catch(() => {
        if (!cancelled) setStatusError("Could not load Plexar Harness status");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const saveKey = async () => {
    const key = keyDraft.trim();
    if (!key) return;
    setKeyBusy(true);
    setKeyError(null);
    try {
      const res = await fetch("/api/harness/key", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setKeyError(data?.error || "Could not save the key");
        return;
      }
      setKeyDraft("");
      setKeySaved(true);
      setStatus((prev) => (prev ? { ...prev, key_set: true, key_source: "settings" } : prev));
    } catch {
      setKeyError("Could not save the key");
    } finally {
      setKeyBusy(false);
    }
  };

  const clearKey = async () => {
    setKeyBusy(true);
    setKeyError(null);
    try {
      const res = await fetch("/api/harness/key", { method: "DELETE" });
      if (!res.ok) {
        setKeyError("Could not clear the key");
        return;
      }
      const data = await res.json().catch(() => ({}));
      setKeyDraft("");
      setKeySaved(false);
      // A key can remain in the environment after the saved one is cleared.
      setStatus((prev) => (prev ? { ...prev, key_set: !!data.key_set, key_source: data.key_source ?? null } : prev));
    } catch {
      setKeyError("Could not clear the key");
    } finally {
      setKeyBusy(false);
    }
  };

  return (
    <div style={CARD} data-testid="card-harness">
      <CardHeader icon={Bot} token="var(--cc-accent)" name="Plexar Harness" />

      {statusError && (
        <Callout token="var(--cc-error)" testId="harness-status-error" alert>
          {statusError}
        </Callout>
      )}
      {status && (
        <div data-testid="harness-status" style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: 11, color: "var(--cc-dim)", marginBottom: 10 }}>
          <span>Launcher: {status.launcher || "not found"}</span>
          <span>Node: {status.node_version || "unknown"} {status.node_ok ? "(ok)" : "(too old)"}</span>
        </div>
      )}

      <div style={FIELD_GRID}>
        <span style={LABEL}>Key</span>
        <input
          type="password"
          data-testid="harness-key-input"
          aria-label="Plexar Harness key"
          placeholder="plx_…"
          value={keyDraft}
          disabled={keyBusy}
          onChange={(e) => {
            setKeyDraft(e.target.value);
            setKeySaved(false);
          }}
          style={{
            height: 30,
            padding: "0 9px",
            borderRadius: 8,
            background: "var(--cc-elev)",
            border: "1px solid var(--cc-border)",
            color: "var(--cc-fg)",
            fontFamily: MONO,
            fontSize: 12,
          }}
        />
        <div className="flex items-center gap-2">
          <ActionButton label="Save" accent testId="harness-key-save" onClick={saveKey} disabled={keyBusy || !keyDraft.trim()} />
          <ActionButton label="Clear" testId="harness-key-clear" onClick={clearKey} disabled={keyBusy || status?.key_source !== "settings"} icon={KeyRound} />
        </div>
      </div>
      {status?.key_source === "environment" && !keySaved && (
        <Callout token="var(--cc-idle)" testId="harness-key-env">
          Using PLEXAR_HARNESS_KEY from your environment. Save a key here to override it.
        </Callout>
      )}
      {status?.key_source === "settings" && !keySaved && (
        <Callout token="var(--cc-idle)" testId="harness-key-settings">
          A key is saved in Studio.
        </Callout>
      )}
      {keySaved && (
        <Callout token="var(--cc-idle)" testId="harness-key-saved">
          Key saved.
        </Callout>
      )}
      {keyError && (
        <Callout token="var(--cc-error)" testId="harness-key-error" alert>
          {keyError}
        </Callout>
      )}

      <div style={{ ...FIELD_GRID, gridTemplateColumns: "200px 1fr" }}>
        <span style={LABEL}>Permission mode</span>
        <select
          aria-label="Plexar Harness permission mode"
          data-testid="harness-permission-mode"
          value={permissionModeDraft}
          onChange={(e) => setField("harness.permission_mode", e.target.value)}
          style={{
            height: 30,
            padding: "0 9px",
            borderRadius: 8,
            background: "var(--cc-elev)",
            border: "1px solid var(--cc-border)",
            color: "var(--cc-fg)",
            fontSize: 12,
          }}
        >
          {HARNESS_PERMISSION_MODES.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
      </div>

      <div style={{ ...FIELD_GRID, gridTemplateColumns: "200px 1fr" }}>
        <span style={LABEL}>Rig URL</span>
        <input
          type="text"
          data-testid="harness-rig-url"
          aria-label="Plexar Harness rig URL"
          placeholder="defaults to the configured Plexar provider address"
          value={rigUrlDraft}
          onChange={(e) => setField("harness.rig_url", e.target.value)}
          style={{
            height: 30,
            padding: "0 9px",
            borderRadius: 8,
            background: "var(--cc-elev)",
            border: "1px solid var(--cc-border)",
            color: "var(--cc-fg)",
            fontFamily: MONO,
            fontSize: 12,
          }}
        />
      </div>
      <div style={{ fontSize: 11, color: "var(--cc-dim)", marginTop: -6, marginBottom: 4 }}>
        Leave blank to use the configured Plexar provider address (Settings ▸ Providers), or the
        harness's own built-in default if that is not set either.
      </div>
    </div>
  );
}
